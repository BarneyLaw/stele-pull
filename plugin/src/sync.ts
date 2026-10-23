import { Plugin, Notice, normalizePath } from "obsidian";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Manifest, Entry, blobKey, latestKey, manifestKey, parseManifest, liveEntries } from "./types";
import { Policy } from "./policy";
import { CourseRecord, FileRecord, LocalState, saveState } from "./state";
import { RemoteStore, chunkSize, CHUNK_THRESHOLD } from "./store";
import { preview, Preview, PreviewItem, isPullable } from "./preview";
import { courseFolderName } from "./folders";

export interface SyncResult {
  added: number;
  updated: number;
  /** Files put back after being deleted from the vault. */
  restored: number;
  removed: number;
  conflicts: string[];
  skipped: number;
  errors: string[];
  /** Files already on disk with the right bytes; adopted without a download. */
  adopted: number;
}

/** Outcome of a single entry write. */
type WriteOutcome = "written" | "conflict" | "adopted";

export type PullMode = "manual" | "automatic";

export interface SyncOptions {
  /**
   * manual (default): the user pressed a pull button. Write every selected
   * item (see Syncer.isSelected), including deleted files they ticked.
   *
   * automatic: the pull on startup and on the interval. It only refreshes
   * files this vault already has that changed in Canvas, and still respects an
   * untick. It never brings in a file the user has not pulled, or has deleted.
   *
   * Both process tombstones and claim the run.
   */
  mode?: PullMode;
  /**
   * Called before each file, as each chunk of a large file lands, and once at
   * the end. Never called when the pull has nothing to write.
   */
  onProgress?: (p: SyncProgress) => void;
}

/** How far a pull has got through the files it is writing. */
export interface SyncProgress {
  /** Files finished, out of filesTotal. */
  files: number;
  filesTotal: number;
  bytes: number;
  bytesTotal: number;
  /** Manifest path of the file being pulled; absent once all are done. */
  current?: string;
}

/** A SyncProgress labelled with the course it belongs to, for the UI. */
export interface PullProgress extends SyncProgress {
  course: string;
}

export interface SyncFolders {
  targetFolder: string;
  trashFolder: string;
  conflictFolder: string;
}

/**
 * Consumer sync loop.
 *
 * Each course lives in its own folder under the target folder (courseFolderName,
 * "CS3103 [2610] (93794)"), and so do its trash and conflicts. Records are kept per
 * course, so two courses that both have "Labs/lab1.pdf" hold two files, never
 * one.
 *
 * Note this diff (manifest entry vs what I wrote locally) is a DIFFERENT
 * algorithm from the worker's diff (Canvas metadata vs previous manifest).
 * Writing one in Go and one in TypeScript is not duplication.
 */
export class Syncer {
  constructor(
    private plugin: Plugin,
    private store: RemoteStore,
    private policy: Policy,
    private state: LocalState,
    private settings: SyncFolders,
  ) {}

  async fetchManifest(courseId: number): Promise<Manifest | null> {
    // Fresh: a cached `latest` names an old run, and the panel then cannot see
    // anything the worker has published since.
    const latest = await this.store.getText(latestKey(courseId), { fresh: true });
    if (!latest) return null;
    const runId = latest.trim();
    const key = manifestKey(courseId, runId);
    const raw = await this.store.getText(key);
    if (!raw) return null;
    const m = parseManifest(raw);
    // The worker's own reader checks this too. A manifest naming another
    // course or run is a mis-served or hand-copied object, and syncing it
    // would tombstone the wrong course's files.
    if (m.course_id !== courseId || m.run_id !== runId) {
      throw new Error(`stele-pull: ${key} claims course ${m.course_id} run ${m.run_id}`);
    }
    return m;
  }

  /**
   * Put this course's files where courseFolderName says they belong. Call
   * before anything compares the vault with the manifest: an unmoved layout
   * would read as every file missing and be downloaded again.
   *
   * Both moves rename; neither downloads:
   *  - the course's folder name changed, e.g. a manifest from an older worker
   *    had no course code, so the folder was named by id alone;
   *  - files recorded by state version 1, when every course shared the target
   *    folder, move into the folder of the course whose manifest lists them.
   */
  async migrateCourse(m: Manifest): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const course = this.course(m);
    const folder = courseFolderName(m);
    let changed = false;

    if (course.folder !== folder) {
      if (course.folder !== undefined) {
        const from = this.inTarget(course.folder);
        const to = this.inTarget(folder);
        // If the new folder already exists, leave the old one alone rather
        // than merge; anything missing is simply pulled again.
        if ((await adapter.exists(from)) && !(await adapter.exists(to))) {
          await this.ensureDir(to);
          await adapter.rename(from, to);
        }
      }
      course.folder = folder;
      changed = true;
    }

    const vacated = new Set<string>();
    for (const e of liveEntries(m)) {
      const legacy = this.state.legacyFiles[e.path];
      if (e.state !== "stored" || !legacy) continue;
      delete this.state.legacyFiles[e.path];
      changed = true;
      if (course.files[e.path]) continue;

      const from = this.inTarget(e.path);
      const to = this.dest(m, e.path);
      if ((await adapter.exists(from)) && !(await adapter.exists(to))) {
        await this.ensureDir(to);
        await adapter.rename(from, to);
        vacated.add(parentOf(from));
      }
      // Keep the record even when the file is gone: missingFiles then offers it
      // again, instead of a background pull skipping a run it has already seen.
      course.files[e.path] = legacy;
    }
    await this.pruneEmptyDirs(vacated);

    if (changed) await saveState(this.plugin, this.state, this.settings);
  }

  /**
   * Stored entries this device recorded as written whose file is no longer in
   * the vault.
   *
   * The record alone is what makes preview call a file up to date. Without this
   * check, a file the user deleted stays "up to date" forever and is never
   * pulled again, and pullAll skips the course because the run has not changed.
   */
  async missingFiles(m: Manifest): Promise<Set<string>> {
    const adapter = this.plugin.app.vault.adapter;
    const files = this.course(m).files;
    const recorded = liveEntries(m).filter((e) => e.state === "stored" && files[e.path]);
    const present = await Promise.all(recorded.map((e) => adapter.exists(this.dest(m, e.path))));
    return new Set(recorded.filter((_, i) => !present[i]).map((e) => e.path));
  }

  /**
   * Whether an automatic pull has work. It only refreshes files this vault
   * already has, and only a run this device has not seen can change those.
   */
  async needsSync(m: Manifest): Promise<boolean> {
    await this.migrateCourse(m);
    return this.state.lastRunId[String(m.course_id)] !== m.run_id;
  }

  previewCourse(m: Manifest, missing: ReadonlySet<string> = new Set()): Preview {
    return preview(m, this.policy, this.course(m).files, missing);
  }

  /**
   * Whether the user wants a pullable item pulled: their own tick or untick if
   * they made one; otherwise new and changed files start ticked, and files
   * deleted from the vault start unticked, so a deletion is never undone
   * without being asked.
   */
  isSelected(m: Manifest, item: PreviewItem): boolean {
    const choice = this.course(m).choices?.[item.entry.path];
    if (choice !== undefined) return choice;
    return item.action === "download" || item.action === "update";
  }

  /** Paths of the pullable items currently selected. */
  selection(m: Manifest, p: Preview): Set<string> {
    return new Set(p.items.filter((i) => isPullable(i) && this.isSelected(m, i)).map((i) => i.entry.path));
  }

  /**
   * Record the user ticking or unticking paths. Remembered until each file is
   * pulled, so it holds across restarts and automatic pulls.
   */
  async choose(m: Manifest, paths: readonly string[], on: boolean): Promise<void> {
    const course = this.course(m);
    const choices = (course.choices ??= {});
    for (const path of paths) choices[path] = on;
    await saveState(this.plugin, this.state, this.settings);
  }

  async syncCourse(m: Manifest, opts: SyncOptions = {}): Promise<SyncResult> {
    const res: SyncResult = {
      added: 0, updated: 0, restored: 0, removed: 0, conflicts: [], skipped: 0, errors: [], adopted: 0,
    };
    const automatic = opts.mode === "automatic";
    await this.migrateCourse(m);
    const p = this.previewCourse(m, await this.missingFiles(m));
    const course = this.course(m);
    const files = course.files;

    // isPullable covers exactly download, update and restore, so everything
    // in todo is written.
    const todo = p.items.filter(
      (item) => isPullable(item) && this.isSelected(m, item) && (!automatic || item.action === "update"),
    );
    res.skipped += p.items.length - todo.length;

    const bytesTotal = todo.reduce((n, i) => n + i.entry.size, 0);
    let filesDone = 0;
    let bytesDone = 0;
    const report = (current?: string, inFile = 0) =>
      opts.onProgress?.({
        files: filesDone, filesTotal: todo.length, bytes: bytesDone + inFile, bytesTotal, current,
      });

    for (const item of todo) {
      report(item.entry.path);
      try {
        const outcome = await this.writeEntry(m, item.entry, (n) => report(item.entry.path, n));
        if (outcome === "conflict") res.conflicts.push(item.entry.path);
        else if (outcome === "adopted") res.adopted++;
        else if (item.action === "restore") res.restored++;
        else if (item.action === "download") res.added++;
        else res.updated++;
        // The tick is spent once the file is in the vault: delete it later
        // and it starts unticked again.
        if (outcome !== "conflict" && course.choices) delete course.choices[item.entry.path];
      } catch (e) {
        res.errors.push(`${item.entry.path}: ${String(e)}`);
      }
      // A failed or adopted file still counts as done, so the bar ends full.
      filesDone++;
      bytesDone += item.entry.size;
    }
    if (todo.length > 0) report();

    // Tombstones only touch files this vault has, so every pull processes them.
    for (const e of m.entries) {
      if (e.state === "deleted" && files[e.path]) {
        try {
          await this.trash(m, e.path);
          res.removed++;
        } catch (err) {
          res.errors.push(`${e.path}: ${String(err)}`);
        }
      }
    }

    // Forget ticks for files Canvas no longer offers.
    if (course.choices) {
      const live = new Set(liveEntries(m).map((e) => e.path));
      for (const path of Object.keys(course.choices)) {
        if (!live.has(path)) delete course.choices[path];
      }
    }

    // Every pull claims the run, including one that left files unticked: those
    // are meant to stay out until the user ticks them, so there is nothing left
    // for an automatic pull to finish.
    this.state.lastRunId[String(m.course_id)] = m.run_id;

    await saveState(this.plugin, this.state, this.settings);
    return res;
  }

  /** @param onBytes - bytes of this file downloaded so far, after each request. */
  private async writeEntry(m: Manifest, e: Entry, onBytes?: (n: number) => void): Promise<WriteOutcome> {
    if (!e.sha256) throw new Error("stored entry without a hash");
    const adapter = this.plugin.app.vault.adapter;
    const files = this.course(m).files;
    const dest = this.dest(m, e.path);
    const known = files[e.path];

    // One-way sync is NOT a licence to destroy local data.
    //
    // The check is on the FILE, not on whether we have a record of it. A vault
    // synced to a second device arrives with files on disk and an empty
    // data.json, so gating this on `known` would let the first sync on a new
    // device silently overwrite the user's edits.
    if (await adapter.exists(dest)) {
      const onDisk = await this.hashFile(dest, known);
      if (onDisk === e.sha256) {
        // Right bytes already there (second device, or a restored backup).
        // Adopt it instead of re-downloading.
        files[e.path] = { sha256: e.sha256, size: e.size, writtenAt: Date.now() };
        return "adopted";
      }
      if (onDisk !== known?.sha256) {
        // Either we have no record of this file, or it no longer matches what
        // we last wrote. Both mean the bytes are not ours to overwrite.
        await this.quarantine(m, dest, e.path);
        return "conflict";
      }
    }

    // Part file lives in the plugin folder and is dot-prefixed so Obsidian
    // never indexes a half-written PDF and the user never sees it flicker.
    const part = normalizePath(`${this.partsDir()}/${e.sha256}.part`);
    await this.ensureDir(part);
    if (await adapter.exists(part)) await adapter.remove(part);

    const key = blobKey(e.sha256);
    const hasher = sha256.create();

    try {
      if (e.size <= CHUNK_THRESHOLD) {
        // Plain GET: no Range arithmetic, and it is the only path that copes
        // with a zero-byte object.
        const buf = await this.store.getBinary(key);
        hasher.update(new Uint8Array(buf));
        await adapter.writeBinary(part, buf);
        onBytes?.(buf.byteLength);
      } else {
        const cs = chunkSize();
        for (let off = 0; off < e.size; off += cs) {
          const n = Math.min(cs, e.size - off);
          const buf = await this.store.getRange(key, off, n);
          hasher.update(new Uint8Array(buf));
          // appendBinary landed in Obsidian 1.12.3 and is why the mobile size
          // ceiling stopped being structural. CapacitorAdapter implements
          // DataAdapter, so this works on phones too.
          await adapter.appendBinary(part, buf);
          onBytes?.(off + n);
        }
      }

      // Verify before the rename. Costs nothing (the bytes already passed
      // through the hasher) and is the only check that the store gave us what
      // we asked for.
      const got = bytesToHex(hasher.digest());
      if (got !== e.sha256) {
        throw new Error(`hash mismatch: expected ${e.sha256.slice(0, 12)} got ${got.slice(0, 12)}`);
      }
    } catch (err) {
      // Never leave a partial file behind: it is keyed by the expected hash, so
      // a stale one would otherwise sit in .parts forever.
      if (await adapter.exists(part)) await adapter.remove(part);
      throw err;
    }

    await this.ensureDir(dest);
    if (await adapter.exists(dest)) await adapter.remove(dest);
    await adapter.rename(part, dest);
    files[e.path] = { sha256: e.sha256, size: e.size, writtenAt: Date.now() };
    return "written";
  }

  /**
   * Hash of the file on disk, with a stat fast path.
   *
   * Reading a file back costs one whole-file buffer, which is exactly what the
   * chunked download path exists to avoid. So when size and mtime still match
   * what we recorded at write time, take that as untouched rather than pulling
   * a 300 MB recording into memory on a phone every sync.
   */
  private async hashFile(path: string, known?: FileRecord): Promise<string> {
    const adapter = this.plugin.app.vault.adapter;
    if (known) {
      const st = await adapter.stat(path);
      // 5s of slack: mtime is stamped by the adapter just before writtenAt.
      if (st && st.size === known.size && st.mtime <= known.writtenAt + 5000) {
        return known.sha256;
      }
    }
    return bytesToHex(sha256(new Uint8Array(await adapter.readBinary(path))));
  }

  /** Move a locally-modified file aside rather than clobbering it. */
  private async quarantine(m: Manifest, src: string, relPath: string) {
    const adapter = this.plugin.app.vault.adapter;
    let q = normalizePath(`${this.settings.conflictFolder}/${courseFolderName(m)}/${relPath}`);
    if (await adapter.exists(q)) q = uniquify(q, Date.now());
    await this.ensureDir(q);
    await adapter.rename(src, q);
  }

  /** Never hard delete. Lecturers unpublish and republish constantly. */
  private async trash(m: Manifest, path: string) {
    const adapter = this.plugin.app.vault.adapter;
    const files = this.course(m).files;
    const src = this.dest(m, path);
    if (!(await adapter.exists(src))) {
      delete files[path];
      return;
    }
    let dst = normalizePath(`${this.settings.trashFolder}/${courseFolderName(m)}/${path}`);
    if (await adapter.exists(dst)) dst = uniquify(dst, Date.now());
    await this.ensureDir(dst);
    await adapter.rename(src, dst);
    delete files[path];
  }

  /** This course's records, created on first use. */
  private course(m: Manifest): CourseRecord {
    const id = String(m.course_id);
    const existing = this.state.courses[id];
    if (existing) return existing;
    const created: CourseRecord = { files: {} };
    this.state.courses[id] = created;
    return created;
  }

  /** Vault path of a manifest entry, inside its course's folder. */
  private dest(m: Manifest, path: string): string {
    return normalizePath(`${this.settings.targetFolder}/${courseFolderName(m)}/${path}`);
  }

  private inTarget(rel: string): string {
    return normalizePath(`${this.settings.targetFolder}/${rel}`);
  }

  /** Remove directories a migration left empty, up to but not including the target folder. */
  private async pruneEmptyDirs(dirs: Iterable<string>) {
    const adapter = this.plugin.app.vault.adapter;
    const root = normalizePath(this.settings.targetFolder);
    for (const start of dirs) {
      let dir = start;
      while (dir.startsWith(`${root}/`)) {
        const listed = await adapter.list(dir).catch(() => null);
        if (!listed || listed.files.length > 0 || listed.folders.length > 0) break;
        await adapter.rmdir(dir, false);
        dir = parentOf(dir);
      }
    }
  }

  /** `.obsidian/plugins/<id>/.parts`, with a fallback: manifest.dir is optional. */
  private partsDir(): string {
    const dir = this.plugin.manifest.dir
      ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return `${dir}/.parts`;
  }

  /**
   * Create every missing parent of a file path.
   *
   * DataAdapter.mkdir creates ONE directory; it is not documented as recursive
   * and CapacitorAdapter wraps a call that needs an explicit recursive flag.
   * Canvas paths are nested ("Week 1/Lecture 2/slides.pdf"), so walk it.
   */
  private async ensureDir(filePath: string) {
    const adapter = this.plugin.app.vault.adapter;
    const dir = parentOf(filePath);
    if (!dir) return;
    const parts = dir.split("/").filter((s) => s.length > 0);
    let cur = "";
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!(await adapter.exists(cur))) {
        try {
          await adapter.mkdir(cur);
        } catch {
          // Racing another mkdir of the same path is fine; a real failure will
          // surface on the write that follows.
        }
      }
    }
  }
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** "a/b.pdf" + 123 -> "a/b (123).pdf". Keeps the extension where users expect it. */
export function uniquify(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > slash + 1) return `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
  return `${path} (${n})`;
}

export function notifyResult(r: SyncResult) {
  const changed = r.added + r.updated + r.restored + r.removed + r.adopted;
  if (changed + r.conflicts.length + r.errors.length === 0) return;
  const parts = [`${r.added} new`, `${r.updated} updated`, `${r.removed} removed`];
  if (r.restored) parts.push(`${r.restored} restored`);
  if (r.adopted) parts.push(`${r.adopted} already present`);
  if (r.conflicts.length) parts.push(`${r.conflicts.length} conflicts`);
  if (r.errors.length) parts.push(`${r.errors.length} errors`);
  new Notice(`stele-pull: ${parts.join(", ")}`);
}
