import { Mutation, ReconciliationResult, Snapshot, StoredRecord, WalBatch } from "@/types";

export class WalEngine<T = Record<string, unknown>> {
  /**
   * Applies a single mutation to the in-memory cache using Last-Write-Wins (LWW).
   * Returns true if the state was updated, false if the mutation was stale.
   */
  static applyMutation<T>(
    cache: Map<string, StoredRecord<T>>,
    mutation: Mutation<T>,
    syncStatus: StoredRecord<T>["syncStatus"] = "synced"
  ): boolean {
    const existing = cache.get(mutation.id);

    // Stale check: If local record has a strictly newer timestamp, skip
    if (existing && existing.updatedAt > mutation.timestamp) {
      return false;
    }

    if (mutation.op === "SET") {
      if (mutation.data === undefined) return false;
      const record: StoredRecord<T> = {
        id: mutation.id,
        data: mutation.data,
        updatedAt: mutation.timestamp,
        syncStatus,
        isDeleted: false,
      };
      cache.set(mutation.id, record);
      return true;
    }

    if (mutation.op === "DELETE") {
      const record: StoredRecord<T> = {
        id: mutation.id,
        data: (existing ? existing.data : {}) as T,
        updatedAt: mutation.timestamp,
        syncStatus,
        isDeleted: true,
      };
      cache.set(mutation.id, record);
      return true;
    }

    return false;
  }

  /**
   * Replays an array of WAL batches in deterministic timestamp order.
   */
  static replayBatches<T>(
    cache: Map<string, StoredRecord<T>>,
    batches: WalBatch<T>[]
  ): ReconciliationResult {
    // 1. Flatten all mutations
    const allMutations: Mutation<T>[] = [];
    for (const batch of batches) {
      if (Array.isArray(batch.mutations)) {
        allMutations.push(...batch.mutations);
      }
    }

    // 2. Sort deterministically by timestamp ascending, with seq tie-break
    allMutations.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return (a.seq || 0) - (b.seq || 0);
    });

    const updatedIds = new Set<string>();
    const deletedIds = new Set<string>();
    let appliedCount = 0;

    // 3. Sequentially apply mutations
    for (const m of allMutations) {
      const applied = this.applyMutation(cache, m, "synced");
      if (applied) {
        appliedCount++;
        if (m.op === "DELETE") {
          deletedIds.add(m.id);
          updatedIds.delete(m.id);
        } else {
          updatedIds.add(m.id);
          deletedIds.delete(m.id);
        }
      }
    }

    return {
      appliedCount,
      updatedIds: Array.from(updatedIds),
      deletedIds: Array.from(deletedIds),
    };
  }

  /**
   * Compacts active records and tombstones into a consolidated snapshot.
   */
  static createSnapshot<T>(
    records: StoredRecord<T>[],
    tombstoneRetentionMs: number = 30 * 24 * 60 * 60 * 1000
  ): Snapshot<T> {
    const now = Date.now();
    const cutoff = now - tombstoneRetentionMs;

    // Retain all active records, plus tombstones updated within retention window
    const compactedRecords = records.filter((r) => {
      if (!r.isDeleted) return true;
      return r.updatedAt >= cutoff;
    });

    return {
      snapshotId: `snap_${now}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: now,
      lastCompactedTimestamp: now,
      records: compactedRecords,
    };
  }
}
