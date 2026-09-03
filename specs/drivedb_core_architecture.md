# DriveDB: Append-Only Delta Log (WAL) Specification & Architecture

```yaml
drivedb_config:
  default_db_name: "drivedb_store"
  default_table_name: "documents"
  sync_debounce_ms: 1000
  conflict_strategy: "wal_last_write_wins"
  storage_architecture: "append_only_delta_log"
  max_uncompacted_logs: 50
  eviction_protection: true
  broadcast_channel_enabled: true

gdrive_config:
  default_folder_name: "DriveDB Data"
  wal_subfolder_name: "wal"
  snapshot_file_name: "snapshot.json"
  oauth_scope: "https://www.googleapis.com/auth/drive.file"
  auto_sync_on_write: true
```

---

## 1. Overview
**DriveDB** implements an **Append-Only Write-Ahead Log (WAL) / Event-Sourcing architecture**:
* **Local In-Memory Cache**: Zero-latency reads and writes ($0\text{ms}$).
* **Materialized IndexedDB Store**: Durable local view for offline querying.
* **Outbox WAL**: Local transaction log recording atomic mutations (`SET`, `DELETE`).
* **Cloud Storage on Google Drive**:
  - Remote directory `wal/`: Stores immutable batch log files (`{timestamp}_{clientId}_{batchId}.json`).
  - Remote file `snapshot.json`: Stores periodic consolidated state snapshots.
  - **Zero Overwrite Collisions**: Every sync from any client creates an immutable new file in `wal/`. Conflicting overwrites are impossible.
  - **Deterministic Replay**: Clients download new WAL batches and replay them in timestamp order with Last-Write-Wins (LWW) convergence.
  - **Compaction**: Periodically collapses old log batches into a new `snapshot.json` to keep Drive tidy and fast.

---

## 2. BDD Scenarios (Gherkin)

### Scenario 1: Local Mutation Logging & Materialization
```gherkin
Feature: Local WAL Mutation Logging
  As an application writing data to DriveDB
  I want each mutation recorded in a local outbox log and applied to the local view
  So that the UI updates immediately and the change is queued for cloud upload

  Scenario: Setting a document creates a local WAL mutation
    Given an initialized DriveDB collection with client ID "device_phone"
    When the application executes `db.set("user_1", { name: "Alice", active: true })`
    Then the document is immediately queryable via `db.get("user_1")`
    And a mutation is appended to the local outbox WAL with op "SET" and timestamp
    And the document's syncStatus is marked as "pending"
```

### Scenario 2: Tombstone Mutation Deletion
```gherkin
Feature: Tombstone Mutation Recording
  As an application deleting data
  I want a DELETE mutation recorded in the WAL
  So that deletions append to the cloud event stream without purging local history prematurely

  Scenario: Deleting a document creates a DELETE mutation
    Given an existing document with ID "item_42"
    When the application executes `db.delete("item_42")`
    Then `db.get("item_42")` returns null
    And a mutation with op "DELETE" is appended to the local outbox WAL
```

### Scenario 3: Append-Only Cloud Upload (No Overwrites)
```gherkin
Feature: Append-Only Cloud Sync
  As a connected client with pending local mutations
  I want to upload an immutable batch JSON file to the Google Drive `wal/` folder
  So that cloud synchronization never overwrites existing remote files

  Scenario: Flushing local outbox to Google Drive WAL
    Given 3 pending mutations in the local outbox
    When the sync worker executes a flush
    Then a new immutable file `{timestamp}_{clientId}_{batchId}.json` is created in Google Drive `wal/`
    And the local outbox is cleared
    And local records are updated to `syncStatus: "synced"`
```

### Scenario 4: Cross-Device Replay & Convergence
```gherkin
Feature: Deterministic WAL Replay
  As a second device (e.g. laptop) connecting to Google Drive
  I want to fetch all remote WAL batches created after my last sync
  So that my local database deterministically replays all operations

  Scenario: Replaying remote WAL mutations
    Given Device B with last sync timestamp 1000
    And remote WAL files on Google Drive with timestamps 1500 and 2000
    When Device B executes `db.sync()`
    Then Device B downloads only the new WAL files
    And replays the mutations in deterministic timestamp order
    And updates its local materialized view to match Device A
```

### Scenario 5: Snapshot Compaction
```gherkin
Feature: Snapshot Compaction
  As the database accumulates multiple WAL log files
  I want older WAL files compacted into a single snapshot.json
  So that startup replay remains instantaneous and Drive storage remains clean

  Scenario: Compacting WAL logs into snapshot.json
    Given 50 uncompacted WAL log files in the Google Drive `wal/` folder
    When compaction triggers
    Then a consolidated `snapshot.json` is uploaded with all current non-deleted records
    And older compacted WAL files are archived or removed
```
