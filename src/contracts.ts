/** Public values exchanged between the CommonJS sync engine and the native UI. */
export interface SyncConfig {
  appId: string; hasSecret: boolean; assigneeId: string; defaultTasklistGuid: string;
  storagePath: string; vaultId: string; vaultLabel: string; vaultTasklistName: string;
  areaNames: Record<string, string>; projectNames: Record<string, string>;
  projectFolder: string; dailyFolder: string; taskFolders: string[]; taskTags: string[];
  excludedFolders: string[]; syncDaily: boolean; autoEnabled: boolean;
  pollMinutes: number; configRevision: string; hierarchyEnabled: boolean;
}
export type ConfigInput = Partial<Omit<SyncConfig, 'taskFolders' | 'taskTags' | 'excludedFolders'>> & {
  secret?: string; taskFolders?: string | string[]; taskTags?: string | string[]; excludedFolders?: string | string[];
};
export interface TaskRecord {
  id?: string; path?: string; guid?: string | null; url?: string; state: string;
  message?: string; cancelPending?: boolean; lastSyncedAt?: string | number;
  legacyTasklistGuid?: string;
}
export interface Action {
  id?: string | null; vaultId?: string | null; path: string; line: number;
  status: string; done: boolean; text: string; heading?: string; raw: string;
  record: TaskRecord | null;
}
export interface NoteSnapshot {
  path: string; kind: 'project' | 'task' | 'daily'; isProject: boolean;
  tasks: Action[]; listRecord: TaskRecord | null; projectRecord: TaskRecord | null;
  areaName: string; projectStatus: string;
}
export interface SyncResultItem {
  ok: boolean; id?: string; path?: string; kind?: string; line?: number; name?: string; message?: string;
}
export type SyncFailure = Omit<SyncResultItem, 'ok'> & { appId?: string; revision?: number };
export interface SyncResult {
  synced: number; failed: number; skipped?: number; results: SyncResultItem[];
}
export interface AutoStatus {
  running: boolean; lastRunAt: number | null; lastError: string;
  summary: Pick<SyncResult, 'synced' | 'failed' | 'skipped'> | null; failures: SyncFailure[];
}
export interface Selection { path: string; line?: number }
export interface SyncIssue extends TaskRecord {
  key: string; kind: string; title: string; path: string; line?: number;
}
export interface ConflictTarget { id: string; path: string; title: string }
export type ConflictChoice = 'local' | 'remote';
export interface ConflictVersion { exists?: boolean; summary?: string; status?: string; done?: boolean }
export interface ConflictPreview {
  id: string; token: string; kind: string; local: ConflictVersion; remote: ConflictVersion;
  choices: Record<ConflictChoice, string>; baseline?: { done?: boolean; summary?: string } | null;
}
export interface ResourceRecovery { kind: string; key?: string; name: string; message?: string }
export interface RecoveryInput { kind: string; key?: string; guid: string }
export interface HierarchyStatus {
  enabled: boolean; recoveries: ResourceRecovery[];
  areas: { key: string; name: string; guid: string }[];
  projects: { id: string; path: string; name: string; guid: string }[];
  vaultList: { guid?: string; url?: string; message?: string } | null;
  migration: { state: string; message: string; legacyProjects: number; legacyTasks: number; archivePending: number };
}
export interface ScopePreview {
  projects: number; taskNotes: number; tasks: number; dailyTasks: number; scopeLabel: string; warnings: string[];
}
export interface TransferPreview {
  token: string; vaultId: string; vaultLabel: string; vaultTasklistName: string; vaultListGuid: string;
  projectFolder: string; dailyFolder: string; projects: number; tasks: number;
  remapped: number; missing: number; conflicts: number; warnings: string[];
}
export interface TaskOptions { due?: number; reminderMinutes?: number }
export interface FeishuService {
  getConfig(): SyncConfig;
  saveConfig(value: ConfigInput): SyncConfig;
  getHierarchyStatus(): HierarchyStatus;
  isCandidatePath(path: string): boolean;
  isBusy(): boolean;
  select(path: string, task?: { line?: number }): void;
  getSelection(): Selection | null;
  listNotes(): Promise<string[]>;
  readNote(path: string): Promise<NoteSnapshot>;
  getSyncIssues(failures?: SyncFailure[]): Promise<SyncIssue[]>;
  getTaskConflict(id: string): Promise<ConflictPreview>;
  resolveTaskConflict(id: string, choice: ConflictChoice, token: string): Promise<TaskRecord>;
  sendTask(task: Action, options: TaskOptions): Promise<TaskRecord>;
  syncTask(id: string): Promise<TaskRecord>;
  recoverTask(id: string, guid: string): Promise<TaskRecord>;
  syncAll(path: string): Promise<SyncResult>;
  syncProject(path: string): Promise<SyncResult>;
  syncVault(options?: { automatic?: boolean; paths?: string[]; shouldStop?: () => boolean }): Promise<SyncResult>;
  previewVault(): Promise<ScopePreview>;
  migrateVault(): Promise<SyncResult>;
  finalizeMigration(): Promise<SyncResult>;
  recoverHierarchyResource(value: RecoveryInput): Promise<unknown>;
  exportTransfer(): { config: { vaultLabel: string }; records: unknown };
  previewTransfer(input: unknown, folders: { projectFolder: string; dailyFolder: string }): Promise<TransferPreview>;
  importTransfer(token: string): Promise<{ backupPath: string }>;
  checkAssociations(): Promise<{ checked: number; failed: number; results: SyncResultItem[] }>;
  check(): Promise<{ message: string }>;
}
