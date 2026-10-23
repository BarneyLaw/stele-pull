import { requestUrl, RequestUrlParam, Platform } from "obsidian";

/**
 * Transport to the object store.
 *
 * requestUrl is the only Obsidian networking API that bypasses CORS (desktop
 * routes through Electron's net module, mobile through a Capacitor bridge).
 * On modern Obsidian no bucket CORS configuration is needed at all. Older
 * builds required allowing app://obsidian.md, capacitor://localhost and
 * http://localhost with ETag in exposed headers; the minAppVersion floor
 * removes that.
 *
 * TWO AUTH MODES, and the first is strongly preferred:
 *
 *  1. NETWORK-LAYER (recommended). Expose the bucket read-only behind Tailscale
 *     or an auth proxy and hold NO credentials in the plugin at all. Consumers
 *     are read-only in phase 1, so there is nothing to sign, no SigV4 library,
 *     and no secret sitting in a file that travels with the vault.
 *
 *  2. DIRECT S3 with aws4fetch (~3 KB gzipped, versus 500 KB+ for
 *     @aws-sdk/client-s3). Use AwsV4Signer to compute headers, then hand them
 *     to requestUrl. Use a READ-ONLY Garage key so a leak costs course slides
 *     rather than the bucket.
 *
 *     RISK TO VERIFY EARLY: aws4fetch signs via SubtleCrypto, which needs a
 *     secure context. Obsidian mobile's origin scheme makes that unreliable.
 *     Test on a real phone before committing to this path.
 */
export interface StoreConfig {
  baseUrl: string;      // e.g. https://stele-pull.tailnet.ts.net or the S3 endpoint
  bucket?: string;
  accessKey?: string;   // mode 2 only
  secretKey?: string;   // mode 2 only
}

export class RemoteStore {
  constructor(private cfg: StoreConfig) {}

  private url(key: string): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    return this.cfg.bucket ? `${base}/${this.cfg.bucket}/${key}` : `${base}/${key}`;
  }

  private async request(p: RequestUrlParam) {
    // throw: false so a 404 is a value, not an exception. Missing keys are
    // normal (first run, GC'd blob) and should not need try/catch everywhere.
    return requestUrl({ ...p, throw: false });
  }

  /**
   * @param opts.fresh - go to the store, past every HTTP cache. Required for
   *   `latest`, the one mutable key. Garage's web endpoint sends Last-Modified
   *   and no Cache-Control, so requestUrl's cache (Chromium's, on desktop)
   *   treats it as fresh for a tenth of its age: a pointer published yesterday
   *   is served from cache for over two hours, hiding a manual worker run.
   *   The query string defeats any cache keyed on the URL (mobile's native
   *   stacks, proxies); Garage and `stele-pull serve` both ignore it.
   */
  async getText(key: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
    const r = await this.request(
      opts.fresh
        ? { url: `${this.url(key)}?t=${Date.now()}`, method: "GET", headers: { "Cache-Control": "no-cache" } }
        : { url: this.url(key), method: "GET" },
    );
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(`stele-pull: GET ${key} -> ${r.status}`);
    return r.text;
  }

  /**
   * Whole-object GET. Used below CHUNK_THRESHOLD, where the range bookkeeping
   * buys nothing, and it is the only path that handles a zero-byte object:
   * a Range of bytes=0--1 is malformed, and Canvas does serve empty files.
   */
  async getBinary(key: string): Promise<ArrayBuffer> {
    const r = await this.request({ url: this.url(key), method: "GET" });
    if (r.status >= 400) throw new Error(`stele-pull: GET ${key} -> ${r.status}`);
    return r.arrayBuffer;
  }

  /**
   * Fetch [offset, offset+length) of an object.
   *
   * This is the single most load-bearing call in the plugin. requestUrl buffers
   * whole responses and mobile fails outright somewhere around 20-50 MB, so
   * large files are pulled as a series of small ranges and appended to disk
   * incrementally. Peak memory becomes one chunk instead of one file.
   *
   * Range GET is standard S3 and Garage supports it, but the entire mobile
   * story rests on it, so make it your FIRST integration test.
   *
   * A 206 is REQUIRED, not merely preferred. An endpoint or proxy that ignores
   * Range answers 200 with the whole object, and accepting that would append
   * the entire file once per chunk -- an N-times-oversized download on the
   * device least able to afford it.
   */
  async getRange(key: string, offset: number, length: number): Promise<ArrayBuffer> {
    if (length <= 0) return new ArrayBuffer(0);
    const end = offset + length - 1;
    const r = await this.request({
      url: this.url(key),
      method: "GET",
      headers: { Range: `bytes=${offset}-${end}` },
    });
    if (r.status !== 206) {
      if (r.status === 200) {
        throw new Error(
          `stele-pull: range GET ${key} was answered with 200, not 206: the endpoint ` +
          `is ignoring the Range header. Check for a proxy in front of the bucket.`,
        );
      }
      throw new Error(`stele-pull: range GET ${key} -> ${r.status}`);
    }
    if (r.arrayBuffer.byteLength !== length) {
      throw new Error(
        `stele-pull: range GET ${key} returned ${r.arrayBuffer.byteLength} bytes, expected ${length}`,
      );
    }
    return r.arrayBuffer;
  }
}

/** Mobile WebViews are far tighter on memory than desktop Electron. */
export const chunkSize = () => (Platform.isMobile ? 2 * 1024 * 1024 : 8 * 1024 * 1024);

/** Below this, one whole-object GET is cheaper than range bookkeeping. */
export const CHUNK_THRESHOLD = 4 * 1024 * 1024;
