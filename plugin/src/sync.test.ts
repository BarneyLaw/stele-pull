import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Plugin } from "obsidian";
import { Syncer, SyncProgress, uniquify } from "./sync";
import { RemoteStore } from "./store";
import { StoreSource, CanvasSource } from "./source";
import { CanvasClient, CanvasFile } from "./canvas";
import { Manifest, Entry, blobKey, latestKey, manifestKey } from "./types";
import { FileRecord, LocalState, emptyState, loadState } from "./state";
import { Policy } from "./policy";

const OPEN: Policy = { version: 1, default: "include", rules: [] };

const FOLDERS = {
  targetFolder: "Canvas",
  trashFolder: "Canvas/_trash",
  conflictFolder: "Canvas/_conflicts",
};

/** The test course's folder, as courseFolderName names it. */
const C = "Canvas/TST1001 [2610] (42)";

const enc = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => bytesToHex(sha256(enc(s)));

/** In-memory DataAdapter: files as bytes, directories as a set. */
class FakeAdapter {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  mtimes = new Map<string, number>();
  mkdirCalls: string[] = [];

  write(path: string, content: string, mtime = Date.now()) {
    this.files.set(path, enc(content));
    this.mtimes.set(path, mtime);
  }
  read(path: string): string {
    return new TextDecoder().decode(this.files.get(path));
  }

  /** A directory exists if it was made or holds anything, as on a real disk. */
  private has(p: string) {
    if (this.files.has(p) || this.dirs.has(p)) return true;
    const prefix = `${p}/`;
    return [...this.files.keys(), ...this.dirs].some((k) => k.startsWith(prefix));
  }

  exists(p: string) { return Promise.resolve(this.has(p)); }
  stat(p: string) {
    const f = this.files.get(p);
    if (!f) return Promise.resolve(null);
    return Promise.resolve({ type: "file", size: f.byteLength, mtime: this.mtimes.get(p) ?? 0, ctime: 0 });
  }
  readBinary(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error(`no such file ${p}`);
    return Promise.resolve(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer);
  }
  writeBinary(p: string, data: ArrayBuffer) {
    this.files.set(p, new Uint8Array(data));
    this.mtimes.set(p, Date.now());
    return Promise.resolve();
  }
  appendBinary(p: string, data: ArrayBuffer) {
    const prev = this.files.get(p) ?? new Uint8Array(0);
    const next = new Uint8Array(prev.byteLength + data.byteLength);
    next.set(prev, 0);
    next.set(new Uint8Array(data), prev.byteLength);
    this.files.set(p, next);
    return Promise.resolve();
  }
  remove(p: string) { this.files.delete(p); return Promise.resolve(); }
  rename(from: string, to: string) {
    // The real adapter refuses to clobber; make the fake just as strict so a
    // test cannot pass on behaviour Obsidian would reject.
    if (this.has(to)) throw new Error(`rename target exists: ${to}`);
    const f = this.files.get(from);
    if (f) {
      this.files.delete(from);
      this.files.set(to, f);
      this.mtimes.set(to, this.mtimes.get(from) ?? Date.now());
      return Promise.resolve();
    }
    if (!this.has(from)) throw new Error(`no such file ${from}`);
    const prefix = `${from}/`;
    for (const [k, v] of [...this.files]) {
      if (k.startsWith(prefix)) {
        this.files.delete(k);
        this.files.set(to + k.slice(from.length), v);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(prefix)) {
        this.dirs.delete(d);
        this.dirs.add(to + d.slice(from.length));
      }
    }
    return Promise.resolve();
  }
  mkdir(p: string) {
    this.mkdirCalls.push(p);
    // Mirrors a non-recursive mkdir: the parent must already exist.
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent && !this.has(parent)) throw new Error(`parent missing: ${parent}`);
    this.dirs.add(p);
    return Promise.resolve();
  }
  list(p: string) {
    const prefix = `${p}/`;
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const k of [...this.files.keys(), ...this.dirs]) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf("/");
      if (i >= 0) folders.add(prefix + rest.slice(0, i));
      else if (this.files.has(k)) files.add(k);
      else folders.add(k);
    }
    return Promise.resolve({ files: [...files], folders: [...folders] });
  }
  rmdir(p: string) {
    this.dirs.delete(p);
    return Promise.resolve();
  }
}

class FakePlugin {
  saved: unknown = null;
  loaded: unknown = null;
  manifest = { id: "stele-pull", dir: ".myconfig/plugins/stele-pull" };
  constructor(public adapter: FakeAdapter) {}
  get app() { return { vault: { adapter: this.adapter, configDir: ".myconfig" } }; }
  saveData(d: unknown) { this.saved = d; return Promise.resolve(); }
  loadData() { return Promise.resolve(this.loaded); }
}

/** Serves blob bytes by hash; records what was requested. */
class FakeStore {
  gets: string[] = [];
  /** Text objects (latest pointers, manifests) by key. */
  texts = new Map<string, string>();
  /** Keys read with { fresh: true }, i.e. past the HTTP cache. */
  freshReads: string[] = [];
  constructor(public blobs: Map<string, Uint8Array>) {}
  getText(key: string, opts: { fresh?: boolean } = {}) {
    if (opts.fresh) this.freshReads.push(key);
    return Promise.resolve(this.texts.get(key) ?? null);
  }
  getBinary(key: string) {
    this.gets.push(key);
    const b = this.blobs.get(key);
    if (!b) throw new Error(`404 ${key}`);
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  }
  getRange(key: string, off: number, n: number) {
    this.gets.push(key);
    const b = this.blobs.get(key);
    if (!b) throw new Error(`404 ${key}`);
    const slice = b.slice(off, off + n);
    return Promise.resolve(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
  }
}

function entry(path: string, content: string, over: Partial<Entry> = {}): Entry {
  return {
    path,
    state: "stored",
    size: enc(content).byteLength,
    canvas_id: 1,
    updated_at: "2026-01-01T00:00:00Z",
    modified_at: "2026-01-01T00:00:00Z",
    sha256: hashOf(content),
    ...over,
  };
}

function manifest(entries: Entry[], runId = "run-2"): Manifest {
  return {
    schema_version: 1,
    course_id: 42,
    course_name: "TST1001 Testing [2610]",
    course_code: "TST1001",
    run_id: runId,
    generated_at: "2026-01-01T00:00:00Z",
    rules_hash: "abc",
    entries,
  };
}

/** Test course 42's records. */
const files = (state: LocalState): Record<string, FileRecord> =>
  (state.courses["42"] ??= { files: {} }).files;

function build(contents: string[]) {
  const adapter = new FakeAdapter();
  adapter.dirs.add("Canvas");
  adapter.dirs.add(".myconfig");
  adapter.dirs.add(".myconfig/plugins");
  adapter.dirs.add(".myconfig/plugins/stele-pull");
  const blobs = new Map<string, Uint8Array>();
  for (const c of contents) blobs.set(blobKey(hashOf(c)), enc(c));
  const plugin = new FakePlugin(adapter);
  const store = new FakeStore(blobs);
  const state = emptyState();
  const make = (s: LocalState = state) =>
    new Syncer(plugin as unknown as Plugin, new StoreSource(store as unknown as RemoteStore), OPEN, s, FOLDERS);
  return { adapter, plugin, store, state, make };
}

describe("fetchManifest", () => {
  it("follows latest to the manifest it names, tolerating a trailing newline", async () => {
    const { store, make } = build([]);
    store.texts.set(latestKey(42), "run-9\n");
    store.texts.set(manifestKey(42, "run-9"), JSON.stringify(manifest([entry("a.pdf", "x")], "run-9")));

    const m = await make().fetchManifest(42);

    expect(m?.run_id).toBe("run-9");
  });

  it("reads latest past the HTTP cache, and only latest", async () => {
    const { store, make } = build([]);
    store.texts.set(latestKey(42), "run-9");
    store.texts.set(manifestKey(42, "run-9"), JSON.stringify(manifest([], "run-9")));

    await make().fetchManifest(42);

    // A cached latest hid a manual worker run for hours (issue #10). The
    // manifest it names is write-once, so caching that is fine.
    expect(store.freshReads).toEqual([latestKey(42)]);
  });

  it("returns null before the worker has published the course", async () => {
    const { make } = build([]);
    expect(await make().fetchManifest(42)).toBeNull();
  });

  it("refuses a manifest that names another course", async () => {
    const { store, make } = build([]);
    const foreign = { ...manifest([entry("a.pdf", "x")], "run-9"), course_id: 7 };
    store.texts.set(latestKey(42), "run-9");
    store.texts.set(manifestKey(42, "run-9"), JSON.stringify(foreign));

    await expect(make().fetchManifest(42)).rejects.toThrow(/claims course 7/);
  });

  it("refuses a manifest from a different run than latest names", async () => {
    const { store, make } = build([]);
    store.texts.set(latestKey(42), "run-9");
    store.texts.set(manifestKey(42, "run-9"), JSON.stringify(manifest([], "run-8")));

    await expect(make().fetchManifest(42)).rejects.toThrow(/run run-8/);
  });
});

describe("writeEntry: downloading", () => {
  it("writes a new file into the course's folder and records its hash", async () => {
    const { adapter, state, make } = build(["hello"]);
    const res = await make().syncCourse(manifest([entry("a.pdf", "hello")]));

    expect(res.added).toBe(1);
    expect(res.conflicts).toEqual([]);
    expect(adapter.read(`${C}/a.pdf`)).toBe("hello");
    expect(files(state)["a.pdf"]?.sha256).toBe(hashOf("hello"));
  });

  it("creates nested parent directories one level at a time", async () => {
    const { adapter, make } = build(["slides"]);
    await make().syncCourse(manifest([entry("Week 1/Lecture 2/s.pdf", "slides")]));

    // A single non-recursive mkdir of the full path would have thrown.
    expect(adapter.read(`${C}/Week 1/Lecture 2/s.pdf`)).toBe("slides");
    expect(adapter.mkdirCalls).toContain(C);
    expect(adapter.mkdirCalls).toContain(`${C}/Week 1`);
    expect(adapter.mkdirCalls).toContain(`${C}/Week 1/Lecture 2`);
  });

  it("refuses bytes whose hash does not match the manifest", async () => {
    const { adapter, store, make } = build([]);
    const e = entry("a.pdf", "hello");
    // Store serves the wrong content, of the right length, under the expected key.
    store.blobs.set(blobKey(e.sha256!), enc("hellp"));

    const res = await make().syncCourse(manifest([e]));

    expect(res.added).toBe(0);
    expect(res.errors[0]).toMatch(/hash mismatch/);
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
    // And no part file is left behind.
    expect([...adapter.files.keys()].filter((k) => k.includes(".parts"))).toEqual([]);
  });

  it("refuses a download of the wrong length before looking at its hash", async () => {
    const { adapter, store, make } = build([]);
    const e = entry("a.pdf", "hello");
    store.blobs.set(blobKey(e.sha256!), enc("hell"));

    const res = await make().syncCourse(manifest([e]));

    expect(res.errors[0]).toMatch(/size mismatch: expected 5 bytes, received 4/);
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
  });
});

describe("progress", () => {
  it("counts each file it writes, and ends full", async () => {
    const { make } = build(["aa", "bbbb"]);
    const seen: SyncProgress[] = [];
    await make().syncCourse(manifest([entry("a.pdf", "aa"), entry("b.pdf", "bbbb")]), {
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(seen[0]).toEqual({ files: 0, filesTotal: 2, bytes: 0, bytesTotal: 6, current: "a.pdf" });
    expect(seen.at(-1)).toEqual({ files: 2, filesTotal: 2, bytes: 6, bytesTotal: 6, current: undefined });
    // Bytes never go backwards, so the bar never jumps back.
    const bytes = seen.map((p) => p.bytes);
    expect(bytes).toEqual([...bytes].sort((x, y) => x - y));
  });

  it("advances by chunk through a large file", async () => {
    const big = "x".repeat(9 * 1024 * 1024);
    const { adapter, make } = build([big]);
    const seen: number[] = [];
    await make().syncCourse(manifest([entry("rec.mp4", big)]), { onProgress: (p) => seen.push(p.bytes) });

    // Desktop chunks are 8 MiB: one report per chunk, then the closing one.
    expect(seen).toEqual([0, 8 * 1024 * 1024, big.length, big.length]);
    expect(adapter.files.get(`${C}/rec.mp4`)?.byteLength).toBe(big.length);
  });

  it("leaves out files it will not write, and says nothing when there are none", async () => {
    const { state, make } = build(["new"]);
    state.lastRunId["42"] = "run-1";
    const seen: SyncProgress[] = [];
    // An automatic pull only refreshes files the vault has; a new file is not one.
    await make().syncCourse(manifest([entry("a.pdf", "new")]), {
      mode: "automatic", onProgress: (p) => seen.push(p),
    });

    expect(seen).toEqual([]);
  });

  it("counts a failed file as done, so the bar still ends full", async () => {
    const { make } = build(["ok"]);
    const seen: SyncProgress[] = [];
    const res = await make().syncCourse(manifest([entry("gone.pdf", "not in store"), entry("ok.pdf", "ok")]), {
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(res.errors).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ files: 2, filesTotal: 2 });
  });
});

describe("course folders", () => {
  it("keeps two courses with the same path apart", async () => {
    const { adapter, state, make } = build(["course 42", "course 43"]);
    const s = make();
    const other: Manifest = {
      ...manifest([entry("Labs/lab1.pdf", "course 43")]), course_id: 43, course_code: "TST2002",
    };

    const a = await s.syncCourse(manifest([entry("Labs/lab1.pdf", "course 42")]));
    const b = await s.syncCourse(other);

    expect(a.added).toBe(1);
    expect(b.added).toBe(1);
    expect(b.conflicts).toEqual([]);
    expect(adapter.read(`${C}/Labs/lab1.pdf`)).toBe("course 42");
    expect(adapter.read("Canvas/TST2002 [2610] (43)/Labs/lab1.pdf")).toBe("course 43");
    expect(Object.keys(state.courses).sort()).toEqual(["42", "43"]);
  });

  it("names the folder by id alone when the manifest has no course code", async () => {
    const { adapter, make } = build(["aaa"]);
    const m = manifest([entry("a.pdf", "aaa")]);
    delete m.course_code;

    await make().syncCourse(m);

    expect(adapter.read("Canvas/42/a.pdf")).toBe("aaa");
  });

  it("moves the folder when its name changes, e.g. from the earlier code (id) format", async () => {
    const { adapter, store, state, make } = build(["aaa"]);
    adapter.write("Canvas/TST1001 (42)/a.pdf", "aaa", 1000);
    state.courses["42"] = {
      folder: "TST1001 (42)",
      files: { "a.pdf": { sha256: hashOf("aaa"), size: 3, writtenAt: 1000 } },
    };
    const m = manifest([entry("a.pdf", "aaa")]);

    const res = await make(state).syncCourse(m);

    expect(res.added + res.updated + res.restored + res.adopted).toBe(0);
    expect(adapter.read(`${C}/a.pdf`)).toBe("aaa");
    expect(await adapter.exists("Canvas/TST1001 (42)")).toBe(false);
    expect(store.gets).toEqual([]);
  });

  it("moves the folder, without downloading, when the course gains its code", async () => {
    const { adapter, store, state, make } = build(["aaa"]);
    adapter.write("Canvas/42/Week 1/a.pdf", "aaa", 1000);
    state.courses["42"] = {
      folder: "42",
      files: { "Week 1/a.pdf": { sha256: hashOf("aaa"), size: 3, writtenAt: 1000 } },
    };
    const m = manifest([entry("Week 1/a.pdf", "aaa")]);
    state.lastRunId["42"] = m.run_id;

    expect(await make(state).needsSync(m)).toBe(false);

    expect(adapter.read(`${C}/Week 1/a.pdf`)).toBe("aaa");
    expect(adapter.files.has("Canvas/42/Week 1/a.pdf")).toBe(false);
    expect(state.courses["42"]?.folder).toBe("TST1001 [2610] (42)");
    expect(store.gets).toEqual([]);
  });
});

describe("upgrading from one shared folder (state version 1)", () => {
  it("moves recorded files into the course's folder without downloading them", async () => {
    const { adapter, store, state, make } = build(["aaa", "bbb"]);
    adapter.write("Canvas/a.pdf", "aaa", 1000);
    adapter.write("Canvas/Week 1/b.pdf", "bbb", 1000);
    state.legacyFiles["a.pdf"] = { sha256: hashOf("aaa"), size: 3, writtenAt: 1000 };
    state.legacyFiles["Week 1/b.pdf"] = { sha256: hashOf("bbb"), size: 3, writtenAt: 1000 };
    const m = manifest([entry("a.pdf", "aaa"), entry("Week 1/b.pdf", "bbb")]);
    state.lastRunId["42"] = m.run_id;
    const s = make(state);

    expect(await s.needsSync(m)).toBe(false);

    expect(adapter.read(`${C}/a.pdf`)).toBe("aaa");
    expect(adapter.read(`${C}/Week 1/b.pdf`)).toBe("bbb");
    expect(adapter.files.has("Canvas/a.pdf")).toBe(false);
    expect(await adapter.exists("Canvas/Week 1")).toBe(false);
    expect(state.legacyFiles).toEqual({});
    const actions = s.previewCourse(m, await s.missingFiles(m)).items.map((i) => i.action);
    expect(actions).toEqual(["have", "have"]);
    expect(store.gets).toEqual([]);
  });

  it("offers a version 1 file the user had deleted, restored once ticked", async () => {
    const { adapter, state, make } = build(["aaa"]);
    state.legacyFiles["a.pdf"] = { sha256: hashOf("aaa"), size: 3, writtenAt: 1000 };
    const m = manifest([entry("a.pdf", "aaa")]);
    state.lastRunId["42"] = m.run_id;
    const s = make(state);

    expect(await s.needsSync(m)).toBe(false);
    expect(s.previewCourse(m, await s.missingFiles(m)).items[0]?.action).toBe("restore");

    await s.choose(m, ["a.pdf"], true);
    const res = await s.syncCourse(m);

    expect(res.restored).toBe(1);
    expect(adapter.read(`${C}/a.pdf`)).toBe("aaa");
  });

  it("leaves records of paths this course does not list for another course", async () => {
    const { state, make } = build(["aaa"]);
    state.legacyFiles["other-course.pdf"] = { sha256: hashOf("x"), size: 1, writtenAt: 0 };

    await make(state).syncCourse(manifest([entry("a.pdf", "aaa")]));

    expect(Object.keys(state.legacyFiles)).toEqual(["other-course.pdf"]);
  });

  it("loadState upgrades version 1 data, keeping its records for migration", async () => {
    const plugin = new FakePlugin(new FakeAdapter());
    const rec = { sha256: "x", size: 1, writtenAt: 0 };
    plugin.loaded = { state: { version: 1, lastRunId: { "42": "run-1" }, files: { "a.pdf": rec } } };

    const s = await loadState(plugin as unknown as Plugin);

    expect(s).toEqual({ version: 2, lastRunId: { "42": "run-1" }, courses: {}, legacyFiles: { "a.pdf": rec } });
  });

  it("loadState starts empty on data it does not recognise", async () => {
    const plugin = new FakePlugin(new FakeAdapter());
    plugin.loaded = { state: { version: 9 } };
    expect(await loadState(plugin as unknown as Plugin)).toEqual(emptyState());
  });
});

describe("writeEntry: not destroying local data", () => {
  it("quarantines a file present on disk that we have NO record of", async () => {
    // The second-device case: the vault synced over, data.json did not.
    const { adapter, state, make } = build(["new content"]);
    adapter.write(`${C}/a.pdf`, "the user's own work");

    const res = await make().syncCourse(manifest([entry("a.pdf", "new content")]));

    expect(res.conflicts).toEqual(["a.pdf"]);
    expect(adapter.read("Canvas/_conflicts/TST1001 [2610] (42)/a.pdf")).toBe("the user's own work");
    // The user's bytes survived; nothing was overwritten in place.
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
    expect(files(state)["a.pdf"]).toBeUndefined();
  });

  it("quarantines a file edited since we wrote it", async () => {
    const { adapter, state, make } = build(["v2"]);
    adapter.write(`${C}/a.pdf`, "edited by hand", Date.now());
    files(state)["a.pdf"] = { sha256: hashOf("v1"), size: 2, writtenAt: 0 };

    const res = await make(state).syncCourse(manifest([entry("a.pdf", "v2")]));

    expect(res.conflicts).toEqual(["a.pdf"]);
    expect(adapter.read("Canvas/_conflicts/TST1001 [2610] (42)/a.pdf")).toBe("edited by hand");
  });

  it("adopts a file already containing the right bytes instead of re-downloading", async () => {
    const { adapter, store, state, make } = build(["same"]);
    adapter.write(`${C}/a.pdf`, "same");

    const res = await make().syncCourse(manifest([entry("a.pdf", "same")]));

    expect(res.adopted).toBe(1);
    expect(res.conflicts).toEqual([]);
    expect(store.gets).toEqual([]); // no download at all
    expect(files(state)["a.pdf"]?.sha256).toBe(hashOf("same"));
  });

  it("overwrites cleanly when the file still matches what we wrote", async () => {
    const { adapter, state, make } = build(["v2"]);
    const written = Date.now();
    adapter.write(`${C}/a.pdf`, "v1", written);
    files(state)["a.pdf"] = { sha256: hashOf("v1"), size: 2, writtenAt: written };

    const res = await make(state).syncCourse(manifest([entry("a.pdf", "v2")]));

    expect(res.conflicts).toEqual([]);
    expect(res.updated).toBe(1);
    expect(adapter.read(`${C}/a.pdf`)).toBe("v2");
  });

  it("does not collide when a second conflict arrives for the same path", async () => {
    const { adapter, make } = build(["v3"]);
    adapter.write(`${C}/a.pdf`, "mine");
    adapter.write("Canvas/_conflicts/TST1001 [2610] (42)/a.pdf", "an earlier conflict");

    const res = await make().syncCourse(manifest([entry("a.pdf", "v3")]));

    expect(res.conflicts).toEqual(["a.pdf"]);
    expect(adapter.read("Canvas/_conflicts/TST1001 [2610] (42)/a.pdf")).toBe("an earlier conflict");
    const extra = [...adapter.files.keys()].filter((k) => /_conflicts\/TST1001 \[2610\] \(42\)\/a \(\d+\)\.pdf/.test(k));
    expect(extra).toHaveLength(1);
  });
});

describe("what gets pulled", () => {
  const two = (run = "run-2") => manifest([entry("a.pdf", "aaa"), entry("b.pdf", "bbb")], run);

  it("a manual pull writes new files, which start ticked, and claims the run", async () => {
    const { adapter, state, make } = build(["aaa", "bbb"]);
    const res = await make().syncCourse(two());

    expect(res.added).toBe(2);
    expect(adapter.files.has(`${C}/b.pdf`)).toBe(true);
    expect(state.lastRunId["42"]).toBe("run-2");
  });

  it("never pulls a file the user unticked, and remembers the untick", async () => {
    const { adapter, state, plugin, make } = build(["aaa", "bbb"]);
    const s = make();
    await s.choose(two(), ["b.pdf"], false);
    expect((plugin.saved as { state: LocalState }).state.courses["42"]?.choices).toEqual({ "b.pdf": false });

    const res = await s.syncCourse(two());
    expect(res.added).toBe(1);
    expect(adapter.files.has(`${C}/b.pdf`)).toBe(false);

    // Still unticked on the next pull, from a fresh Syncer as after a restart.
    expect((await make(state).syncCourse(two("run-3"))).added).toBe(0);
    expect(adapter.files.has(`${C}/b.pdf`)).toBe(false);
  });

  it("claims the run even when files were left unticked", async () => {
    // Otherwise the next automatic pull would treat the run as unfinished.
    const { state, make } = build(["aaa", "bbb"]);
    const s = make();
    await s.choose(two(), ["b.pdf"], false);
    await s.syncCourse(two());
    expect(state.lastRunId["42"]).toBe("run-2");
    expect(await s.needsSync(two())).toBe(false);
  });

  // The reported bug: files the user left out came in on the next startup.
  it("an automatic pull never brings in a file this vault does not have", async () => {
    const { adapter, store, make } = build(["aaa", "bbb"]);
    const res = await make().syncCourse(two(), { mode: "automatic" });

    expect(res.added).toBe(0);
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
    expect(store.gets).toEqual([]);
  });

  it("an automatic pull refreshes files this vault has that changed in Canvas", async () => {
    const { adapter, make } = build(["aaa", "aaa v2", "bbb"]);
    const s = make();
    await s.syncCourse(manifest([entry("a.pdf", "aaa")], "run-1"));
    const next = manifest([entry("a.pdf", "aaa v2"), entry("b.pdf", "bbb")], "run-2");

    expect(await s.needsSync(next)).toBe(true);
    const res = await s.syncCourse(next, { mode: "automatic" });

    expect(res.updated).toBe(1);
    expect(res.added).toBe(0);
    expect(adapter.read(`${C}/a.pdf`)).toBe("aaa v2");
    expect(adapter.files.has(`${C}/b.pdf`)).toBe(false);
  });

  it("an automatic pull skips a change the user unticked", async () => {
    const { adapter, make } = build(["aaa", "aaa v2"]);
    const s = make();
    await s.syncCourse(manifest([entry("a.pdf", "aaa")], "run-1"));
    const next = manifest([entry("a.pdf", "aaa v2")], "run-2");
    await s.choose(next, ["a.pdf"], false);

    const res = await s.syncCourse(next, { mode: "automatic" });

    expect(res.updated).toBe(0);
    expect(adapter.read(`${C}/a.pdf`)).toBe("aaa");
  });

  it("a tick is spent once the file is pulled", async () => {
    const { state, make } = build(["aaa"]);
    const s = make();
    const m = manifest([entry("a.pdf", "aaa")]);
    await s.choose(m, ["a.pdf"], true);
    await s.syncCourse(m);
    expect(state.courses["42"]?.choices).toEqual({});
  });

  it("forgets ticks for files Canvas no longer offers", async () => {
    const { state, make } = build(["aaa"]);
    const s = make();
    await s.choose(two(), ["b.pdf"], false);
    await s.syncCourse(manifest([entry("a.pdf", "aaa")], "run-3"));
    expect(state.courses["42"]?.choices).toEqual({});
  });

  it("every pull, automatic included, moves removed files to trash", async () => {
    const { adapter, state, make } = build([]);
    adapter.write(`${C}/gone.pdf`, "old");
    files(state)["gone.pdf"] = { sha256: hashOf("old"), size: 3, writtenAt: Date.now() };
    const m = manifest([entry("gone.pdf", "old", { state: "deleted" })]);

    const res = await make(state).syncCourse(m, { mode: "automatic" });

    expect(res.removed).toBe(1);
    expect(adapter.files.has(`${C}/gone.pdf`)).toBe(false);
  });
});

describe("files deleted from the vault", () => {
  // First reported bug: pull, delete the files, and the panel said everything
  // was up to date forever, because the record said so.
  it("are offered again, unticked, and restored only once ticked", async () => {
    const { adapter, make } = build(["aaa", "bbb"]);
    const m = manifest([entry("a.pdf", "aaa"), entry("Week 1/b.pdf", "bbb")]);
    const s = make();
    await s.syncCourse(m);

    adapter.files.delete(`${C}/a.pdf`);
    adapter.files.delete(`${C}/Week 1/b.pdf`);

    const missing = await s.missingFiles(m);
    expect([...missing].sort()).toEqual(["Week 1/b.pdf", "a.pdf"]);
    const p = s.previewCourse(m, missing);
    expect(p.items.map((i) => i.action)).toEqual(["restore", "restore"]);
    expect(s.selection(m, p).size).toBe(0);
    expect((await s.syncCourse(m)).restored).toBe(0);

    await s.choose(m, ["a.pdf"], true);
    const res = await s.syncCourse(m);

    expect(res.restored).toBe(1);
    expect(res.conflicts).toEqual([]);
    expect(adapter.read(`${C}/a.pdf`)).toBe("aaa");
    expect(adapter.files.has(`${C}/Week 1/b.pdf`)).toBe(false);

    // The tick is spent: delete it again and it starts unticked again.
    adapter.files.delete(`${C}/a.pdf`);
    expect(s.selection(m, s.previewCourse(m, await s.missingFiles(m))).size).toBe(0);
  });

  // Second reported bug: after deleting a pull, every reopen of Obsidian
  // pulled it all back.
  it("are never restored by an automatic pull, ticked or not, new run or not", async () => {
    const { adapter, store, make } = build(["aaa"]);
    const s = make();
    await s.syncCourse(manifest([entry("a.pdf", "aaa")], "run-1"));
    adapter.files.delete(`${C}/a.pdf`);
    store.gets.length = 0;

    const next = manifest([entry("a.pdf", "aaa")], "run-2");
    await s.choose(next, ["a.pdf"], true);
    expect(await s.needsSync(next)).toBe(true);
    const res = await s.syncCourse(next, { mode: "automatic" });

    expect(res.restored).toBe(0);
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
    expect(store.gets).toEqual([]);
  });

  it("only counts files this device recorded writing", async () => {
    const { make } = build(["aaa"]);
    const m = manifest([entry("a.pdf", "aaa")]);
    expect((await make().missingFiles(m)).size).toBe(0);
  });

  it("ignores files the manifest no longer stores", async () => {
    const { state, make } = build([]);
    files(state)["gone.pdf"] = { sha256: hashOf("x"), size: 1, writtenAt: 0 };
    const m = manifest([entry("gone.pdf", "x", { state: "deleted" })]);
    expect((await make(state).missingFiles(m)).size).toBe(0);
  });
});

/** A Canvas account with one course: files by id, bytes by download url. */
class FakeCanvas {
  listing = new Map<number, CanvasFile>();
  bytes = new Map<string, Uint8Array>();
  downloads: { url: string; range?: { offset: number; length: number } }[] = [];
  /** Canvas lookups of a single file, for its download url. */
  lookups: number[] = [];

  put(id: number, name: string, content: string | Uint8Array, over: Partial<CanvasFile> = {}) {
    const url = `https://canvas.example/files/${id}/download?verifier=v`;
    const data = typeof content === "string" ? enc(content) : content;
    this.bytes.set(url, data);
    this.listing.set(id, {
      id, folder_id: 1, display_name: name, size: data.byteLength, url,
      updated_at: "2026-01-01T00:00:00Z", modified_at: "2026-01-01T00:00:00Z", ...over,
    });
  }

  course(id: number) {
    return Promise.resolve(id === 42 ? { id, name: "TST1001 Testing [2610]", course_code: "TST1001" } : null);
  }
  files() { return Promise.resolve([...this.listing.values()]); }
  folders() { return Promise.resolve([{ id: 1, full_name: "course files" }]); }
  file(id: number) {
    this.lookups.push(id);
    return Promise.resolve(this.listing.get(id)!);
  }
  download(url: string, range?: { offset: number; length: number }) {
    this.downloads.push({ url, range });
    const b = this.bytes.get(url)!;
    const s = range ? b.slice(range.offset, range.offset + range.length) : b;
    return Promise.resolve(s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) as ArrayBuffer);
  }
}

describe("direct from Canvas", () => {
  function direct() {
    const { adapter, plugin, state } = build([]);
    const canvas = new FakeCanvas();
    // The real CanvasSource and manifest builder; only the HTTP is fake.
    const client = canvas as unknown as CanvasClient;
    const make = () => new Syncer(plugin as unknown as Plugin, new CanvasSource(client), OPEN, state, FOLDERS);
    const sync = async (opts: { mode?: "manual" | "automatic" } = {}) => {
      const s = make();
      const m = (await s.fetchManifest(42))!;
      return { res: await s.syncCourse(m, opts), m };
    };
    return { adapter, state, canvas, make, sync };
  }

  it("downloads a new file, then records its hash and Canvas metadata", async () => {
    const { adapter, state, canvas, sync } = direct();
    canvas.put(7, "a.pdf", "hello");

    const { res } = await sync();

    expect(res.added).toBe(1);
    expect(adapter.read(`${C}/a.pdf`)).toBe("hello");
    expect(files(state)["a.pdf"]).toMatchObject({
      sha256: hashOf("hello"), size: 5, canvasId: 7, updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("downloads nothing again while Canvas reports the file unchanged", async () => {
    const { canvas, make, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    await sync();
    canvas.downloads = [];

    const s = make();
    const m = (await s.fetchManifest(42))!;
    expect(s.previewCourse(m, await s.missingFiles(m)).alreadyHave).toBe(1);
    expect(await s.needsSync(m)).toBe(false);
    expect((await s.syncCourse(m)).added).toBe(0);
    expect(canvas.downloads).toEqual([]);
  });

  it("refreshes a file Canvas has changed, on an automatic pull", async () => {
    const { adapter, canvas, make, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    await sync();
    canvas.put(7, "a.pdf", "world", { updated_at: "2026-02-01T00:00:00Z" });

    expect(await make().needsSync((await make().fetchManifest(42))!)).toBe(true);
    const { res } = await sync({ mode: "automatic" });

    expect(res.updated).toBe(1);
    expect(adapter.read(`${C}/a.pdf`)).toBe("world");
  });

  it("adopts identical bytes already in the vault, such as on a second device", async () => {
    const { adapter, state, canvas, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    adapter.write(`${C}/a.pdf`, "hello");

    const { res } = await sync();

    expect(res.adopted).toBe(1);
    expect(res.conflicts).toEqual([]);
    expect(files(state)["a.pdf"]?.sha256).toBe(hashOf("hello"));
    // Judged only after downloading, so the part file must not linger.
    expect([...adapter.files.keys()].filter((k) => k.includes(".parts"))).toEqual([]);
  });

  it("quarantines a different file it has no record of writing", async () => {
    const { adapter, canvas, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    adapter.write(`${C}/a.pdf`, "my own notes");

    const { res } = await sync();

    expect(res.conflicts).toEqual(["a.pdf"]);
    expect(adapter.read(`Canvas/_conflicts/TST1001 [2610] (42)/a.pdf`)).toBe("my own notes");
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
    expect([...adapter.files.keys()].filter((k) => k.includes(".parts"))).toEqual([]);
  });

  it("quarantines a file edited since it was pulled, when Canvas changes it", async () => {
    const { adapter, canvas, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    await sync();
    adapter.write(`${C}/a.pdf`, "edited", Date.now() + 60_000);
    canvas.put(7, "a.pdf", "world", { updated_at: "2026-02-01T00:00:00Z" });

    const { res } = await sync();

    expect(res.conflicts).toEqual(["a.pdf"]);
    expect(adapter.read(`Canvas/_conflicts/TST1001 [2610] (42)/a.pdf`)).toBe("edited");
  });

  it("moves a file Canvas no longer lists to the trash", async () => {
    const { adapter, canvas, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    await sync();
    canvas.listing.delete(7);

    const { res } = await sync();

    expect(res.removed).toBe(1);
    expect(adapter.read(`Canvas/_trash/TST1001 [2610] (42)/a.pdf`)).toBe("hello");
  });

  it("refuses a short download, since there is no hash to catch it", async () => {
    const { adapter, canvas, sync } = direct();
    canvas.put(7, "a.pdf", "hello");
    canvas.listing.get(7)!.size = 6;

    const { res } = await sync();

    expect(res.errors[0]).toMatch(/size mismatch: expected 6 bytes, received 5/);
    expect(adapter.files.has(`${C}/a.pdf`)).toBe(false);
  });

  it("pulls a large file in ranges", async () => {
    const { adapter, state, canvas, sync } = direct();
    const big = new Uint8Array(9 * 1024 * 1024).fill(7);
    canvas.put(7, "rec.mp4", big);

    await sync();

    expect(canvas.downloads.map((d) => d.range)).toEqual([
      { offset: 0, length: 8 * 1024 * 1024 },
      { offset: 8 * 1024 * 1024, length: 1024 * 1024 },
    ]);
    expect(adapter.files.get(`${C}/rec.mp4`)?.byteLength).toBe(big.byteLength);
    expect(files(state)["rec.mp4"]?.sha256).toBe(bytesToHex(sha256(big)));
  });

  it("asks Canvas for a download link when this source has not listed the course", async () => {
    // The panel lists with one source and "Pull selected" pulls with another.
    const { canvas, make } = direct();
    canvas.put(7, "a.pdf", "hello");
    const m = (await make().fetchManifest(42))!;

    const res = await make().syncCourse(m);

    expect(res.added).toBe(1);
    expect(canvas.lookups).toEqual([7]);
  });

  it("reports a course Canvas does not have as no manifest", async () => {
    const { make } = direct();
    expect(await make().fetchManifest(9)).toBeNull();
  });
});

describe("tombstones", () => {
  it("moves a removed file to the course's trash rather than deleting it", async () => {
    const { adapter, state, make } = build([]);
    adapter.write(`${C}/gone.pdf`, "lecture");
    files(state)["gone.pdf"] = { sha256: hashOf("lecture"), size: 7, writtenAt: Date.now() };

    const res = await make(state).syncCourse(
      manifest([entry("gone.pdf", "lecture", { state: "deleted" })]),
    );

    expect(res.removed).toBe(1);
    expect(adapter.read("Canvas/_trash/TST1001 [2610] (42)/gone.pdf")).toBe("lecture");
    expect(adapter.files.has(`${C}/gone.pdf`)).toBe(false);
    expect(files(state)["gone.pdf"]).toBeUndefined();
  });

  it("survives a file the user already removed", async () => {
    const { state, make } = build([]);
    files(state)["gone.pdf"] = { sha256: hashOf("x"), size: 1, writtenAt: Date.now() };

    const res = await make(state).syncCourse(
      manifest([entry("gone.pdf", "x", { state: "deleted" })]),
    );

    expect(res.errors).toEqual([]);
    expect(files(state)["gone.pdf"]).toBeUndefined();
  });
});

describe("uniquify", () => {
  it("keeps the extension at the end", () => {
    expect(uniquify("a/b.pdf", 7)).toBe("a/b (7).pdf");
  });
  it("appends when there is no extension", () => {
    expect(uniquify("a/README", 7)).toBe("a/README (7)");
  });
  it("does not treat a dotfile's leading dot as an extension", () => {
    expect(uniquify("a/.env", 7)).toBe("a/.env (7)");
  });
});
