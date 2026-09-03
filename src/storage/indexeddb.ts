import { Mutation, StoredRecord } from "@/types";

export class IndexedDbStorage<T = Record<string, unknown>> {
  private dbName: string;
  private tableName: string;
  private walTableName: string;
  private metaTableName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName = "drivedb_store", tableName = "documents") {
    this.dbName = dbName;
    this.tableName = tableName;
    this.walTableName = `${tableName}_wal_outbox`;
    this.metaTableName = `${tableName}_meta`;
  }

  /**
   * Initializes IndexedDB database and object store schemas.
   */
  async init(requestPersistence = true): Promise<void> {
    if (this.db) return;

    if (requestPersistence && typeof navigator !== "undefined" && navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        // Silently ignore if permission denied or unsupported
      }
    }

    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not supported in this environment.");
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 2);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 1. Materialized documents store
        if (!db.objectStoreNames.contains(this.tableName)) {
          const store = db.createObjectStore(this.tableName, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
          store.createIndex("isDeleted", "isDeleted", { unique: false });
          store.createIndex("syncStatus", "syncStatus", { unique: false });
        }

        // 2. WAL outbox store (for unsynced mutations)
        if (!db.objectStoreNames.contains(this.walTableName)) {
          const walStore = db.createObjectStore(this.walTableName, {
            keyPath: "walKey",
            autoIncrement: true,
          });
          walStore.createIndex("timestamp", "timestamp", { unique: false });
        }

        // 3. Sync metadata store
        if (!db.objectStoreNames.contains(this.metaTableName)) {
          db.createObjectStore(this.metaTableName, { keyPath: "key" });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = (event) => {
        reject((event.target as IDBOpenDBRequest).error);
      };
    });
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.init();
    }
    if (!this.db) {
      throw new Error("Failed to open IndexedDB database.");
    }
    return this.db;
  }

  // --- Materialized Documents Methods ---

  async get(id: string): Promise<StoredRecord<T> | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.tableName, "readonly");
      const store = tx.objectStore(this.tableName);
      const req = store.get(id);

      req.onsuccess = () => resolve((req.result as StoredRecord<T>) || null);
      req.onerror = () => reject(req.error);
    });
  }

  async put(record: StoredRecord<T>): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.tableName, "readwrite");
      const store = tx.objectStore(this.tableName);
      const req = store.put(record);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async putMany(records: StoredRecord<T>[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.tableName, "readwrite");
      const store = tx.objectStore(this.tableName);

      for (const record of records) {
        store.put(record);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAll(): Promise<StoredRecord<T>[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.tableName, "readonly");
      const store = tx.objectStore(this.tableName);
      const req = store.getAll();

      req.onsuccess = () => resolve((req.result as StoredRecord<T>[]) || []);
      req.onerror = () => reject(req.error);
    });
  }

  // --- WAL Outbox Queue Methods ---

  async appendMutation(mutation: Mutation<T>): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.walTableName, "readwrite");
      const store = tx.objectStore(this.walTableName);
      const req = store.add(mutation);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getPendingMutations(): Promise<Mutation<T>[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.walTableName, "readonly");
      const store = tx.objectStore(this.walTableName);
      const req = store.getAll();

      req.onsuccess = () => resolve((req.result as Mutation<T>[]) || []);
      req.onerror = () => reject(req.error);
    });
  }

  async clearPendingMutations(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.walTableName, "readwrite");
      const store = tx.objectStore(this.walTableName);
      const req = store.clear();

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Metadata Methods ---

  async getMeta(key: string): Promise<unknown> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.metaTableName, "readonly");
      const store = tx.objectStore(this.metaTableName);
      const req = store.get(key);

      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.metaTableName, "readwrite");
      const store = tx.objectStore(this.metaTableName);
      const req = store.put({ key, value });

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.tableName, this.walTableName, this.metaTableName], "readwrite");
      tx.objectStore(this.tableName).clear();
      tx.objectStore(this.walTableName).clear();
      tx.objectStore(this.metaTableName).clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
