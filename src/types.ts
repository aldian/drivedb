export type SyncStatus = "synced" | "pending" | "syncing" | "error";

export type MutationOp = "SET" | "DELETE";

export interface Mutation<T = Record<string, unknown>> {
  op: MutationOp;
  id: string;
  data?: T;
  timestamp: number;
  clientId: string;
  seq: number;
}

export interface WalBatch<T = Record<string, unknown>> {
  batchId: string;
  clientId: string;
  timestamp: number;
  mutations: Mutation<T>[];
}

export interface Snapshot<T = Record<string, unknown>> {
  snapshotId: string;
  timestamp: number;
  lastCompactedTimestamp: number;
  records: StoredRecord<T>[];
}

export interface StoredRecord<T = Record<string, unknown>> {
  id: string;
  data: T;
  updatedAt: number;
  syncStatus: SyncStatus;
  isDeleted: boolean;
  version?: number;
}

export interface Document<T = Record<string, unknown>> {
  id: string;
  data: T;
  updatedAt: number;
  syncStatus: SyncStatus;
}

export interface DriveDbOptions {
  /** Database name in IndexedDB (default: "drivedb_store") */
  dbName?: string;
  /** Table / Object store name (default: "documents") */
  tableName?: string;
  /** Debounce wait in milliseconds before uploading WAL to Google Drive (default: 1000) */
  syncDebounceMs?: number;
  /** Whether to automatically sync on writes when Google Drive is connected (default: true) */
  autoSync?: boolean;
  /** Google Drive designated folder name (default: "DriveDB Data") */
  gdriveFolderName?: string;
  /** Subfolder name for WAL batches in Google Drive (default: "wal") */
  walFolderName?: string;
  /** Snapshot file name in Google Drive (default: "snapshot.json") */
  snapshotFileName?: string;
  /** Max uncompacted WAL log files before generating a new snapshot (default: 50) */
  maxUncompactedLogs?: number;
  /** Enable cross-tab real-time updates via BroadcastChannel (default: true) */
  enableBroadcastChannel?: boolean;
  /** Request persistent storage from browser on init (default: true) */
  requestPersistence?: boolean;
  /** Client ID / Device identifier (auto-generated if omitted) */
  clientId?: string;
  /** Custom Google OAuth Access Token (or token provider function) */
  accessToken?: string | (() => string | null | Promise<string | null>);
}

export interface ReconciliationResult {
  appliedCount: number;
  updatedIds: string[];
  deletedIds: string[];
}

export interface ExportPayload<T = Record<string, unknown>> {
  version: number;
  tableName: string;
  exportedAt: number;
  records: StoredRecord<T>[];
}

export interface SetOptions {
  /** Override timestamp (useful for testing / migrations) */
  timestamp?: number;
  /** Mark as already synced */
  syncStatus?: SyncStatus;
}

export type SyncEventListener = (event: {
  status: SyncStatus;
  timestamp: number;
  error?: Error;
  mutationsSynced?: number;
}) => void;
