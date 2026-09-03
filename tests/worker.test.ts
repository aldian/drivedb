import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncWorker } from "@/sync/worker";
import { GoogleDriveClient } from "@/sync/gdrive";
import { Mutation, SyncStatus } from "@/types";

describe("SyncWorker: Debounced Background Sync Engine", () => {
  let pendingMutations: Mutation<{ text: string }>[] = [];
  let syncedIds: string[] = [];
  let mockDriveClient: {
    uploadWalBatch: ReturnType<typeof vi.fn>;
  };
  let worker: SyncWorker<{ text: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    pendingMutations = [];
    syncedIds = [];

    mockDriveClient = {
      uploadWalBatch: vi.fn().mockResolvedValue("file_abc123"),
    };

    worker = new SyncWorker<{ text: string }>({
      debounceMs: 100,
      clientId: "device_unit_test",
      driveClient: mockDriveClient as unknown as GoogleDriveClient<{ text: string }>,
      getPendingMutations: async () => pendingMutations,
      clearPendingMutations: async () => {
        pendingMutations = [];
      },
      markRecordsSynced: async (ids) => {
        syncedIds.push(...ids);
      },
      enableBroadcastChannel: false,
    });
  });

  afterEach(() => {
    worker.close();
    vi.useRealTimers();
  });

  it("should debounce rapid scheduleSync calls into a single upload execution", async () => {
    pendingMutations.push({
      op: "SET",
      id: "doc_1",
      data: { text: "Hello" },
      timestamp: 1000,
      clientId: "device_unit_test",
      seq: 1,
    });

    // Fire 5 rapid schedules within 50ms
    worker.scheduleSync();
    worker.scheduleSync();
    worker.scheduleSync();
    worker.scheduleSync();
    worker.scheduleSync();

    expect(mockDriveClient.uploadWalBatch).not.toHaveBeenCalled();

    // Advance timer past debounce window
    await vi.advanceTimersByTimeAsync(150);

    expect(mockDriveClient.uploadWalBatch).toHaveBeenCalledTimes(1);
    expect(syncedIds).toEqual(["doc_1"]);
    expect(pendingMutations.length).toBe(0);
  });

  it("should notify listeners across lifecycle states (pending -> syncing -> synced)", async () => {
    const events: SyncStatus[] = [];
    const unsubscribe = worker.subscribe((e) => {
      events.push(e.status);
    });

    pendingMutations.push({
      op: "SET",
      id: "doc_2",
      data: { text: "World" },
      timestamp: 2000,
      clientId: "device_unit_test",
      seq: 2,
    });

    worker.scheduleSync();
    expect(events).toContain("pending");

    await vi.advanceTimersByTimeAsync(150);

    expect(events).toContain("syncing");
    expect(events).toContain("synced");

    unsubscribe();
  });

  it("should handle empty mutations gracefully without uploading", async () => {
    pendingMutations = [];
    const success = await worker.flush();

    expect(success).toBe(true);
    expect(mockDriveClient.uploadWalBatch).not.toHaveBeenCalled();
  });

  it("should notify listeners with error state when upload fails", async () => {
    mockDriveClient.uploadWalBatch.mockRejectedValueOnce(new Error("Network timeout"));

    pendingMutations.push({
      op: "SET",
      id: "doc_fail",
      data: { text: "Fail" },
      timestamp: 3000,
      clientId: "device_unit_test",
      seq: 3,
    });

    let reportedError: Error | undefined;
    worker.subscribe((e) => {
      if (e.status === "error") {
        reportedError = e.error;
      }
    });

    const success = await worker.flush();
    expect(success).toBe(false);
    expect(reportedError?.message).toBe("Network timeout");
  });

  it("should not schedule sync if driveClient is not configured", async () => {
    worker.setDriveClient(null);
    worker.scheduleSync();
    await vi.advanceTimersByTimeAsync(150);
    expect(mockDriveClient.uploadWalBatch).not.toHaveBeenCalled();
  });
});
