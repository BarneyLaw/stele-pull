import { App, PluginSettingTab, Setting, Plugin, setIcon } from "obsidian";
import { Policy, validate } from "./policy";
import { CourseCheck, parseCourseIds, sameIds } from "./courses";
import type { CanvasCourse } from "./canvas";

/**
 * Where files are read from: a stele-pull store the worker fills, or Canvas
 * itself, for anyone who cannot host a store.
 */
export type SourceKind = "store" | "canvas";

/**
 * SecretStorage id of the Canvas access token. The token is never a setting:
 * settings go to data.json, inside the vault, synced wherever the vault is.
 */
export const CANVAS_TOKEN_SECRET = "stele-pull-canvas-token";

export interface StelePullSettings {
  source: SourceKind;
  baseUrl: string;
  bucket: string;
  /** Direct mode only, e.g. https://canvas.nus.edu.sg. */
  canvasUrl: string;
  courses: number[];
  targetFolder: string;
  trashFolder: string;
  conflictFolder: string;
  syncIntervalMinutes: number;
  /** CONSUMER rules: reversible, per-device, so they can be aggressive. */
  policy: Policy;
}

export const DEFAULT_SETTINGS: StelePullSettings = {
  source: "store",
  baseUrl: "",
  bucket: "stele-pull",
  canvasUrl: "",
  courses: [],
  targetFolder: "Canvas",
  trashFolder: "Canvas/_trash",
  conflictFolder: "Canvas/_conflicts",
  syncIntervalMinutes: 60,
  policy: {
    version: 1,
    default: "include",
    rules: [
      // Mobile-friendly default. Reversible with a checkbox, which is exactly
      // why aggressive filtering belongs here and not in the worker.
      { name: "no-huge", priority: 10, action: "skip", match: { min_size: 50 * 1024 * 1024 } },
    ],
  },
};

export type StelePullPluginLike = Plugin & {
  settings: StelePullSettings;
  save(): Promise<void>;
  rescheduleSync(): void;
  /** Look each course ID up in the source. */
  checkCourses(ids: number[]): Promise<CourseCheck[]>;
  /** Whether there is a source to read and a course to read from it. */
  ready(): boolean;
  canvasToken(): string | null;
  setCanvasToken(token: string | null): void;
  canvasCourses(): Promise<CanvasCourse[]>;
  /** The last lookup, so its report survives the panel re-rendering. */
  courseCheck?: { ids: number[]; results: CourseCheck[] };
};

const COURSES_DESC: Record<SourceKind, string> = {
  store:
    "Comma-separated numeric Canvas course IDs, e.g. 93794. The store is keyed by ID, " +
    "not course code: run stele-pull ls or stele-pull-worker courses to list them.",
  canvas:
    "Comma-separated numeric Canvas course IDs, e.g. 93794: the number in the course's " +
    "Canvas address. Show my courses, above, lists them.",
};
const RULES_DESC =
  "Applied to the manifest locally. Reversible: changing these never needs a refetch.";

/**
 * The configuration form, rendered into whatever container it is given.
 *
 * Both the settings tab and the sidebar panel's Setup section call this, so the
 * two surfaces cannot drift apart. `Setting` only needs an HTMLElement, so
 * nothing here is tab-specific.
 *
 * @param onCoursesChanged - lets the panel re-fetch when the course list moves.
 */
export function renderSettings(
  containerEl: HTMLElement,
  plugin: StelePullPluginLike,
  onCoursesChanged?: () => void,
) {
  // Switching source changes which fields apply, so draw the form again.
  const redraw = () => {
    containerEl.empty();
    renderSettings(containerEl, plugin, onCoursesChanged);
    onCoursesChanged?.();
  };

  new Setting(containerEl).setName("Source").setHeading();

  new Setting(containerEl)
    .setName("Read files from")
    .setDesc(
      "A stele-pull store that the worker fills on a schedule, or Canvas directly " +
      "if you have no store of your own.",
    )
    .addDropdown((d) =>
      d
        .addOption("store", "Your stele-pull store")
        .addOption("canvas", "Canvas directly")
        .setValue(plugin.settings.source)
        .onChange(async (v) => {
          plugin.settings.source = v === "canvas" ? "canvas" : "store";
          plugin.courseCheck = undefined;
          await plugin.save();
          redraw();
        }),
    );

  if (plugin.settings.source === "canvas") renderCanvasSource(containerEl, plugin, redraw);
  else renderStoreSource(containerEl, plugin);

  // Without this the plugin has nothing to pull and no way to be told what to
  // pull. It is the one setting that cannot be defaulted.
  //
  // Typing only checks the format, quietly: nothing is saved, nothing reloads,
  // no notices. Saving on every keystroke reloaded the whole panel, which
  // closed this form and raised "add a course ID" while the field was empty.
  // Enter, or leaving the field, saves the list and looks each ID up.
  const coursesDesc = COURSES_DESC[plugin.settings.source];
  const courses = new Setting(containerEl).setName("Course IDs").setDesc(coursesDesc);
  const report = containerEl.createDiv({ cls: "stele-pull-course-report" });
  const cached = plugin.courseCheck;
  if (cached && sameIds(cached.ids, plugin.settings.courses)) {
    renderCourseReport(report, cached.results, [], plugin.settings.source);
  }

  courses.addText((t) => {
    t.setPlaceholder("93794, 77826").setValue(plugin.settings.courses.join(", "));
    t.onChange((v) => {
      const { bad } = parseCourseIds(v);
      courses.setDesc(
        bad.length > 0 ? `Not a course ID: ${bad.join(", ")}. Use numbers separated by commas.` : coursesDesc,
      );
      courses.descEl.toggleClass("stele-pull-error", bad.length > 0);
    });
    t.inputEl.addEventListener("change", () => {
      void (async () => {
        const { ids, bad } = parseCourseIds(t.getValue());
        const changed = !sameIds(ids, plugin.settings.courses);
        if (changed) {
          plugin.settings.courses = ids;
          await plugin.save();
        }
        report.empty();
        if (ids.length === 0) {
          plugin.courseCheck = undefined;
          renderCourseReport(report, [], bad, plugin.settings.source);
        } else {
          report.createDiv({
            cls: "stele-pull-muted",
            text: plugin.settings.source === "canvas" ? "Checking Canvas..." : "Checking the store...",
          });
          const results = await plugin.checkCourses(ids);
          plugin.courseCheck = { ids, results };
          renderCourseReport(report, results, bad, plugin.settings.source);
        }
        // Reload the panel once, and only if the list really changed.
        if (changed) onCoursesChanged?.();
      })();
    });
  });

  new Setting(containerEl).setName("Folders").setHeading();

  new Setting(containerEl)
    .setName("Target folder")
    .setDesc(
      "Keep the mirror in its own top-level folder. Hundreds of PDFs will " +
      "trigger an Obsidian reindex, so add this folder to Excluded Files in " +
      "Obsidian's own settings if search gets noisy.",
    )
    .addText((t) =>
      t.setValue(plugin.settings.targetFolder).onChange(async (v) => {
        plugin.settings.targetFolder = v.trim();
        await plugin.save();
      }),
    );

  new Setting(containerEl)
    .setName("Trash folder")
    .setDesc("Where files go when Canvas removes them. Never hard deleted.")
    .addText((t) =>
      t.setValue(plugin.settings.trashFolder).onChange(async (v) => {
        plugin.settings.trashFolder = v.trim();
        await plugin.save();
      }),
    );

  new Setting(containerEl)
    .setName("Conflict folder")
    .setDesc(
      "Where a locally-edited file goes instead of being overwritten. " +
      "One-way sync is not a licence to destroy local data.",
    )
    .addText((t) =>
      t.setValue(plugin.settings.conflictFolder).onChange(async (v) => {
        plugin.settings.conflictFolder = v.trim();
        await plugin.save();
      }),
    );

  new Setting(containerEl).setName("Sync").setHeading();

  new Setting(containerEl)
    .setName("Sync interval (minutes)")
    .setDesc("Minimum 5. Takes effect immediately.")
    .addText((t) =>
      t.setValue(String(plugin.settings.syncIntervalMinutes)).onChange(async (v) => {
        plugin.settings.syncIntervalMinutes = Math.max(5, Number(v) || 60);
        await plugin.save();
        // Otherwise the old interval keeps firing until Obsidian restarts.
        plugin.rescheduleSync();
      }),
    );

  // TODO: rule editor UI. Until then, JSON textarea. The engine is already
  // correct and shared with Go, so this is presentation only.
  const rules = new Setting(containerEl)
    .setName("Exclusion rules (JSON)")
    .setDesc(RULES_DESC);
  // Valid rules are saved as you type, but the panel reloads only once you
  // leave the field, for the same reason as the course IDs.
  let rulesChanged = false;
  rules.addTextArea((t) => {
    t.inputEl.addEventListener("change", () => {
      if (!rulesChanged) return;
      rulesChanged = false;
      onCoursesChanged?.();
    });
    return t.setValue(JSON.stringify(plugin.settings.policy, null, 2)).onChange(async (v) => {
      let parsed: Policy;
      try {
        parsed = JSON.parse(v) as Policy;
      } catch {
        rules.setDesc("Invalid JSON. The previous rules are still in effect.");
        rules.descEl.addClass("stele-pull-error");
        return;
      }
      // Parsing is not enough: an empty match silently swallows everything,
      // which is what `default` is for. Reject it here rather than at preview.
      const err = validate(parsed);
      if (err) {
        rules.setDesc(`Invalid rules: ${err}. The previous rules are still in effect.`);
        rules.descEl.addClass("stele-pull-error");
        return;
      }
      rules.setDesc(RULES_DESC);
      rules.descEl.removeClass("stele-pull-error");
      plugin.settings.policy = parsed;
      await plugin.save();
      rulesChanged = true;
    });
  });
}

function renderStoreSource(containerEl: HTMLElement, plugin: StelePullPluginLike) {
  new Setting(containerEl)
    .setName("Store URL")
    .setDesc(
      "Read-only endpoint for the stele-pull bucket. Prefer an endpoint already " +
      "protected at the network layer (Tailscale, auth proxy) so no credentials " +
      "are stored in the vault. For local development, run stele-pull serve and " +
      "use http://127.0.0.1:8765.",
    )
    .addText((t) =>
      t
        .setPlaceholder("https://stele-pull.tailnet.ts.net")
        .setValue(plugin.settings.baseUrl)
        .onChange(async (v) => {
          plugin.settings.baseUrl = v.trim();
          await plugin.save();
        }),
    );

  new Setting(containerEl)
    .setName("Bucket")
    .setDesc(
      "Path segment between the URL and the store keys. Leave empty if the URL " +
      "already points at the bucket root; stele-pull serve accepts either.",
    )
    .addText((t) =>
      t.setValue(plugin.settings.bucket).onChange(async (v) => {
        plugin.settings.bucket = v.trim();
        await plugin.save();
      }),
    );
}

const TOKEN_DESC =
  "Treated like a password. Create one in Canvas under Account, Settings, New access " +
  "token, and give it an expiry date. It is kept in this device's Obsidian keychain, " +
  "not in the vault or its settings file, so it is never synced: enter it on each device.";

function renderCanvasSource(containerEl: HTMLElement, plugin: StelePullPluginLike, redraw: () => void) {
  new Setting(containerEl)
    .setName("Canvas URL")
    .setDesc("Your institution's Canvas address.")
    .addText((t) =>
      t
        .setPlaceholder("https://canvas.nus.edu.sg")
        .setValue(plugin.settings.canvasUrl)
        .onChange(async (v) => {
          plugin.settings.canvasUrl = v.trim().replace(/\/+$/, "");
          await plugin.save();
        }),
    );

  const token = new Setting(containerEl).setName("Canvas access token").setDesc(TOKEN_DESC);
  token.addText((t) => {
    // Masked as it is typed, and never filled back in: the stored token does
    // not appear in the page at all, only whether there is one.
    t.inputEl.type = "password";
    t.inputEl.autocomplete = "off";
    t.inputEl.spellcheck = false;
    t.setPlaceholder(plugin.canvasToken() ? "Saved. Paste a new token to replace it" : "Paste your token");
    // Saved on Enter or leaving the field, not per keystroke.
    t.inputEl.addEventListener("change", () => {
      const v = t.getValue().trim();
      if (!v) return;
      plugin.setCanvasToken(v);
      t.setValue("");
      redraw();
    });
  });
  if (plugin.canvasToken()) {
    token.addExtraButton((b) =>
      b.setIcon("trash").setTooltip("Forget the token on this device").onClick(() => {
        plugin.setCanvasToken(null);
        redraw();
      }),
    );
  }

  // Direct users have no worker to ask for course IDs, so Canvas lists them.
  new Setting(containerEl)
    .setName("Your courses")
    .setDesc("Courses you are enrolled in this term, with their IDs.")
    .addButton((b) =>
      b.setButtonText("Show my courses").onClick(() => {
        void (async () => {
          list.empty();
          list.createDiv({ cls: "stele-pull-muted", text: "Asking Canvas..." });
          try {
            renderCanvasCourses(list, await plugin.canvasCourses(), plugin, redraw);
          } catch (e) {
            list.empty();
            list.createDiv({ cls: "stele-pull-error", text: e instanceof Error ? e.message : String(e) });
          }
        })();
      }),
    );
  const list = containerEl.createDiv({ cls: "stele-pull-course-report" });
}

/** Each course with an Add button, or a tick once it is in the list. */
function renderCanvasCourses(
  el: HTMLElement,
  courses: CanvasCourse[],
  plugin: StelePullPluginLike,
  redraw: () => void,
) {
  el.empty();
  if (courses.length === 0) {
    el.createDiv({ cls: "stele-pull-muted", text: "Canvas lists no active courses for this account." });
    return;
  }
  for (const c of courses) {
    const row = el.createDiv({ cls: "stele-pull-course-report-row" });
    row.createSpan({ text: `${c.id}: ${c.name ?? c.course_code ?? ""}` });
    if (plugin.settings.courses.includes(c.id)) {
      setIcon(row.createSpan({ cls: "stele-pull-course-report-icon stele-pull-ok" }), "check");
      continue;
    }
    const add = row.createEl("button", { text: "Add" });
    add.addEventListener("click", () => {
      void (async () => {
        plugin.settings.courses = [...plugin.settings.courses, c.id];
        plugin.courseCheck = undefined;
        await plugin.save();
        redraw();
      })();
    });
  }
}

/** One line per course ID: found with its name, not found, or not checkable. */
function renderCourseReport(el: HTMLElement, results: CourseCheck[], bad: string[], source: SourceKind) {
  el.empty();
  const line = (icon: string, cls: string, text: string) => {
    const row = el.createDiv({ cls: `stele-pull-course-report-row ${cls}` });
    setIcon(row.createSpan({ cls: "stele-pull-course-report-icon" }), icon);
    row.createSpan({ text });
  };
  for (const r of results) {
    switch (r.status) {
      case "found":
        line("check", "stele-pull-ok", `${r.id}: ${r.name}`);
        break;
      case "missing":
        line("x", "stele-pull-error", source === "canvas"
          ? `${r.id}: Canvas has no such course for this account. Check the ID.`
          : `${r.id}: not in the store. Check the ID, or run the worker for this course first.`);
        break;
      case "error":
        line("alert-triangle", "stele-pull-warning", `${r.id}: could not check (${r.message})`);
        break;
    }
  }
  for (const b of bad) line("x", "stele-pull-error", `"${b}" is not a course ID`);
}

export class StelePullSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: StelePullPluginLike) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    renderSettings(this.containerEl, this.plugin);
  }
}
