import {
  Document,
  DriveDbOptions,
  ExportPayload,
  Mutation,
  ReconciliationResult,
  SetOptions,
  StoredRecord,
  SyncEventListener,
  WalBatch,
} from "@/types";
import { IndexedDbStorage } from "@/storage/indexeddb";
import { GoogleDriveClient } from "@/sync/gdrive";
import { SyncWorker } from "@/sync/worker";
import { WalEngine } from "@/wal/engine";

export class DriveDB<T = Record<string, unknown>> {
  private options: Required<Omit<DriveDbOptions, "accessToken" | "clientId" | "gdriveFolderId">> & {
    accessToken?: string | (() => string | null | Promise<string | null>);
    clientId: string;
    gdriveFolderId?: string;
  };
  private storage: IndexedDbStorage<T>;
  private driveClient: GoogleDriveClient<T> | null = null;
  private worker: SyncWorker<T>;
  private cache: Map<string, StoredRecord<T>> = new Map();
  private mutationSeq = 0;
  private isInitialized = false;

  constructor(options: DriveDbOptions = {}) {
    const generatedClientId =
      options.clientId ||
      `client_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;

    // Resolve client-decided or uniquely scoped folder name
    const shortUuid = Math.random().toString(36).substring(2, 7);
    let resolvedFolderName: string;
    if (options.gdriveFolderName) {
      resolvedFolderName = options.appendFolderUuid
        ? `${options.gdriveFolderName}_${shortUuid}`
        : options.gdriveFolderName;
    } else {
      // Auto-generated name is strictly scoped to the dbName to prevent cross-app collisions
      const baseName = options.dbName ? `${options.dbName}_drivedb` : "app_drivedb";
      resolvedFolderName = `${baseName}_${shortUuid}`;
    }

    this.options = {
      dbName: options.dbName || "drivedb_store",
      tableName: options.tableName || "documents",
      syncDebounceMs: options.syncDebounceMs ?? 1000,
      autoSync: options.autoSync ?? true,
      gdriveFolderName: resolvedFolderName,
      gdriveFolderId: options.gdriveFolderId,
      appendFolderUuid: options.appendFolderUuid ?? false,
      walFolderName: options.walFolderName || "wal",
      snapshotFileName: options.snapshotFileName || "snapshot.json",
      maxUncompactedLogs: options.maxUncompactedLogs ?? 50,
      enableBroadcastChannel: options.enableBroadcastChannel ?? true,
      requestPersistence: options.requestPersistence ?? true,
      clientId: generatedClientId,
      accessToken: options.accessToken,
    };

    this.storage = new IndexedDbStorage<T>(this.options.dbName, this.options.tableName);

    if (this.options.accessToken) {
      const tokenFn =
        typeof this.options.accessToken === "function"
          ? this.options.accessToken
          : () => (this.options.accessToken as string) || null;

      this.driveClient = new GoogleDriveClient<T>({
        folderName: this.options.gdriveFolderName,
        folderId: this.options.gdriveFolderId,
        walFolderName: this.options.walFolderName,
        snapshotFileName: this.options.snapshotFileName,
        getToken: tokenFn,
        onFolderResolved: async (folderId) => {
          this.options.gdriveFolderId = folderId;
          await this.storage.setMeta("gdrive_folder_id", folderId);
        },
      });
    }

    this.worker = new SyncWorker<T>({
      debounceMs: this.options.syncDebounceMs,
      clientId: this.options.clientId,
      driveClient: this.driveClient,
      getPendingMutations: async () => {
        return this.storage.getPendingMutations();
      },
      clearPendingMutations: async () => {
        await this.storage.clearPendingMutations();
      },
      markRecordsSynced: async (ids: string[]) => {
        const records = await this.storage.getAll();
        const updatedRecords: StoredRecord<T>[] = [];

        for (const r of records) {
          if (ids.includes(r.id) && r.syncStatus !== "synced") {
            r.syncStatus = "synced";
            this.cache.set(r.id, r);
            updatedRecords.push(r);
          }
        }

        if (updatedRecords.length > 0) {
          await this.storage.putMany(updatedRecords);
        }
      },
      channelName: `drivedb_${this.options.dbName}_${this.options.tableName}`,
      enableBroadcastChannel: this.options.enableBroadcastChannel,
    });

    // Cross-tab synchronization listener
    this.worker.onBroadcast(async () => {
      await this.reloadFromStorage();
    });
  }

  /**
   * Initializes the database, hydrates memory from IndexedDB, and optionally syncs with Google Drive.
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    await this.storage.init(this.options.requestPersistence);
    await this.reloadFromStorage();

    // Hydrate persisted Google Drive folder ID from previous sessions if not explicitly set
    if (!this.options.gdriveFolderId) {
      const persistedFolderId = (await this.storage.getMeta("gdrive_folder_id")) as string | null;
      if (persistedFolderId) {
        this.options.gdriveFolderId = persistedFolderId;
        this.driveClient?.setFolderId(persistedFolderId);
      }
    }

    this.isInitialized = true;

    // Trigger initial background sync if connected and enabled
    if (this.driveClient && this.options.autoSync) {
      void this.sync();
    }
  }

  /**
   * Returns the resolved Google Drive folder ID, if known.
   */
  getGdriveFolderId(): string | undefined {
    return this.options.gdriveFolderId;
  }

  /**
   * Explicitly sets a Google Drive folder ID (e.g. chosen from Google Drive Picker).
   */
  async setGdriveFolderId(folderId: string): Promise<void> {
    this.options.gdriveFolderId = folderId;
    this.driveClient?.setFolderId(folderId);
    await this.storage.setMeta("gdrive_folder_id", folderId);
  }

  /**
   * Sets or updates Google OAuth access token dynamically.
   */
  setAccessToken(token: string | (() => string | null | Promise<string | null>) | null): void {
    if (!token) {
      this.driveClient = null;
      this.worker.setDriveClient(null);
      return;
    }

    const tokenFn = typeof token === "function" ? token : () => token;
    this.driveClient = new GoogleDriveClient<T>({
      folderName: this.options.gdriveFolderName,
      folderId: this.options.gdriveFolderId,
      walFolderName: this.options.walFolderName,
      snapshotFileName: this.options.snapshotFileName,
      getToken: tokenFn,
      onFolderResolved: async (folderId) => {
        this.options.gdriveFolderId = folderId;
        await this.storage.setMeta("gdrive_folder_id", folderId);
      },
    });

    this.worker.setDriveClient(this.driveClient);
  }

  /**
   * Reloads local memory cache from IndexedDB.
   */
  private async reloadFromStorage(): Promise<void> {
    const allRecords = await this.storage.getAll();
    this.cache.clear();
    for (const record of allRecords) {
      this.cache.set(record.id, record);
    }
  }

  /**
   * Synchronous 0ms retrieval of an active document from memory cache.
   */
  get(id: string): Document<T> | null {
    const record = this.cache.get(id);
    if (!record || record.isDeleted) return null;
    return {
      id: record.id,
      data: record.data,
      updatedAt: record.updatedAt,
      syncStatus: record.syncStatus,
    };
  }

  /**
   * Sets a document. Appends a mutation to the local WAL and updates materialized state.
   */
  async set(id: string, data: T, options?: SetOptions): Promise<Document<T>> {
    const timestamp = options?.timestamp || Date.now();
    const syncStatus = options?.syncStatus || "pending";
    const seq = ++this.mutationSeq;

    const mutation: Mutation<T> = {
      op: "SET",
      id,
      data,
      timestamp,
      clientId: this.options.clientId,
      seq,
    };

    // 1. Instant in-memory update using LWW
    WalEngine.applyMutation(this.cache, mutation, syncStatus);
    const updatedRecord = this.cache.get(id)!;

    // 2. Persist to materialized IndexedDB store
    await this.storage.put(updatedRecord);

    // 3. Append to local WAL outbox (unless marked already synced)
    if (syncStatus === "pending") {
      await this.storage.appendMutation(mutation);
    }

    // 4. Notify cross-tab channels
    this.worker.broadcastChange("SET", id);

    // 5. Schedule debounced Google Drive sync
    if (this.options.autoSync && syncStatus === "pending") {
      this.worker.scheduleSync();
    }

    return {
      id: updatedRecord.id,
      data: updatedRecord.data,
      updatedAt: updatedRecord.updatedAt,
      syncStatus: updatedRecord.syncStatus,
    };
  }

  /**
   * Deletes a document by registering a DELETE mutation in the local WAL.
   */
  async delete(id: string): Promise<boolean> {
    const existing = this.cache.get(id);
    if (!existing || existing.isDeleted) return false;

    const timestamp = Date.now();
    const seq = ++this.mutationSeq;

    const mutation: Mutation<T> = {
      op: "DELETE",
      id,
      timestamp,
      clientId: this.options.clientId,
      seq,
    };

    // 1. Instant in-memory update using LWW
    WalEngine.applyMutation(this.cache, mutation, "pending");
    const updatedRecord = this.cache.get(id)!;

    // 2. Persist tombstone to IndexedDB
    await this.storage.put(updatedRecord);

    // 3. Append to local WAL outbox
    await this.storage.appendMutation(mutation);

    // 4. Notify cross-tab channels
    this.worker.broadcastChange("DELETE", id);

    // 5. Schedule debounced sync
    if (this.options.autoSync) {
      this.worker.scheduleSync();
    }

    return true;
  }

  /**
   * Returns all active non-deleted documents.
   */
  list(): Document<T>[] {
    const results: Document<T>[] = [];
    for (const record of this.cache.values()) {
      if (!record.isDeleted) {
        results.push({
          id: record.id,
          data: record.data,
          updatedAt: record.updatedAt,
          syncStatus: record.syncStatus,
        });
      }
    }
    return results;
  }

  /**
   * Queries documents with a filter predicate.
   */
  query(predicate: (doc: Document<T>) => boolean): Document<T>[] {
    return this.list().filter(predicate);
  }

  /**
   * Finds the first document matching a predicate.
   */
  find(predicate: (doc: Document<T>) => boolean): Document<T> | null {
    const all = this.list();
    for (const doc of all) {
      if (predicate(doc)) return doc;
    }
    return null;
  }

  /**
   * Replays an array of WAL batches in deterministic timestamp order.
   */
  async reconcileBatches(batches: WalBatch<T>[]): Promise<ReconciliationResult> {
    const result = WalEngine.replayBatches(this.cache, batches);

    // Persist all updated records to IndexedDB
    const recordsToPersist: StoredRecord<T>[] = [];
    for (const id of [...result.updatedIds, ...result.deletedIds]) {
      const rec = this.cache.get(id);
      if (rec) {
        recordsToPersist.push(rec);
      }
    }

    if (recordsToPersist.length > 0) {
      await this.storage.putMany(recordsToPersist);
    }

    return result;
  }

  /**
   * Executes two-way WAL synchronization with Google Drive:
   * 1. Downloads and replays remote WAL batches created after last sync.
   * 2. Flushes pending local mutations as an append-only WAL batch to `wal/`.
   * 3. Triggers snapshot compaction if WAL file count exceeds threshold.
   */
  async sync(): Promise<boolean> {
    if (!this.driveClient) return false;

    try {
      // 1. Check last synced remote timestamp
      const lastSyncedTime = ((await this.storage.getMeta("lastRemoteSyncTimestamp")) as number) || 0;

      // 2. Fetch new remote WAL batches from Google Drive
      const remoteWalFiles = await this.driveClient.listWalFilesSince(lastSyncedTime);

      if (remoteWalFiles.length > 0) {
        const downloadedBatches: WalBatch<T>[] = [];
        for (const file of remoteWalFiles) {
          const batch = await this.driveClient.downloadWalBatch(file.id);
          if (batch) {
            downloadedBatches.push(batch);
          }
        }

        if (downloadedBatches.length > 0) {
          await this.reconcileBatches(downloadedBatches);
        }

        // Update last synced remote timestamp
        await this.storage.setMeta("lastRemoteSyncTimestamp", Date.now());
      }

      // 3. Flush pending local mutations as an append-only WAL batch
      const flushSuccess = await this.worker.flush();

      // 4. Compaction check: If remote WAL files exceed threshold, create snapshot
      if (remoteWalFiles.length >= this.options.maxUncompactedLogs) {
        await this.compact();
      }

      return flushSuccess;
    } catch (err) {
      return false;
    }
  }

  /**
   * Consolidates current database state into a single `snapshot.json` and purges older WAL files.
   */
  async compact(): Promise<string | null> {
    if (!this.driveClient) return null;

    try {
      const allRecords = await this.storage.getAll();
      const snapshot = WalEngine.createSnapshot(allRecords);

      // Upload snapshot to Google Drive
      const snapshotId = await this.driveClient.uploadSnapshot(snapshot);

      // Clean up remote WAL files created before snapshot timestamp
      const oldFiles = await this.driveClient.listWalFilesSince(0);
      const toDeleteIds = oldFiles
        .filter((f) => new Date(f.modifiedTime).getTime() <= snapshot.lastCompactedTimestamp)
        .map((f) => f.id);

      if (toDeleteIds.length > 0) {
        await this.driveClient.deleteWalFiles(toDeleteIds);
      }

      return snapshotId;
    } catch {
      return null;
    }
  }

  /**
   * Subscribes to synchronization status changes.
   */
  onSyncChange(listener: SyncEventListener): () => void {
    return this.worker.subscribe(listener);
  }

  /**
   * Exports entire table state as a standalone JSON string.
   */
  async exportJson(): Promise<string> {
    const records = await this.storage.getAll();
    const payload: ExportPayload<T> = {
      version: 1,
      tableName: this.options.tableName,
      exportedAt: Date.now(),
      records,
    };
    return JSON.stringify(payload, null, 2);
  }

  /**
   * Imports records from a JSON string.
   */
  async importJson(jsonString: string): Promise<number> {
    const payload = JSON.parse(jsonString) as ExportPayload<T>;
    if (!payload.records || !Array.isArray(payload.records)) {
      throw new Error("Invalid DriveDB export JSON payload.");
    }

    for (const rec of payload.records) {
      this.cache.set(rec.id, rec);
    }
    await this.storage.putMany(payload.records);
    return payload.records.length;
  }

  /**
   * Helper for tests to inspect underlying persistent record (including tombstones).
   */
  async getPersistedRecord(id: string): Promise<StoredRecord<T> | null> {
    return this.storage.get(id);
  }

  /**
   * Helper for tests to inspect outbox pending mutations.
   */
  async getPendingMutations(): Promise<Mutation<T>[]> {
    return this.storage.getPendingMutations();
  }

  /**
   * Closes database and sync workers.
   */
  async close(): Promise<void> {
    this.worker.close();
    await this.storage.close();
    this.cache.clear();
    this.isInitialized = false;
  }
}
