import Database from 'better-sqlite3';
import type { StorageBackend } from './storage-backend.js';

export class SimpleStorageBackend implements StorageBackend {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        state_blob BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getAgentState(): Uint8Array | null {
    const row = this.db
      .prepare('SELECT state_blob FROM agent_state WHERE id = 1')
      .get() as { state_blob: Buffer } | undefined;
    return row ? new Uint8Array(row.state_blob) : null;
  }

  setAgentState(blob: Uint8Array): void {
    this.db
      .prepare(
        `INSERT INTO agent_state (id, state_blob, updated_at, version)
         VALUES (1, @blob, @now, 1)
         ON CONFLICT(id) DO UPDATE SET
           state_blob = @blob,
           updated_at = @now,
           version    = version + 1`,
      )
      .run({ blob: Buffer.from(blob), now: Date.now() });
  }

  getConfig(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = @value`,
      )
      .run({ key, value });
  }
}
