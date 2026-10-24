import { Entry, Manifest, blobKey, latestKey, manifestKey, parseManifest } from "./types";
import { FileRecord } from "./state";
import { RemoteStore } from "./store";
import { CanvasClient, CanvasError, canvasManifest } from "./canvas";

/**
 * Where a course's catalogue and file bytes come from: the worker's store, or
 * Canvas itself (direct mode). The sync loop only ever sees this.
 */
export interface Source {
  /**
   * The course's catalogue now, or null when there is none yet.
   * @param known - what this device wrote for the course, by path.
   */
  manifest(courseId: number, known: Readonly<Record<string, FileRecord>>): Promise<Manifest | null>;
  /** The course's name and code, for Setup, as cheaply as the source allows. */
  course(courseId: number): Promise<Pick<Manifest, "course_name" | "course_code"> | null>;
  /** A stored entry's bytes, whole. */
  read(e: Entry): Promise<ArrayBuffer>;
  /** [offset, offset+length) of a stored entry's bytes. */
  readRange(e: Entry, offset: number, length: number): Promise<ArrayBuffer>;
}

/** The worker's store: manifests by run, blobs by hash. */
export class StoreSource implements Source {
  constructor(private store: RemoteStore) {}

  async manifest(courseId: number): Promise<Manifest | null> {
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

  course(courseId: number) {
    return this.manifest(courseId);
  }

  read(e: Entry) {
    return this.store.getBinary(blobKey(hashOf(e)));
  }

  readRange(e: Entry, offset: number, length: number) {
    return this.store.getRange(blobKey(hashOf(e)), offset, length);
  }
}

function hashOf(e: Entry): string {
  if (!e.sha256) throw new Error("stored entry without a hash");
  return e.sha256;
}

/**
 * Canvas directly, for users with no store. Lists the course on every
 * manifest() call, which is three or four API requests.
 */
export class CanvasSource implements Source {
  /** Download urls from the last listing, by Canvas id. */
  private urls = new Map<number, string>();

  constructor(private canvas: CanvasClient, private now: () => Date = () => new Date()) {}

  async manifest(courseId: number, known: Readonly<Record<string, FileRecord>>): Promise<Manifest | null> {
    const course = await this.canvas.course(courseId);
    if (!course) return null;
    let files, folders;
    try {
      [files, folders] = [await this.canvas.files(courseId), await this.canvas.folders(courseId)];
    } catch (e) {
      if (e instanceof CanvasError && e.kind === "forbidden") {
        throw new Error(`Canvas does not let this account list the files of course ${courseId}; its Files tab may be hidden`);
      }
      throw e;
    }
    for (const f of files) if (f.url) this.urls.set(f.id, f.url);
    return canvasManifest(course, files, folders, known, this.now());
  }

  async course(courseId: number) {
    const c = await this.canvas.course(courseId);
    return c ? { course_name: c.name ?? "", course_code: c.course_code } : null;
  }

  async read(e: Entry) {
    return this.canvas.download(await this.url(e));
  }

  async readRange(e: Entry, offset: number, length: number) {
    return this.canvas.download(await this.url(e), { offset, length });
  }

  /** From the listing, or asked for: a pull can run on a fresh source. */
  private async url(e: Entry): Promise<string> {
    const known = this.urls.get(e.canvas_id);
    if (known) return known;
    const f = await this.canvas.file(e.canvas_id);
    if (!f.url) throw new Error("Canvas gives no download link for this file (locked?)");
    this.urls.set(f.id, f.url);
    return f.url;
  }
}
