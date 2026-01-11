import { Database } from "bun:sqlite";
import * as path from "path";

export interface ChannelSession {
  channelId: string;
  sessionId: string;
  channelName: string;
  lastUsed: number;
}

export type PermissionMode = "auto" | "plan" | "approve";
export type ClaudeModel = "opus" | "sonnet" | "haiku";
export type Provider = "claude" | "codex";

export interface ChannelMode {
  channelId: string;
  mode: PermissionMode;
}

export class DatabaseManager {
  private db: Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(process.cwd(), "sessions.db");
    this.db = new Database(finalPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        last_used INTEGER NOT NULL
      )
    `);

    // Create channel modes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_modes (
        channel_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'auto'
      )
    `);

    // Create channel models table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_models (
        channel_id TEXT PRIMARY KEY,
        model TEXT NOT NULL DEFAULT 'sonnet'
      )
    `);

    // Create channel providers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_providers (
        channel_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'claude'
      )
    `);

    // Create channel paths table (for custom folder mappings)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_paths (
        channel_id TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL
      )
    `);
  }

  getSession(channelId: string): string | undefined {
    const stmt = this.db.query("SELECT session_id FROM channel_sessions WHERE channel_id = ?");
    const result = stmt.get(channelId) as { session_id: string } | null;
    return result?.session_id;
  }

  setSession(channelId: string, sessionId: string, channelName: string): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_sessions (channel_id, session_id, channel_name, last_used)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(channelId, sessionId, channelName, Date.now());
  }

  clearSession(channelId: string): void {
    const stmt = this.db.query("DELETE FROM channel_sessions WHERE channel_id = ?");
    stmt.run(channelId);
  }

  getMode(channelId: string): PermissionMode {
    const stmt = this.db.query("SELECT mode FROM channel_modes WHERE channel_id = ?");
    const result = stmt.get(channelId) as { mode: PermissionMode } | null;
    return result?.mode || "auto";
  }

  setMode(channelId: string, mode: PermissionMode): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_modes (channel_id, mode)
      VALUES (?, ?)
    `);
    stmt.run(channelId, mode);
  }

  getModel(channelId: string): ClaudeModel {
    const stmt = this.db.query("SELECT model FROM channel_models WHERE channel_id = ?");
    const result = stmt.get(channelId) as { model: ClaudeModel } | null;
    return result?.model || "sonnet";
  }

  setModel(channelId: string, model: ClaudeModel): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_models (channel_id, model)
      VALUES (?, ?)
    `);
    stmt.run(channelId, model);
  }

  getProvider(channelId: string): Provider {
    const stmt = this.db.query("SELECT provider FROM channel_providers WHERE channel_id = ?");
    const result = stmt.get(channelId) as { provider: Provider } | null;
    return result?.provider || "claude";
  }

  setProvider(channelId: string, provider: Provider): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_providers (channel_id, provider)
      VALUES (?, ?)
    `);
    stmt.run(channelId, provider);
  }

  getPath(channelId: string): string | undefined {
    const stmt = this.db.query("SELECT folder_name FROM channel_paths WHERE channel_id = ?");
    const result = stmt.get(channelId) as { folder_name: string } | null;
    return result?.folder_name;
  }

  setPath(channelId: string, folderName: string): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_paths (channel_id, folder_name)
      VALUES (?, ?)
    `);
    stmt.run(channelId, folderName);
  }

  clearPath(channelId: string): void {
    const stmt = this.db.query("DELETE FROM channel_paths WHERE channel_id = ?");
    stmt.run(channelId);
  }

  getAllSessions(): ChannelSession[] {
    const stmt = this.db.query("SELECT * FROM channel_sessions ORDER BY last_used DESC");
    return stmt.all() as ChannelSession[];
  }

  // Clean up old sessions (older than 30 days)
  cleanupOldSessions(): void {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const stmt = this.db.query("DELETE FROM channel_sessions WHERE last_used < ?");
    const result = stmt.run(thirtyDaysAgo);
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} old sessions`);
    }
  }

  close(): void {
    this.db.close();
  }
}
