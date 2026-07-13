/**
 * Session store — discovers existing OpenCode sessions.
 *
 * OpenCode v1.17+ stores sessions in a SQLite database
 * (`~/.local/share/opencode/opencode.db`). Earlier versions used individual
 * JSON files under `~/.local/share/opencode/sessions/`.
 *
 * This store auto-detects the available source: SQLite DB takes precedence
 * over the legacy filesystem directory. When neither is available it returns
 * empty results (no crash).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../logger.js";
import type { HistoryEntry, SessionMeta } from "./types.js";
import { readHistory as readHistoryFromFs, readFirstPrompt as readFirstPromptFromFs } from "./history.js";

const log = createLogger("sessions:store");

/** OpenCode session JSON on disk (legacy format). */
interface RawSessionJson {
  id?: string;
  directory?: string;
  projectID?: string;
  title?: string;
  version?: string;
  time?: { created?: number; updated?: number; compacting?: number };
  session_id?: string;
  cwd?: string;
  created_at?: string;
  updated_at?: string;
  session_created_reason?: string;
}

/** Subset of the OpenCode DB session row we need. */
interface DbSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

export class SessionStore {
  /** Which backend is active. */
  readonly mode: "db" | "fs" | "none";
  private readonly sessionsDir: string;

  constructor(
    sessionsDir: string,
    private readonly dbPath: string,
    /** PID of the bot's own OpenCode process — sessions locked by it are
     *  active because the ACP agent is serving them in-process. */
    private readonly getAcpPid: () => number | undefined,
    /** Set of session IDs currently running inside the ACP agent. */
    private readonly getAcpRunning: () => Set<string>,
  ) {
    this.sessionsDir = sessionsDir;
    if (dbAvailable(dbPath)) {
      this.mode = "db";
    } else if (fsAvailable(sessionsDir)) {
      this.mode = "fs";
    } else {
      this.mode = "none";
    }
    log.info(
      `session store: mode=${this.mode}` +
        (this.mode === "db" ? ` db=${dbPath}` : "") +
        (this.mode === "fs" ? ` dir=${sessionsDir}` : ""),
    );
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** True when a session data source exists. */
  available(): boolean {
    return this.mode !== "none";
  }

  /** List sessions, most recently updated first. */
  list(limit = 50): SessionMeta[] {
    if (this.mode === "db") return this.listDb(limit);
    if (this.mode === "fs") return this.listFs(limit);
    return [];
  }

  /** List only sessions currently running on this PC. */
  listActive(): SessionMeta[] {
    if (this.mode === "db") return this.listDb(500).filter((m) => m.active);
    if (this.mode === "fs") return this.listFs(200).filter((m) => m.active);
    return [];
  }

  /** Get a single session by ID. */
  get(sessionId: string): SessionMeta | undefined {
    if (this.mode === "db") return this.getDb(sessionId);
    if (this.mode === "fs") return this.readMetaFs(`${sessionId}.json`);
    return undefined;
  }

  /** File-system path to the session history (empty string in DB mode). */
  jsonlPath(sessionId: string): string {
    if (this.mode === "fs") return join(this.sessionsDir, `${sessionId}.jsonl`);
    return "";
  }

  /** Read history from the session's message/event log. */
  readHistory(sessionId: string, maxEntries = 20): HistoryEntry[] {
    if (this.mode === "db") return readHistoryFromDb(this.dbPath, sessionId, maxEntries);
    return readHistoryFromFs(join(this.sessionsDir, `${sessionId}.jsonl`), maxEntries);
  }

  /** Read the first user prompt in a session (for session cards). */
  readFirstPrompt(sessionId: string): string {
    if (this.mode === "db") return readFirstPromptFromDb(this.dbPath, sessionId);
    return readFirstPromptFromFs(join(this.sessionsDir, `${sessionId}.jsonl`));
  }

  // ── SQLite backend ────────────────────────────────────────────────────────

  private listDb(limit: number): SessionMeta[] {
    const acpPid = this.getAcpPid();
    const running = this.getAcpRunning();
    let db: Database | undefined;
    try {
      db = openDb(this.dbPath);
      const rows = db.prepare(
        `SELECT id, directory, title, agent, model, time_created, time_updated, time_archived
         FROM session
         WHERE time_archived IS NULL
         ORDER BY time_updated DESC
         LIMIT ?`,
      ).all<DbSessionRow>(limit);
      return rows.map((r) => this.rowToMeta(r, acpPid, running));
    } catch (e) {
      log.warn("db list failed:", (e as Error).message);
      return [];
    } finally {
      db?.close();
    }
  }

  private getDb(sessionId: string): SessionMeta | undefined {
    const acpPid = this.getAcpPid();
    const running = this.getAcpRunning();
    let db: Database | undefined;
    try {
      db = openDb(this.dbPath);
      const row = db.prepare(
        `SELECT id, directory, title, agent, model, time_created, time_updated, time_archived
         FROM session WHERE id = ?`,
      ).get<DbSessionRow>(sessionId);
      return row ? this.rowToMeta(row, acpPid, running) : undefined;
    } catch (e) {
      log.warn("db get failed:", (e as Error).message);
      return undefined;
    } finally {
      db?.close();
    }
  }

  private rowToMeta(
    row: DbSessionRow,
    acpPid: number | undefined,
    running: Set<string>,
  ): SessionMeta {
    const active = running.has(row.id);

    return {
      sessionId: row.id,
      cwd: row.directory ?? "",
      title: row.title?.trim() || "(untitled)",
      createdAt: msToIso(row.time_created),
      updatedAt: msToIso(row.time_updated),
      reason: undefined,
      lockPid: active ? acpPid : undefined,
      active,
      historyBytes: 0,
    };
  }

  // ── Legacy filesystem backend ─────────────────────────────────────────────

  private listFs(limit: number): SessionMeta[] {
    let files: string[];
    try {
      files = readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
    } catch (e) {
      log.warn("cannot read sessions dir:", (e as Error).message);
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const file of files) {
      const meta = this.readMetaFs(file);
      if (meta) metas.push(meta);
    }
    metas.sort(
      (a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt),
    );
    return metas.slice(0, limit);
  }

  private readMetaFs(file: string): SessionMeta | undefined {
    const full = join(this.sessionsDir, file);
    let raw: RawSessionJson;
    let mtime = new Date(0).toISOString();
    try {
      raw = JSON.parse(readFileSync(full, "utf-8")) as RawSessionJson;
      mtime = statSync(full).mtime.toISOString();
    } catch {
      return undefined;
    }

    const sessionId = raw.id || raw.session_id || file.replace(/\.json$/, "");
    const cwd = raw.directory || raw.cwd || "";
    const title = (raw.title || "").trim() || "(untitled)";
    const createdAt = raw.time?.created
      ? new Date(raw.time.created).toISOString()
      : raw.created_at || mtime;
    const updatedAt = raw.time?.updated
      ? new Date(raw.time.updated).toISOString()
      : raw.updated_at || mtime;

    let historyBytes = 0;
    try {
      historyBytes = statSync(join(this.sessionsDir, `${sessionId}.jsonl`)).size;
    } catch {
      /* no history yet */
    }

    return {
      sessionId,
      cwd,
      title,
      createdAt,
      updatedAt,
      reason: raw.session_created_reason,
      lockPid: undefined,
      active: false,
      historyBytes,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function dbAvailable(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function fsAvailable(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ── SQLite access ───────────────────────────────────────────────────────────

interface Database {
  prepare(sql: string): Statement;
  close(): void;
}
interface Statement {
  all<T>(...params: unknown[]): T[];
  get<T>(...params: unknown[]): T | undefined;
}

function openDb(path: string): Database {
  const require = createRequire(import.meta.url);
  const BetterSqlite3 = require("better-sqlite3") as
    (new (path: string, opts?: { readonly?: boolean }) => Database) | undefined;

  if (!BetterSqlite3) {
    throw new Error(
      "better-sqlite3 is required for OpenCode SQLite session support.\n" +
        "Install it: npm install better-sqlite3\n" +
        "Or set OPENCODE_SESSIONS_DB to an empty string to disable SQLite mode.",
    );
  }

  return new BetterSqlite3(path, { readonly: true });
}

// ── SQLite history reader ───────────────────────────────────────────────────

function readHistoryFromDb(
  dbPath: string,
  sessionId: string,
  maxEntries: number,
): HistoryEntry[] {
  let db: Database | undefined;
  try {
    db = openDb(dbPath);
    const rows = db.prepare(
      `SELECT m.data
       FROM message m
       WHERE m.session_id = ?
       ORDER BY m.time_created DESC
       LIMIT ?`,
    ).all<{ data: string }>(sessionId, maxEntries * 3);

    const entries: HistoryEntry[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const msgData = parseJson(rows[i]!.data);
      if (!msgData) continue;

      const role = roleFromDb(msgData.role);
      if (!role) continue;

      let text = "";
      if (Array.isArray(msgData.content)) {
        text = (msgData.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c && (c.type === "text" || c.type === "reasoning"))
          .map((c) => c.text ?? "")
          .join("");
      }

      if (!text && !msgData.tool_call_name && !msgData.name) continue;

      entries.push({
        role,
        text: text || `(${msgData.tool_call_name || msgData.name || "unknown"})`,
        tool: (msgData.tool_call_name as string) || (msgData.name as string),
        timestamp: msgData.time ? (msgData.time as { created?: number }).created : undefined,
      });

      if (entries.length >= maxEntries) break;
    }

    return entries;
  } catch (e) {
    log.warn("db readHistory failed:", (e as Error).message);
    return [];
  } finally {
    db?.close();
  }
}

function readFirstPromptFromDb(dbPath: string, sessionId: string): string {
  let db: Database | undefined;
  try {
    db = openDb(dbPath);
    const row = db.prepare(
      `SELECT m.data FROM message m
       WHERE m.session_id = ?
         AND json_extract(m.data, '$.role') = 'user'
       ORDER BY m.time_created ASC
       LIMIT 1`,
    ).get<{ data: string }>(sessionId);
    if (!row) return "";

    const msgData = parseJson(row.data);
    if (!msgData) return "";

    if (Array.isArray(msgData.content)) {
      return (msgData.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c && c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim();
    }
    return "";
  } catch (e) {
    log.warn("db readFirstPrompt failed:", (e as Error).message);
    return "";
  } finally {
    db?.close();
  }
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function roleFromDb(role?: unknown): HistoryEntry["role"] | undefined {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  return undefined;
}

/** Cross-platform "is this process still running?" check. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
