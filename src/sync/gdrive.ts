import { Snapshot, WalBatch } from "@/types";

export interface GDriveOptions {
  folderName?: string;
  folderId?: string;
  walFolderName?: string;
  snapshotFileName?: string;
  getToken: () => string | null | Promise<string | null>;
  onFolderResolved?: (folderId: string) => Promise<void> | void;
}

export class GoogleDriveClient<T = Record<string, unknown>> {
  private folderName: string;
  private walFolderName: string;
  private snapshotFileName: string;
  private getToken: () => string | null | Promise<string | null>;
  private onFolderResolved?: (folderId: string) => Promise<void> | void;
  private cachedFolderId: string | null = null;
  private cachedWalFolderId: string | null = null;
  private inFlightFolderPromise: Promise<string> | null = null;
  private inFlightWalPromise: Promise<string> | null = null;

  constructor(options: GDriveOptions) {
    this.folderName = options.folderName || "DriveDB Data";
    this.walFolderName = options.walFolderName || "wal";
    this.snapshotFileName = options.snapshotFileName || "snapshot.json";
    this.getToken = options.getToken;
    this.onFolderResolved = options.onFolderResolved;
    this.cachedFolderId = options.folderId || null;
  }

  setFolderId(folderId: string | null): void {
    this.cachedFolderId = folderId;
    this.cachedWalFolderId = null; // Invalidate cached subfolder when root changes
    this.inFlightFolderPromise = null;
    this.inFlightWalPromise = null;
  }

  private async getAuthHeader(): Promise<HeadersInit> {
    const token = await this.getToken();
    if (!token) {
      throw new Error("No Google Drive access token available.");
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
  }

  /**
   * Gets or creates the main app folder in Google Drive.
   * Uses single-flight deduplication to avoid concurrent creation race conditions.
   */
  async getOrCreateFolder(): Promise<string> {
    if (this.cachedFolderId) return this.cachedFolderId;
    if (this.inFlightFolderPromise) return this.inFlightFolderPromise;

    const promise = (async (): Promise<string> => {
      try {
        const headers = await this.getAuthHeader();
        const query = encodeURIComponent(
          `name = '${this.folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
        );

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
          headers,
        });

        if (!res.ok) {
          throw new Error(`Failed to query Google Drive root folder: ${res.statusText}`);
        }

        const data = await res.json();
        if (data.files && data.files.length > 0) {
          const folderId = data.files[0].id as string;
          this.cachedFolderId = folderId;
          await this.onFolderResolved?.(folderId);
          return folderId;
        }

        // Create root folder
        const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: this.folderName,
            mimeType: "application/vnd.google-apps.folder",
          }),
        });

        if (!createRes.ok) {
          throw new Error(`Failed to create Google Drive root folder: ${createRes.statusText}`);
        }

        const created = await createRes.json();
        const createdId = created.id as string;
        this.cachedFolderId = createdId;
        await this.onFolderResolved?.(createdId);
        return createdId;
      } finally {
        this.inFlightFolderPromise = null;
      }
    })();

    this.inFlightFolderPromise = promise;
    return promise;
  }

  /**
   * Gets or creates the `wal/` subfolder inside the app folder.
   * Uses single-flight deduplication and auto-cleans abandoned duplicate folders.
   */
  async getOrCreateWalFolder(): Promise<string> {
    if (this.cachedWalFolderId) return this.cachedWalFolderId;
    if (this.inFlightWalPromise) return this.inFlightWalPromise;

    const promise = (async (): Promise<string> => {
      try {
        const rootFolderId = await this.getOrCreateFolder();
        const headers = await this.getAuthHeader();
        const query = encodeURIComponent(
          `name = '${this.walFolderName}' and '${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
        );

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
          headers,
        });

        if (!res.ok) {
          throw new Error(`Failed to query Google Drive WAL folder: ${res.statusText}`);
        }

        const data = await res.json();
        const files: Array<{ id: string; name: string }> = data.files || [];

        if (files.length > 0) {
          // If multiple wal folders exist, identify the active one with files and clean up empty duplicates
          if (files.length > 1) {
            let activeFolderId = files[0].id;
            const emptyFolderIds: string[] = [];

            for (const folder of files) {
              const checkQ = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
              const checkRes = await fetch(
                `https://www.googleapis.com/drive/v3/files?q=${checkQ}&pageSize=1&fields=files(id)`,
                { headers }
              );
              if (checkRes.ok) {
                const checkData = await checkRes.json();
                if (checkData.files && checkData.files.length > 0) {
                  activeFolderId = folder.id;
                } else {
                  emptyFolderIds.push(folder.id);
                }
              }
            }

            // Automatically clean up abandoned empty duplicate folders
            for (const emptyId of emptyFolderIds) {
              if (emptyId !== activeFolderId) {
                await fetch(`https://www.googleapis.com/drive/v3/files/${emptyId}`, {
                  method: "DELETE",
                  headers,
                }).catch(() => null);
              }
            }

            this.cachedWalFolderId = activeFolderId;
            return activeFolderId;
          }

          const singleId = files[0].id;
          this.cachedWalFolderId = singleId;
          return singleId;
        }

        // Create wal folder inside root folder
        const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: this.walFolderName,
            parents: [rootFolderId],
            mimeType: "application/vnd.google-apps.folder",
          }),
        });

        if (!createRes.ok) {
          throw new Error(`Failed to create Google Drive WAL folder: ${createRes.statusText}`);
        }

        const created = await createRes.json();
        const createdId = created.id as string;
        this.cachedWalFolderId = createdId;
        return createdId;
      } finally {
        this.inFlightWalPromise = null;
      }
    })();

    this.inFlightWalPromise = promise;
    return promise;
  }

  /**
   * Uploads an immutable WAL batch file into the `wal/` subfolder.
   * Format: `wal/{timestamp}_{clientId}_{batchId}.json`
   */
  async uploadWalBatch(batch: WalBatch<T>): Promise<string> {
    const walFolderId = await this.getOrCreateWalFolder();
    const headers = await this.getAuthHeader();

    const fileName = `wal_${batch.timestamp}_${batch.clientId}_${batch.batchId}.json`;
    const payload = JSON.stringify(batch);

    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const metadata = {
      name: fileName,
      parents: [walFolderId],
      mimeType: "application/json",
    };

    const multipartBody =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: application/json\r\n\r\n" +
      payload +
      closeDelim;

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!res.ok) {
      throw new Error(`Failed to upload WAL batch to Google Drive: ${res.statusText}`);
    }

    const created = await res.json();
    return created.id;
  }

  /**
   * Lists remote WAL files modified after a given timestamp.
   */
  async listWalFilesSince(sinceTimestamp: number): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const walFolderId = await this.getOrCreateWalFolder();
    const headers = await this.getAuthHeader();

    let query = `'${walFolderId}' in parents and trashed = false`;
    if (sinceTimestamp > 0) {
      const isoDate = new Date(sinceTimestamp).toISOString();
      query += ` and modifiedTime > '${isoDate}'`;
    }

    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodedQuery}&orderBy=createdTime asc&fields=files(id,name,modifiedTime)&pageSize=100`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Failed to list remote WAL files: ${res.statusText}`);
    }

    const data = await res.json();
    return data.files || [];
  }

  /**
   * Downloads a single WAL batch JSON file by ID.
   */
  async downloadWalBatch(fileId: string): Promise<WalBatch<T> | null> {
    const headers = await this.getAuthHeader();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to download WAL batch ${fileId}: ${res.statusText}`);
    }

    return (await res.json()) as WalBatch<T>;
  }

  /**
   * Uploads or replaces `snapshot.json` in the root app folder.
   */
  async uploadSnapshot(snapshot: Snapshot<T>): Promise<string> {
    const rootFolderId = await this.getOrCreateFolder();
    const headers = await this.getAuthHeader();
    const payload = JSON.stringify(snapshot);

    // Check if snapshot.json already exists
    const query = encodeURIComponent(
      `name = '${this.snapshotFileName}' and '${rootFolderId}' in parents and trashed = false`
    );
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`, {
      headers,
    });
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
      const existingId = searchData.files[0].id;
      const updateRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: payload,
        }
      );
      if (!updateRes.ok) {
        throw new Error(`Failed to update snapshot in Google Drive: ${updateRes.statusText}`);
      }
      return existingId;
    }

    // Create new snapshot file
    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const metadata = {
      name: this.snapshotFileName,
      parents: [rootFolderId],
      mimeType: "application/json",
    };

    const multipartBody =
      delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: application/json\r\n\r\n" +
      payload +
      closeDelim;

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { ...headers, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });

    if (!res.ok) {
      throw new Error(`Failed to upload snapshot: ${res.statusText}`);
    }

    const created = await res.json();
    return created.id;
  }

  /**
   * Downloads the latest `snapshot.json`.
   */
  async downloadSnapshot(): Promise<Snapshot<T> | null> {
    const rootFolderId = await this.getOrCreateFolder();
    const headers = await this.getAuthHeader();

    const query = encodeURIComponent(
      `name = '${this.snapshotFileName}' and '${rootFolderId}' in parents and trashed = false`
    );
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`, {
      headers,
    });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    if (!searchData.files || searchData.files.length === 0) return null;

    const fileId = searchData.files[0].id;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });
    if (!res.ok) return null;

    return (await res.json()) as Snapshot<T>;
  }

  /**
   * Cleans up compacted WAL files.
   */
  async deleteWalFiles(fileIds: string[]): Promise<void> {
    const headers = await this.getAuthHeader();
    for (const id of fileIds) {
      try {
        await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
          method: "DELETE",
          headers,
        });
      } catch {
        // Silently ignore individual file deletion errors
      }
    }
  }
}
