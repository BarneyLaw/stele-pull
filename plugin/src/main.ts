import { Plugin, Notice, WorkspaceLeaf } from "obsidian";
import { StelePullSettings, DEFAULT_SETTINGS, StelePullSettingTab } from "./settings";
import { LocalState, loadState, saveState, emptyState } from "./state";
import { RemoteStore } from "./store";
import { Syncer, notifyResult, PullProgress, SyncProgress } from "./sync";
import { Manifest } from "./types";
import { StelePullView, VIEW_TYPE_STELE_PULL } from "./ui/StelePullView";
import { widenRightSidebar } from "./ui/layout";
import { CourseCheck, checkCourses } from "./courses";

export default class StelePullPlugin extends Plugin {
  settings: StelePullSettings = DEFAULT_SETTINGS;
  state: LocalState = emptyState();
  private statusEl?: HTMLElement;
  private intervalId?: number;
  /** One pull at a time: the interval must not stack on a slow sync. */
  private running = false;
  private status = "idle";
  private statusListeners = new Set<(text: string) => void>();
  /** The pull's progress through its downloads; null when none is writing files. */
  private progress: PullProgress | null = null;
  private progressListeners = new Set<(p: PullProgress | null) => void>();
  /** The last course ID lookup, so Setup can show it again after a re-render. */
  courseCheck?: { ids: number[]; results: CourseCheck[] };

  async onload() {
    const data = (await this.loadData()) as { settings?: StelePullSettings } | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.state = await loadState(this);

    this.addSettingTab(new StelePullSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_STELE_PULL, (leaf: WorkspaceLeaf) => new StelePullView(leaf, this));

    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");
    this.statusEl?.addEventListener("click", () => void this.activateView());

    // The panel is the plugin's main surface, so the ribbon icon opens it.
    this.addRibbonIcon("cloud-download", "stele-pull", () => void this.activateView());

    this.addCommand({
      id: "open-panel", name: "Open panel",
      callback: () => void this.activateView(),
    });
    this.addCommand({ id: "pull", name: "Pull now", callback: () => void this.pullAll({ manual: true }) });

    // Delay on load so plugin startup is not blocked by network.
    this.app.workspace.onLayoutReady(() => {
      this.registerInterval(window.setTimeout(() => void this.pullAll(), 10_000));
    });
    // Interval only. NEVER sync on vault file change: a mirror that reacts to
    // the user's own edits is how you get a feedback loop.
    this.rescheduleSync();
  }

  /** Reveal the panel, creating it in the right sidebar if it is not open. */
  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_STELE_PULL)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_STELE_PULL, active: true });
      // Only when the panel is first created, so a sidebar the user resizes
      // afterwards stays the size they chose.
      widenRightSidebar(this.app);
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  /** Settings changes must take effect without an Obsidian restart. */
  rescheduleSync() {
    if (this.intervalId !== undefined) window.clearInterval(this.intervalId);
    this.intervalId = window.setInterval(
      () => void this.pullAll(),
      this.settings.syncIntervalMinutes * 60_000,
    );
    this.registerInterval(this.intervalId);
  }

  async save() {
    await saveState(this, this.state, this.settings);
  }

  /**
   * @param opts.quiet - return null without a notice when setup is incomplete.
   *   Only a pull the user asked for should nag; the panel and automatic pulls
   *   explain themselves or stay silent.
   */
  makeSyncer(opts: { quiet?: boolean } = {}): Syncer | null {
    if (!this.settings.baseUrl) {
      if (!opts.quiet) new Notice("stele-pull: set the store URL in the panel's Setup section first");
      return null;
    }
    if (this.settings.courses.length === 0) {
      if (!opts.quiet) new Notice("stele-pull: add at least one course ID in the panel's Setup section");
      return null;
    }
    const store = new RemoteStore({ baseUrl: this.settings.baseUrl, bucket: this.settings.bucket });
    return new Syncer(this, store, this.settings.policy, this.state, this.settings);
  }

  /**
   * @param opts.manual - the user asked for this pull (button or command), so
   *   everything ticked in the panel is written. The automatic pulls on startup
   *   and on the interval only refresh files the vault already has.
   */
  async pullAll(opts: { manual?: boolean } = {}) {
    if (this.running) return;
    const mode = opts.manual === true ? "manual" : "automatic";
    const s = this.makeSyncer({ quiet: mode === "automatic" });
    if (!s) return;
    this.running = true;
    this.setStatus("syncing...");
    try {
      // One failing course must not abort the others: its previous state stays
      // live, which is the correct degraded outcome.
      const failed: number[] = [];
      for (const courseId of this.settings.courses) {
        try {
          const m = await s.fetchManifest(courseId);
          if (!m) continue;
          // An automatic pull has nothing to refresh until the worker publishes
          // a run this device has not seen.
          if (mode === "automatic" && !(await s.needsSync(m))) continue;
          notifyResult(await s.syncCourse(m, { mode, onProgress: this.progressFor(m) }));
        } catch (e) {
          failed.push(courseId);
          console.error(`stele-pull: course ${courseId} failed`, e);
        }
      }
      if (failed.length > 0) {
        this.setStatus(`sync failed: ${failed.join(", ")}`);
        new Notice(`stele-pull: ${failed.length} course(s) failed. See the console.`);
      } else {
        this.setStatus(`synced ${new Date().toLocaleTimeString()}`);
      }
    } finally {
      this.running = false;
      this.setProgress(null);
    }
  }

  /**
   * Pull one course's ticked files, for the panel's "Pull selected". Shares
   * pullAll's guard, so it cannot write the same files as a running pull.
   */
  async pullCourse(m: Manifest) {
    if (this.running) {
      new Notice("stele-pull: a pull is already running");
      return;
    }
    const s = this.makeSyncer();
    if (!s) return;
    this.running = true;
    this.setStatus("syncing...");
    try {
      notifyResult(await s.syncCourse(m, { mode: "manual", onProgress: this.progressFor(m) }));
      this.setStatus(`synced ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      this.setStatus(`sync failed: ${m.course_id}`);
      new Notice(`stele-pull: ${String(e)}`);
    } finally {
      this.running = false;
      this.setProgress(null);
    }
  }

  isPulling(): boolean {
    return this.running;
  }

  currentProgress(): PullProgress | null {
    return this.progress;
  }

  /** @returns an unsubscribe function; the panel calls it on close. */
  onProgress(cb: (p: PullProgress | null) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  /** Feeds a course's sync progress to the status bar and the panel. */
  private progressFor(m: Manifest): (p: SyncProgress) => void {
    const course = m.course_code ?? m.course_name;
    return (p) => {
      const pct = p.bytesTotal > 0 ? Math.floor((p.bytes / p.bytesTotal) * 100) : 100;
      this.setStatus(`pulling ${course}: ${p.files}/${p.filesTotal} files, ${pct}%`);
      this.setProgress({ ...p, course });
    };
  }

  private setProgress(p: PullProgress | null) {
    this.progress = p;
    for (const cb of this.progressListeners) cb(p);
  }

  /** Look each course ID up in the store, for the Setup form. Never raises a notice. */
  async checkCourses(ids: number[]): Promise<CourseCheck[]> {
    if (!this.settings.baseUrl) {
      return ids.map((id): CourseCheck => ({ id, status: "error", message: "set the store URL first" }));
    }
    const store = new RemoteStore({ baseUrl: this.settings.baseUrl, bucket: this.settings.bucket });
    const s = new Syncer(this, store, this.settings.policy, this.state, this.settings);
    return checkCourses(ids, (id) => s.fetchManifest(id));
  }

  currentStatus(): string {
    return this.status;
  }

  /** @returns an unsubscribe function; the panel calls it on close. */
  onStatus(cb: (text: string) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(text: string) {
    this.status = text;
    this.statusEl?.setText(`stele-pull: ${text}`);
    for (const cb of this.statusListeners) cb(text);
  }
}
