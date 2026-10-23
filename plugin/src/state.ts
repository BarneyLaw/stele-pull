import { Plugin } from "obsidian";

/**
 * Local record of what this device wrote. Lives in the plugin's data.json via
 * saveData(), NOT in the vault body.
 *
 * IMPORTANT: data.json sits inside .obsidian/plugins/stele-pull/ and is synced by
 * whatever else syncs your vault. Never put credentials here. See store.ts for
 * why the recommended transport needs none.
 *
 * It is also why sync.ts checks the FILE on disk rather than trusting the
 * absence of a record here: a second device gets the vault without the
 * data.json that describes it.
 */
export interface FileRecord {
  sha256: string;
  size: number;
  writtenAt: number;
  /**
   * The Canvas metadata of the version written. Direct-Canvas mode has no
   * hash to compare, so these are how it tells an unchanged file. Absent on
   * records written before they were kept; such a file is downloaded once
   * more and, if the bytes match, adopted without rewriting.
   */
  canvasId?: number;
  updatedAt?: string;
  modifiedAt?: string;
}

/** What this device wrote for one course. */
export interface CourseRecord {
  /**
   * The folder, under the target folder, the course's files were last placed
   * in. Lets a renamed folder be moved instead of downloaded again.
   */
  folder?: string;
  /** Manifest path -> record. */
  files: Record<string, FileRecord>;
  /**
   * Ticks the user changed in the panel, by manifest path: true to pull, false
   * to leave out. Kept until the file is pulled, so an untick survives restarts
   * and every automatic pull.
   */
  choices?: Record<string, boolean>;
}

export interface LocalState {
  version: 2;
  lastRunId: Record<string, string>; // courseId -> run_id
  courses: Record<string, CourseRecord>; // courseId -> what was written
  /**
   * Records from version 1, when every course shared the target folder and
   * files were keyed by path alone. The next sync of a course whose manifest
   * lists a path moves that file into the course's folder and takes the record.
   */
  legacyFiles: Record<string, FileRecord>;
}

export const emptyState = (): LocalState => ({ version: 2, lastRunId: {}, courses: {}, legacyFiles: {} });

interface StateV1 {
  version: 1;
  lastRunId?: Record<string, string>;
  files?: Record<string, FileRecord>;
}

export async function loadState(plugin: Plugin): Promise<LocalState> {
  const raw = (await plugin.loadData()) as { state?: StateV1 | Partial<LocalState> } | null;
  const s = raw?.state;
  if (s?.version === 1) {
    return { version: 2, lastRunId: s.lastRunId ?? {}, courses: {}, legacyFiles: s.files ?? {} };
  }
  if (s?.version !== 2) return emptyState();
  // Tolerate a half-written data.json rather than throwing during onload.
  return {
    version: 2,
    lastRunId: s.lastRunId ?? {},
    courses: s.courses ?? {},
    legacyFiles: s.legacyFiles ?? {},
  };
}

export async function saveState(plugin: Plugin, state: LocalState, settings: unknown) {
  await plugin.saveData({ state, settings });
}
