import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoogleDriveClient } from "@/sync/gdrive";
import { Snapshot, WalBatch } from "@/types";

describe("GoogleDriveClient REST API connector", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should throw an error if no access token is available", async () => {
    const client = new GoogleDriveClient({
      getToken: () => null,
    });

    await expect(client.getOrCreateFolder()).rejects.toThrow(
      "No Google Drive access token available."
    );
  });

  it("should find an existing folder in Google Drive", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [{ id: "folder_123", name: "DriveDB Data" }] }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      folderName: "DriveDB Data",
      getToken: () => "mock_token",
    });

    const folderId = await client.getOrCreateFolder();
    expect(folderId).toBe("folder_123");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should use cached folder ID
    const cachedId = await client.getOrCreateFolder();
    expect(cachedId).toBe("folder_123");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should use explicit folderId directly without search", async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      folderId: "exact_folder_id_999",
      getToken: () => "mock_token",
    });

    const folderId = await client.getOrCreateFolder();
    expect(folderId).toBe("exact_folder_id_999");
    expect(mockFetch).not.toHaveBeenCalled();

    client.setFolderId("updated_folder_888");
    expect(await client.getOrCreateFolder()).toBe("updated_folder_888");
  });

  it("should create a folder if not found in Google Drive", async () => {
    const mockFetch = vi
      .fn()
      // First call: search returns empty list
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [] }),
      })
      // Second call: create returns new folder
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "folder_new_456" }),
      });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      folderName: "New Folder",
      getToken: () => "mock_token",
    });

    const folderId = await client.getOrCreateFolder();
    expect(folderId).toBe("folder_new_456");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should get or create wal subfolder inside root folder", async () => {
    const mockFetch = vi
      .fn()
      // Root folder search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "root_1" }] }),
      })
      // Wal folder search: not found
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [] }),
      })
      // Wal folder create
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "wal_folder_1" }),
      });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      getToken: () => "mock_token",
    });

    const walId = await client.getOrCreateWalFolder();
    expect(walId).toBe("wal_folder_1");
  });

  it("should upload immutable WAL batch using multipart format", async () => {
    const mockFetch = vi
      .fn()
      // Root folder search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "root_1" }] }),
      })
      // Wal folder search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "wal_1" }] }),
      })
      // Upload multipart
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "uploaded_wal_file_id" }),
      });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      getToken: () => "mock_token",
    });

    const batch: WalBatch = {
      batchId: "b_test",
      clientId: "dev_1",
      timestamp: 1000,
      mutations: [],
    };

    const fileId = await client.uploadWalBatch(batch);
    expect(fileId).toBe("uploaded_wal_file_id");

    const uploadCall = mockFetch.mock.calls[2];
    expect(uploadCall[0]).toContain("/upload/drive/v3/files?uploadType=multipart");
    expect(uploadCall[1].headers["Content-Type"]).toContain("multipart/related; boundary=");
  });

  it("should list remote WAL files modified since a timestamp", async () => {
    const mockFetch = vi
      .fn()
      // Root folder search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "root_1" }] }),
      })
      // Wal folder search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "wal_1" }] }),
      })
      // List files
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          files: [
            { id: "f1", name: "wal_1000.json", modifiedTime: "2026-09-03T10:00:00Z" },
            { id: "f2", name: "wal_2000.json", modifiedTime: "2026-09-03T11:00:00Z" },
          ],
        }),
      });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      getToken: () => "mock_token",
    });

    const files = await client.listWalFilesSince(1000);
    expect(files.length).toBe(2);
    expect(files[0].id).toBe("f1");
  });

  it("should download and parse a WAL batch JSON file", async () => {
    const batchData: WalBatch = {
      batchId: "b_down",
      clientId: "client_x",
      timestamp: 5000,
      mutations: [
        { op: "SET", id: "note_1", data: { text: "hi" }, timestamp: 5000, clientId: "client_x", seq: 1 },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => batchData,
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      getToken: () => "mock_token",
    });

    const downloaded = await client.downloadWalBatch("f1");
    expect(downloaded).toEqual(batchData);

    // 404 should return null
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    const notFound = await client.downloadWalBatch("f_missing");
    expect(notFound).toBeNull();
  });

  it("should upload and download snapshot.json", async () => {
    const snapshotData: Snapshot = {
      snapshotId: "snap_1",
      timestamp: 10000,
      lastCompactedTimestamp: 10000,
      records: [],
    };

    const mockFetch = vi
      .fn()
      // Root folder search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "root_1" }] }),
      })
      // Search snapshot.json: not found
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [] }),
      })
      // Create snapshot.json
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "snapshot_file_id" }),
      });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      getToken: () => "mock_token",
    });

    const snapId = await client.uploadSnapshot(snapshotData);
    expect(snapId).toBe("snapshot_file_id");

    // Test downloading snapshot when present
    const downloadClient = new GoogleDriveClient({ getToken: () => "mock_token" });
    const mockDownloadFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "root_1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "snap_file_99" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => snapshotData,
      });
    global.fetch = mockDownloadFetch as unknown as typeof fetch;

    const downloaded = await downloadClient.downloadSnapshot();
    expect(downloaded).toEqual(snapshotData);

    // Test downloading snapshot when not found
    const missingClient = new GoogleDriveClient({ getToken: () => "mock_token" });
    const mockMissingFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [{ id: "root_1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [] }),
      });
    global.fetch = mockMissingFetch as unknown as typeof fetch;
    expect(await missingClient.downloadSnapshot()).toBeNull();
  });

  it("should delete old WAL files", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new GoogleDriveClient({
      getToken: () => "mock_token",
    });

    await client.deleteWalFiles(["file_1", "file_2"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
