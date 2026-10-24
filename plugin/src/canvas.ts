import { requestUrl, RequestUrlResponse } from "obsidian";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Entry, Manifest, SCHEMA_VERSION } from "./types";
import { FileRecord } from "./state";
import * as portable from "./portable";

/**
 * Direct-Canvas mode, for users with no stele-pull store of their own: the
 * plugin lists Canvas itself and downloads straight from it.
 *
 * It produces the same Manifest the worker would, so everything downstream
 * (preview, local rules, the sync loop, the panel) is shared. Two differences
 * follow from Canvas having no content hash:
 *  - a file is "unchanged" when its Canvas id, size, updated_at and modified_at
 *    match what this device recorded when it wrote the file, which is the
 *    worker's own test (plan.unchanged), and the hash then comes from that
 *    record;
 *  - a new or changed file has no hash until it is downloaded, and the sync
 *    loop hashes it then.
 * There is no worker, so there are no worker rules: only the local ones apply.
 */

/** The fields of a Canvas REST file object this mode reads. */
export interface CanvasFile {
  id: number;
  uuid?: string;
  folder_id: number;
  display_name: string;
  "content-type"?: string;
  /** Download endpoint carrying a verifier. Absent when locked for the user. */
  url?: string;
  size: number;
  updated_at: string;
  modified_at: string;
  unlock_at?: string | null;
  locked?: boolean;
  locked_for_user?: boolean;
}

export interface CanvasFolder {
  id: number;
  full_name: string;
}

export interface CanvasCourse {
  id: number;
  name?: string;
  course_code?: string;
  /** A stub for a course outside its term dates: no name or code. */
  access_restricted_by_date?: boolean;
}

/**
 * The course's catalogue as a manifest. Pure.
 *
 * @param known - what this device wrote for the course, by path. Supplies the
 *   hash of every unchanged file, and a tombstone for every recorded path that
 *   Canvas no longer lists.
 */
export function canvasManifest(
  course: CanvasCourse,
  files: readonly CanvasFile[],
  folders: readonly CanvasFolder[],
  known: Readonly<Record<string, FileRecord>>,
  now: Date,
): Manifest {
  const entries = canvasEntries(files, folders);
  const live = new Set<string>();
  for (const e of entries) {
    live.add(e.path);
    const rec = known[e.path];
    if (e.state === "stored" && rec && unchanged(rec, e)) e.sha256 = rec.sha256;
  }
  for (const [path, rec] of Object.entries(known)) {
    if (live.has(path)) continue;
    entries.push({
      path, state: "deleted", size: rec.size,
      canvas_id: rec.canvasId ?? 0,
      updated_at: rec.updatedAt ?? "", modified_at: rec.modifiedAt ?? "",
      reason: "no longer present in Canvas",
      deleted_at: now.toISOString(),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schema_version: SCHEMA_VERSION,
    course_id: course.id,
    course_name: course.name ?? "",
    course_code: course.course_code,
    run_id: listingId(entries),
    generated_at: now.toISOString(),
    rules_hash: "",
    entries,
  };
}

/**
 * Entries for a Canvas listing, with the worker's paths: toPlanFiles, then
 * plan.dedupe and plan.disambiguate. Locked files are "locked", everything
 * else "stored" with no hash yet. Pure.
 */
export function canvasEntries(files: readonly CanvasFile[], folders: readonly CanvasFolder[]): Entry[] {
  const dirs = new Map(folders.map((f) => [f.id, f.full_name]));
  const built = dedupe(files).map((f) => {
    let dir = "";
    if (f.folder_id !== 0) dir = dirs.get(f.folder_id) ?? `_unlisted-folder-${f.folder_id}`;
    const { path, note } = resolvePath(dir, f.display_name, f.id);
    const locked = f.locked_for_user === true || f.locked === true;
    const e: Entry = {
      path, state: locked ? "locked" : "stored",
      size: f.size, mime: f["content-type"] || undefined,
      canvas_id: f.id, canvas_uuid: f.uuid || undefined,
      updated_at: f.updated_at, modified_at: f.modified_at,
    };
    if (locked) {
      e.reason = "locked in Canvas";
      if (f.unlock_at) e.unlock_at = f.unlock_at;
    } else if (note) {
      e.reason = note;
    }
    return e;
  });
  return disambiguate(built);
}

/** plan.unchanged, against what this device recorded writing. */
export function unchanged(rec: FileRecord, e: Entry): boolean {
  return rec.canvasId === e.canvas_id &&
    rec.size === e.size &&
    sameInstant(rec.updatedAt, e.updated_at) &&
    sameInstant(rec.modifiedAt, e.modified_at);
}

function sameInstant(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const ta = Date.parse(a);
  return !Number.isNaN(ta) && ta === Date.parse(b);
}

/** run.joinPath: strip Canvas's synthetic "course files" root. */
function joinPath(dir: string, name: string): string {
  if (dir.startsWith("course files/")) dir = dir.slice("course files/".length);
  if (dir === "course files") dir = "";
  return dir === "" ? name : `${dir}/${name}`;
}

/** run.resolvePath: a stand-in name rather than a dropped file. */
function resolvePath(dir: string, name: string, id: number): { path: string; note: string } {
  const joined = joinPath(dir, name);
  try {
    return { path: portable.path(joined), note: "" };
  } catch (err) {
    const fb = portable.fallback(name, id);
    try {
      return { path: portable.path(joinPath(dir, fb)), note: `Canvas name "${name}" could not be made portable (${errText(err)}); stored as "${fb}"` };
    } catch {
      return { path: fb, note: `Canvas path "${joined}" could not be made portable (${errText(err)}); stored at the course root as "${fb}"` };
    }
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** plan.dedupe: of two copies of one id, the newer wins, then the larger. */
function dedupe(files: readonly CanvasFile[]): CanvasFile[] {
  const out: CanvasFile[] = [];
  const at = new Map<number, number>();
  for (const f of files) {
    const i = at.get(f.id);
    if (i === undefined) {
      at.set(f.id, out.length);
      out.push(f);
      continue;
    }
    const cur = out[i]!;
    const tf = Date.parse(f.updated_at);
    const tc = Date.parse(cur.updated_at);
    if (tf > tc || (tf === tc && f.size > cur.size)) out[i] = f;
  }
  return out;
}

/** plan.disambiguate: suffixes come from the Canvas id, never listing order. */
function disambiguate(entries: Entry[]): Entry[] {
  for (let round = 0; round < 4; round++) {
    const counts = new Map<string, number>();
    for (const e of entries) {
      const k = portable.collisionKey(e.path);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let collided = false;
    for (const e of entries) {
      if ((counts.get(portable.collisionKey(e.path)) ?? 0) > 1) {
        e.path = portable.disambiguate(e.path, e.canvas_id);
        collided = true;
      }
    }
    if (!collided) break;
  }
  return entries;
}

/**
 * Stands in for the worker's run id: it changes exactly when the listing
 * does, so an automatic pull skips a course whose listing has not moved.
 * Canvas metadata only, never a hash: hashes come from this device's records,
 * and a first pull adding them must not read as Canvas changing.
 */
function listingId(entries: readonly Entry[]): string {
  const lines = entries.map((e) =>
    [e.path, e.state, e.canvas_id, e.size, e.updated_at, e.modified_at].join("\t"));
  return `canvas-${bytesToHex(sha256(new TextEncoder().encode(lines.join("\n")))).slice(0, 16)}`;
}

export type CanvasErrorKind = "unauthorized" | "forbidden" | "not-found" | "throttled" | "other";

export class CanvasError extends Error {
  constructor(message: string, public kind: CanvasErrorKind, public status: number) {
    super(message);
  }
}

/** Bounds pagination, so a server bug cannot spin forever. */
const MAX_PAGES = 100;

/**
 * Canvas REST over requestUrl, which bypasses CORS.
 *
 * The token goes in an Authorization header to the configured Canvas origin
 * and nowhere else: a pagination Link is server-controlled input, and a file's
 * url redirects to presigned storage that rejects (and must never see) it. A
 * download url carries its own verifier.
 */
export class CanvasClient {
  private origin: URL;

  constructor(baseUrl: string, private token: string) {
    this.origin = new URL(baseUrl);
  }

  /** null when there is no such course for this account. */
  async course(id: number): Promise<CanvasCourse | null> {
    try {
      const [c] = await this.get<CanvasCourse>(`/api/v1/courses/${id}`, false);
      return c ?? null;
    } catch (e) {
      if (e instanceof CanvasError && e.kind === "not-found") return null;
      throw e;
    }
  }

  /** Courses this account is actively enrolled in. */
  courses(): Promise<CanvasCourse[]> {
    return this.get<CanvasCourse>("/api/v1/courses?enrollment_state=active&per_page=100", true);
  }

  files(courseId: number): Promise<CanvasFile[]> {
    return this.get<CanvasFile>(`/api/v1/courses/${courseId}/files?per_page=100`, true);
  }

  folders(courseId: number): Promise<CanvasFolder[]> {
    return this.get<CanvasFolder>(`/api/v1/courses/${courseId}/folders?per_page=100`, true);
  }

  /** One file's object, for its download url. */
  async file(id: number): Promise<CanvasFile> {
    const [f] = await this.get<CanvasFile>(`/api/v1/files/${id}`, false);
    if (!f) throw new CanvasError(`Canvas returned no file ${id}`, "other", 200);
    return f;
  }

  /**
   * GET a download url, whole or one range of it. No Authorization header.
   * A range must come back as 206 with exactly the bytes asked for, for the
   * same reason as RemoteStore.getRange.
   */
  async download(url: string, range?: { offset: number; length: number }): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const r = await requestUrl({ url, method: "GET", headers, throw: false });
    if (range) {
      if (r.status !== 206) {
        throw new CanvasError(
          r.status === 200
            ? "Canvas file storage ignored the Range header; large files cannot be downloaded in chunks"
            : `Canvas download returned ${r.status}`,
          "other", r.status);
      }
      if (r.arrayBuffer.byteLength !== range.length) {
        throw new CanvasError(
          `Canvas download returned ${r.arrayBuffer.byteLength} bytes, expected ${range.length}`, "other", r.status);
      }
      return r.arrayBuffer;
    }
    if (r.status !== 200) throw new CanvasError(`Canvas download returned ${r.status}`, "other", r.status);
    return r.arrayBuffer;
  }

  /** An API GET, following rel="next" when `paged`. A single object comes back as one item. */
  private async get<T>(path: string, paged: boolean): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let next: string | null = new URL(path, this.origin).toString();
    for (let page = 1; next; page++) {
      if (page > MAX_PAGES) throw new CanvasError(`more than ${MAX_PAGES} pages from ${path}`, "other", 200);
      if (seen.has(next)) throw new CanvasError(`pagination loop at ${path}`, "other", 200);
      seen.add(next);
      this.sameOrigin(next);

      const r = await requestUrl({
        url: next, method: "GET", throw: false,
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      });
      check(r);
      const body = r.json as T | T[];
      if (Array.isArray(body)) out.push(...body);
      else out.push(body);
      next = paged ? nextLink(header(r, "link")) : null;
    }
    return out;
  }

  private sameOrigin(raw: string) {
    const u = new URL(raw);
    if (u.protocol !== this.origin.protocol || u.host !== this.origin.host) {
      throw new CanvasError(`refusing to send the Canvas token to ${u.protocol}//${u.host}`, "other", 0);
    }
  }
}

/** canvas.classify: Canvas answers 401 for a dead token AND for "not allowed". */
function check(r: RequestUrlResponse) {
  if (r.status === 200) return;
  const msg = errorMessage(r);
  if (r.status === 401 && /not authori[sz]ed/i.test(msg)) {
    throw new CanvasError(`Canvas does not allow this: ${msg}`, "forbidden", r.status);
  }
  if (r.status === 401) {
    throw new CanvasError(
      "Canvas rejected the access token. Generate a new one in Canvas under Account, Settings.",
      "unauthorized", r.status);
  }
  if (r.status === 429 || (r.status === 403 && /rate limit/i.test(msg))) {
    throw new CanvasError("Canvas is throttling requests; try again in a minute", "throttled", r.status);
  }
  if (r.status === 403) throw new CanvasError(`Canvas does not allow this: ${msg}`, "forbidden", r.status);
  if (r.status === 404) throw new CanvasError("not found in Canvas", "not-found", r.status);
  throw new CanvasError(`Canvas returned ${r.status}: ${msg}`, "other", r.status);
}

function errorMessage(r: RequestUrlResponse): string {
  try {
    const v = JSON.parse(r.text) as { message?: string; errors?: { message?: string }[] };
    const m = v.errors?.[0]?.message ?? v.message;
    if (m) return m;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  const s = (r.text ?? "").trim();
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

/** Response headers are lowercase on desktop, but not promised to be. */
function header(r: RequestUrlResponse, name: string): string {
  for (const [k, v] of Object.entries(r.headers ?? {})) if (k.toLowerCase() === name) return v;
  return "";
}

/** The rel="next" url of a Link header, or null on the last page. */
export function nextLink(link: string): string | null {
  return /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
}
