import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  describe("Scenario 6: Dynamic Tokens, Sync Listeners & Compaction Integration", () => {
    it("should support find and query predicates", async () => {
      await db.set("item_a", { theme: "dark", fontSize: 10, notifications: false });
      await db.set("item_b", { theme: "light", fontSize: 20, notifications: true });

      const found = db.find((d) => d.data.fontSize === 20);
      expect(found?.id).toBe("item_b");

      const notFound = db.find((d) => d.data.fontSize === 99);
      expect(notFound).toBeNull();
    });

    it("should allow dynamic access token switching", async () => {
      expect(await db.sync()).toBe(false); // No token initially

      db.setAccessToken("test_access_token_123");
      // Setting token dynamically configures the driveClient
      db.setAccessToken(null); // Clearing token removes it
      expect(await db.sync()).toBe(false);
    });

    it("should subscribe and unsubscribe from sync lifecycle events", async () => {
      let eventCount = 0;
      const unsubscribe = db.onSyncChange(() => {
        eventCount++;
      });

      await db.set("ev_test", { theme: "dark", fontSize: 12, notifications: true });
      unsubscribe();
      expect(typeof unsubscribe).toBe("function");
    });

    it("should execute two-way sync with Google Drive", async () => {
      const syncDb = new DriveDB<UserSetting>({
        dbName: `sync_int_test_${Date.now()}`,
        tableName: "settings",
        accessToken: "test_token_xyz",
        autoSync: false,
      });
      await syncDb.init();

      // Mock remote WAL batch from Device Beta
      const remoteBatch: WalBatch<UserSetting> = {
        batchId: "b_remote_sync",
        clientId: "dev_beta",
        timestamp: 5000,
        mutations: [
          {
            op: "SET",
            id: "remote_note",
            data: { theme: "light", fontSize: 14, notifications: true },
            timestamp: 5000,
            clientId: "dev_beta",
            seq: 1,
          },
        ],
      };

      const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
        const urlStr = String(url);
        // Root folder query
        if (urlStr.includes("mimeType = 'application/vnd.google-apps.folder'") && !urlStr.includes("in parents")) {
          return {
            ok: true,
            json: async () => ({ files: [{ id: "root_folder_1" }] }),
          } as Response;
        }
        // WAL folder query
        if (urlStr.includes("in parents") && urlStr.includes("name = 'wal'")) {
          return {
            ok: true,
            json: async () => ({ files: [{ id: "wal_folder_1" }] }),
          } as Response;
        }
        // List WAL files since
        if (urlStr.includes("orderBy=createdTime")) {
          return {
            ok: true,
            json: async () => ({
              files: [{ id: "wal_file_1", name: "wal_5000.json", modifiedTime: "2026-09-03T10:00:00Z" }],
            }),
          } as Response;
        }
        // Download WAL batch file
        if (urlStr.includes("wal_file_1?alt=media")) {
          return {
            ok: true,
            json: async () => remoteBatch,
          } as Response;
        }
        // Upload multipart WAL batch
        if (urlStr.includes("uploadType=multipart")) {
          return {
            ok: true,
            json: async () => ({ id: "new_wal_uploaded_id" }),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });

      const origFetch = global.fetch;
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        // Queue a local mutation
        await syncDb.set("local_doc", { theme: "dark", fontSize: 20, notifications: false });

        // Run sync
        const synced = await syncDb.sync();
        expect(synced).toBe(true);

        // Verify remote batch was replayed into local DB
        expect(syncDb.get("remote_note")?.data.theme).toBe("light");
        // Verify local doc is marked synced
        expect(syncDb.get("local_doc")?.syncStatus).toBe("synced");
      } finally {
        global.fetch = origFetch;
        await syncDb.close();
      }
    });

    it("should execute compact to consolidate state into snapshot.json", async () => {
      const compactDb = new DriveDB<UserSetting>({
        dbName: `compact_int_test_${Date.now()}`,
        tableName: "settings",
        accessToken: "test_token_compact",
        autoSync: false,
      });
      await compactDb.init();
      await compactDb.set("item_x", { theme: "dark", fontSize: 16, notifications: true });

      const mockFetch = vi.fn(async (url: RequestInfo | URL) => {
        const urlStr = String(url);
        // Root folder
        if (urlStr.includes("mimeType = 'application/vnd.google-apps.folder'") && !urlStr.includes("in parents")) {
          return { ok: true, json: async () => ({ files: [{ id: "root_1" }] }) } as Response;
        }
        // Search snapshot.json
        if (urlStr.includes("name = 'snapshot.json'")) {
          return { ok: true, json: async () => ({ files: [] }) } as Response;
        }
        // Upload snapshot
        if (urlStr.includes("uploadType=multipart")) {
          return { ok: true, json: async () => ({ id: "snap_file_id" }) } as Response;
        }
        // List WAL files for cleanup
        if (urlStr.includes("orderBy=createdTime")) {
          return {
            ok: true,
            json: async () => ({
              files: [{ id: "old_wal_1", modifiedTime: new Date(Date.now() - 1000).toISOString() }],
            }),
          } as Response;
        }
        // WAL subfolder search
        if (urlStr.includes("name = 'wal'")) {
          return { ok: true, json: async () => ({ files: [{ id: "wal_1" }] }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      });

      const origFetch = global.fetch;
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        const snapshotId = await compactDb.compact();
        expect(snapshotId).toBe("snap_file_id");
      } finally {
        global.fetch = origFetch;
        await compactDb.close();
      }
    });
  });

  describe("Scenario 7: Client-Decided Folder Naming, UUID Scoping & Folder ID Binding", () => {
    it("should allow client to strictly specify their own folder name", () => {
      const clientDb = new DriveDB<UserSetting>({
        dbName: "notes_app",
        gdriveFolderName: "Medical Clinic Records",
        appendFolderUuid: false,
      });

      expect((clientDb as any).options.gdriveFolderName).toBe("Medical Clinic Records");
    });

    it("should append a UUID to custom folder name if appendFolderUuid is enabled", () => {
      const clientDb = new DriveDB<UserSetting>({
        dbName: "notes_app",
        gdriveFolderName: "Medical Clinic Records",
        appendFolderUuid: true,
      });

      const folderName = (clientDb as any).options.gdriveFolderName as string;
      expect(folderName.startsWith("Medical Clinic Records_")).toBe(true);
      expect(folderName.length).toBeGreaterThan("Medical Clinic Records_".length);
    });

    it("should auto-generate an isolated folder name scoped to dbName with UUID if omitted", () => {
      const autoDb = new DriveDB<UserSetting>({
        dbName: "patient_emr",
      });

      const folderName = (autoDb as any).options.gdriveFolderName as string;
      expect(folderName.startsWith("patient_emr_drivedb_")).toBe(true);
    });

    it("should support explicit and persisted gdriveFolderId binding", async () => {
      const dbWithFolder = new DriveDB<UserSetting>({
        dbName: `folder_persist_${Date.now()}`,
        tableName: "settings",
      });
      await dbWithFolder.init();

      expect(dbWithFolder.getGdriveFolderId()).toBeUndefined();

      // Explicitly bind a folder ID (e.g. from Google Drive Picker)
      await dbWithFolder.setGdriveFolderId("folder_xyz_12345");
      expect(dbWithFolder.getGdriveFolderId()).toBe("folder_xyz_12345");
      await dbWithFolder.close();

      // Create another instance with the same dbName -> should hydrate persisted folder ID
      const secondDb = new DriveDB<UserSetting>({
        dbName: (dbWithFolder as any).options.dbName,
        tableName: "settings",
      });
      await secondDb.init();
      expect(secondDb.getGdriveFolderId()).toBe("folder_xyz_12345");

      await secondDb.close();
    });
  });
});
