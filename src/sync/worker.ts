import { Mutation, SyncEventListener, SyncStatus, WalBatch } from "@/types";
import { GoogleDriveClient } from "@/sync/gdrive";

export interface SyncWorkerOptions<T> {
  debounceMs: number;
  clientId: string;
  driveClient?: GoogleDriveClient<T> | null;
  getPendingMutations: () => Promise<Mutation<T>[]>;
  clearPendingMutations: () => Promise<void>;
  markRecordsSynced: (ids: string[]) => Promise<void>;
  channelName?: string;
  enableBroadcastChannel?: boolean;
}

export class SyncWorker<T = Record<string, unknown>> {
  private debounceMs: number;
  private clientId: string;
  private driveClient: GoogleDriveClient<T> | null = null;
  private getPendingMutations: () => Promise<Mutation<T>[]>;
  private clearPendingMutations: () => Promise<void>;
  private markRecordsSynced: (ids: string[]) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private listeners: Set<SyncEventListener> = new Set();
  private broadcastChannel: BroadcastChannel | null = null;

  constructor(options: SyncWorkerOptions<T>) {
    this.debounceMs = options.debounceMs;
    this.clientId = options.clientId;
    this.driveClient = options.driveClient || null;
    this.getPendingMutations = options.getPendingMutations;
    this.clearPendingMutations = options.clearPendingMutations;
    this.markRecordsSynced = options.markRecordsSynced;

    if (options.enableBroadcastChannel !== false && typeof BroadcastChannel !== "undefined") {
      this.broadcastChannel = new BroadcastChannel(options.channelName || "drivedb_wal_channel");
    }

    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        void this.scheduleSync(0);
      });
    }
  }

  setDriveClient(client: GoogleDriveClient<T> | null): void {
    this.driveClient = client;
  }

  subscribe(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(status: SyncStatus, error?: Error, mutationsSynced?: number): void {
    const event = { status, timestamp: Date.now(), error, mutationsSynced };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  broadcastChange(type: "SET" | "DELETE" | "SYNC", id?: string): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({ type, id, timestamp: Date.now() });
    }
  }

  onBroadcast(callback: (msg: { type: string; id?: string }) => void): () => void {
    if (!this.broadcastChannel) return () => {};
    const handler = (event: MessageEvent) => callback(event.data);
    this.broadcastChannel.addEventListener("message", handler);
    return () => this.broadcastChannel?.removeEventListener("message", handler);
  }

  scheduleSync(delayMs = this.debounceMs): void {
    if (!this.driveClient) return;

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.notify("pending");

    this.timer = setTimeout(() => {
      void this.flush();
    }, delayMs);
  }

  /**
   * Flushes pending local mutations as an append-only WAL batch to Google Drive.
   */
  async flush(): Promise<boolean> {
    if (this.isSyncing || !this.driveClient) return false;

    try {
      this.isSyncing = true;
      this.notify("syncing");

      const mutations = await this.getPendingMutations();
      if (mutations.length === 0) {
        this.notify("synced", undefined, 0);
        return true;
      }

      const now = Date.now();
      const batch: WalBatch<T> = {
        batchId: `b_${now}_${Math.random().toString(36).substring(2, 7)}`,
        clientId: this.clientId,
        timestamp: now,
        mutations,
      };

      // 1. Upload immutable WAL batch
      await this.driveClient.uploadWalBatch(batch);

      // 2. Clear outbox queue
      await this.clearPendingMutations();

      // 3. Update records to synced
      const ids = mutations.map((m) => m.id);
      await this.markRecordsSynced(ids);

      this.notify("synced", undefined, mutations.length);
      this.broadcastChange("SYNC");
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.notify("error", error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
    this.listeners.clear();
  }
}
