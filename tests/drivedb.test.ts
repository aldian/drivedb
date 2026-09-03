import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { DriveDB } from "@/drivedb";
import { WalEngine } from "@/wal/engine";
import { WalBatch, StoredRecord } from "@/types";

interface UserSetting {
  theme: "light" | "dark";
  fontSize: number;
  notifications: boolean;
}

describe("DriveDB: Append-Only Delta Log (WAL) Database Engine", () => {
  let db: DriveDB<UserSetting>;

  beforeEach(async () => {
    db = new DriveDB<UserSetting>({
      dbName: `wal_test_db_${Date.now()}_${Math.random()}`,
      tableName: "settings",
      syncDebounceMs: 50,
      autoSync: false,
      clientId: "test_device_alpha",
    });
    await db.init();
  });

  afterEach(async () => {
    await db.close();
  });

  describe("Scenario 1: Local Mutation Logging & Materialization", () => {
    it("should update in-memory state instantly and append mutation to local WAL outbox", async () => {
      const data: UserSetting = { theme: "dark", fontSize: 16, notifications: true };
      const doc = await db.set("user_pref", data);

      expect(doc.id).toBe("user_pref");
      expect(doc.data.theme).toBe("dark");
      expect(doc.syncStatus).toBe("pending");
      expect(doc.updatedAt).toBeGreaterThan(0);

      // Instant 0ms memory retrieval
      const cached = db.get("user_pref");
      expect(cached).toBeDefined();
      expect(cached?.data.fontSize).toBe(16);

      // Materialized record in IndexedDB
      const persistent = await db.getPersistedRecord("user_pref");
      expect(persistent).toBeDefined();
      expect(persistent?.data.theme).toBe("dark");

      // Verify mutation queued in local WAL outbox
      const pendingMutations = await db.getPendingMutations();
      expect(pendingMutations.length).toBe(1);
      expect(pendingMutations[0].op).toBe("SET");
      expect(pendingMutations[0].id).toBe("user_pref");
      expect(pendingMutations[0].clientId).toBe("test_device_alpha");
      expect(pendingMutations[0].data?.theme).toBe("dark");
    });

    it("should query and list active non-deleted documents", async () => {
      await db.set("doc_1", { theme: "dark", fontSize: 12, notifications: false });
      await db.set("doc_2", { theme: "light", fontSize: 14, notifications: true });

      const all = db.list();
      expect(all.length).toBe(2);

      const darkOnes = db.query((d) => d.data.theme === "dark");
      expect(darkOnes.length).toBe(1);
      expect(darkOnes[0].id).toBe("doc_1");
    });
  });

  describe("Scenario 2: Tombstone Mutation Deletion", () => {
    it("should append a DELETE mutation to the WAL instead of immediately purging data", async () => {
      await db.set("temp_doc", { theme: "light", fontSize: 12, notifications: true });
      expect(db.get("temp_doc")).toBeDefined();

      const deleted = await db.delete("temp_doc");
      expect(deleted).toBe(true);

      // In-memory active lookup returns null
      expect(db.get("temp_doc")).toBeNull();

      // Underlying record has isDeleted: true
      const persisted = await db.getPersistedRecord("temp_doc");
      expect(persisted?.isDeleted).toBe(true);

      // WAL outbox contains both SET and DELETE mutations
      const mutations = await db.getPendingMutations();
      expect(mutations.length).toBe(2);
      expect(mutations[1].op).toBe("DELETE");
      expect(mutations[1].id).toBe("temp_doc");
    });
  });

  describe("Scenario 3: Deterministic WAL Replay Across Devices", () => {
    it("should replay remote WAL batches in deterministic timestamp order", async () => {
      // Remote Batch 1 from Device Beta (timestamp: 1000)
      const batch1: WalBatch<UserSetting> = {
        batchId: "b_1",
        clientId: "device_beta",
        timestamp: 1000,
        mutations: [
          {
            op: "SET",
            id: "note_1",
            data: { theme: "dark", fontSize: 14, notifications: false },
            timestamp: 1000,
            clientId: "device_beta",
            seq: 1,
          },
        ],
      };

      // Remote Batch 2 from Device Gamma (timestamp: 2000, updates note_1)
      const batch2: WalBatch<UserSetting> = {
        batchId: "b_2",
        clientId: "device_gamma",
        timestamp: 2000,
        mutations: [
          {
            op: "SET",
            id: "note_1",
            data: { theme: "light", fontSize: 18, notifications: true },
            timestamp: 2000,
            clientId: "device_gamma",
            seq: 1,
          },
          {
            op: "SET",
            id: "note_2",
            data: { theme: "dark", fontSize: 22, notifications: true },
            timestamp: 2000,
            clientId: "device_gamma",
            seq: 2,
          },
        ],
      };

      // Replay out-of-order batches ([batch2, batch1])
      const result = await db.reconcileBatches([batch2, batch1]);
      expect(result.appliedCount).toBe(3);

      // Verify deterministic Last-Write-Wins result
      const note1 = db.get("note_1");
      expect(note1?.data.theme).toBe("light");
      expect(note1?.data.fontSize).toBe(18);
      expect(note1?.updatedAt).toBe(2000);

      const note2 = db.get("note_2");
      expect(note2?.data.fontSize).toBe(22);
    });

    it("should handle remote DELETE mutations during replay", async () => {
      const batch: WalBatch<UserSetting> = {
        batchId: "b_del",
        clientId: "device_beta",
        timestamp: 1500,
        mutations: [
          {
            op: "SET",
            id: "doc_to_delete",
            data: { theme: "dark", fontSize: 12, notifications: false },
            timestamp: 1500,
            clientId: "device_beta",
            seq: 1,
          },
          {
            op: "DELETE",
            id: "doc_to_delete",
            timestamp: 1600,
            clientId: "device_beta",
            seq: 2,
          },
        ],
      };

      await db.reconcileBatches([batch]);
      expect(db.get("doc_to_delete")).toBeNull();
    });
  });

  describe("Scenario 4: Snapshot Compaction", () => {
    it("should compact active records and recent tombstones into a snapshot", () => {
      const records: StoredRecord<UserSetting>[] = [
        {
          id: "item_1",
          data: { theme: "dark" as const, fontSize: 14, notifications: true },
          updatedAt: Date.now(),
          syncStatus: "synced" as const,
          isDeleted: false,
        },
        {
          id: "item_2_deleted",
          data: { theme: "light" as const, fontSize: 12, notifications: false },
          updatedAt: Date.now() - 60 * 1000, // 1 minute ago (within 30-day window)
          syncStatus: "synced" as const,
          isDeleted: true,
        },
        {
          id: "item_3_ancient_tombstone",
          data: { theme: "light" as const, fontSize: 12, notifications: false },
          updatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 days ago (> 30-day window)
          syncStatus: "synced" as const,
          isDeleted: true,
        },
      ];

      const snapshot = WalEngine.createSnapshot(records);
      expect(snapshot.records.length).toBe(2);
      expect(snapshot.records.some((r) => r.id === "item_1")).toBe(true);
      expect(snapshot.records.some((r) => r.id === "item_2_deleted")).toBe(true);
      expect(snapshot.records.some((r) => r.id === "item_3_ancient_tombstone")).toBe(false);
    });
  });

  describe("Scenario 5: JSON Export & Backup Recovery", () => {
    it("should export full state and restore seamlessly", async () => {
      await db.set("setting_1", { theme: "dark", fontSize: 14, notifications: true });
      await db.set("setting_2", { theme: "light", fontSize: 18, notifications: false });

      const jsonString = await db.exportJson();
      const parsed = JSON.parse(jsonString);
      expect(parsed.records.length).toBe(2);

      const freshDb = new DriveDB<UserSetting>({
        dbName: `restore_test_db_${Date.now()}`,
        tableName: "settings",
      });
      await freshDb.init();

      await freshDb.importJson(jsonString);
      expect(freshDb.list().length).toBe(2);
      expect(freshDb.get("setting_1")?.data.theme).toBe("dark");
      expect(freshDb.get("setting_2")?.data.fontSize).toBe(18);

      await freshDb.close();
    });
  });
});
