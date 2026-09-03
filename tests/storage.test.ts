import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IndexedDbStorage } from "@/storage/indexeddb";
import { Mutation, StoredRecord } from "@/types";

interface TestItem {
  name: string;
  value: number;
}

describe("IndexedDbStorage Engine", () => {
  let storage: IndexedDbStorage<TestItem>;

  beforeEach(async () => {
    storage = new IndexedDbStorage<TestItem>(
      `test_storage_${Date.now()}_${Math.random()}`,
      "items"
    );
    await storage.init(false);
  });

  afterEach(async () => {
    await storage.close();
  });

  it("should initialize stores and support CRUD on documents", async () => {
    const record: StoredRecord<TestItem> = {
      id: "item_1",
      data: { name: "Widget", value: 42 },
      updatedAt: Date.now(),
      syncStatus: "pending",
      isDeleted: false,
    };

    await storage.put(record);
    const retrieved = await storage.get("item_1");
    expect(retrieved).toEqual(record);

    const nonExistent = await storage.get("unknown_item");
    expect(nonExistent).toBeNull();
  });

  it("should support putMany and getAll", async () => {
    const records: StoredRecord<TestItem>[] = [
      {
        id: "a",
        data: { name: "Alpha", value: 1 },
        updatedAt: 100,
        syncStatus: "synced",
        isDeleted: false,
      },
      {
        id: "b",
        data: { name: "Beta", value: 2 },
        updatedAt: 200,
        syncStatus: "synced",
        isDeleted: false,
      },
    ];

    await storage.putMany(records);
    // Calling with empty array should be a safe no-op
    await storage.putMany([]);

    const all = await storage.getAll();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("should support WAL outbox append, get, and clear", async () => {
    const mutation1: Mutation<TestItem> = {
      op: "SET",
      id: "item_1",
      data: { name: "A", value: 10 },
      timestamp: 1000,
      clientId: "client_1",
      seq: 1,
    };

    const mutation2: Mutation<TestItem> = {
      op: "DELETE",
      id: "item_1",
      timestamp: 2000,
      clientId: "client_1",
      seq: 2,
    };

    await storage.appendMutation(mutation1);
    await storage.appendMutation(mutation2);

    const pending = await storage.getPendingMutations();
    expect(pending.length).toBe(2);
    expect(pending[0].id).toBe("item_1");
    expect(pending[1].op).toBe("DELETE");

    await storage.clearPendingMutations();
    const afterClear = await storage.getPendingMutations();
    expect(afterClear.length).toBe(0);
  });

  it("should store and retrieve sync metadata", async () => {
    await storage.setMeta("lastSync", 123456789);
    const retrieved = await storage.getMeta("lastSync");
    expect(retrieved).toBe(123456789);

    const empty = await storage.getMeta("non_existent_key");
    expect(empty).toBeNull();
  });

  it("should clear all tables in storage", async () => {
    await storage.put({
      id: "doc_1",
      data: { name: "One", value: 1 },
      updatedAt: 1,
      syncStatus: "pending",
      isDeleted: false,
    });
    await storage.appendMutation({
      op: "SET",
      id: "doc_1",
      timestamp: 1,
      clientId: "c",
      seq: 1,
    });
    await storage.setMeta("key", "val");

    await storage.clear();

    expect(await storage.getAll()).toEqual([]);
    expect(await storage.getPendingMutations()).toEqual([]);
    expect(await storage.getMeta("key")).toBeNull();
  });
});
