import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { exec } from "child_process";
import util from "util";
import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import session from "express-session";
import bcrypt from "bcryptjs";

// Extend express-session to include user
declare module 'express-session' {
  interface SessionData {
    user: { id: number; username: string; role: string };
  }
}

const { Pool } = pg;

function safeParse(str: any, fallback: any = {}) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    console.error("JSON parse error in server:", e);
    return fallback;
  }
}

function safeAiParse(text: string | undefined, fallback: any = {}) {
  if (!text) return fallback;
  try {
    const cleaned = text.replace(/```json\n?|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("AI JSON parse error:", e);
    return fallback;
  }
}

// Forces structured JSON output the same way Gemini's responseSchema used to,
// via Claude's tool-use: define one tool whose input_schema is the desired
// JSON shape, force the model to call it, and read the parsed input straight
// off the tool_use block (no text/fence parsing needed).
async function callClaudeJson(apiKey: string, model: string, prompt: string, schema: any, maxTokens: number = 4096): Promise<any> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    tools: [{
      name: "provide_structured_response",
      description: "Provide the analysis result in the required structured format.",
      input_schema: schema
    }],
    tool_choice: { type: "tool", name: "provide_structured_response" },
    messages: [{ role: "user", content: prompt }]
  });

  const toolUse = response.content.find((block: any) => block.type === "tool_use") as any;
  if (!toolUse) {
    throw new Error("Claude did not return a structured tool response.");
  }
  return toolUse.input;
}

// Calls a local Ollama instance directly (not through Open WebUI's proxy -
// its OpenAI-compatible endpoint enforces browser-only fetch metadata that
// server-side clients can't satisfy, confirmed by testing against a real
// instance) using Ollama's native structured-output support: `format` takes
// the actual JSON schema and constrains decoding to match it, which is more
// reliable than embedding the schema in the prompt and hoping. Ollama has no
// built-in auth, so apiKey is only sent if the user's setup happens to sit
// behind a reverse proxy that requires one.
async function callLocalAiJson(baseUrl: string, apiKey: string, model: string, prompt: string, schema: any, maxTokens: number = 4096): Promise<any> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      format: schema,
      options: { num_predict: maxTokens }
    })
  });

  if (!res.ok) {
    throw new Error(`Local AI request failed: ${res.status} ${res.statusText} - ${await res.text().catch(() => "")}`);
  }

  const data = await res.json();
  let content = data?.message?.content;
  if (!content) throw new Error("Local AI did not return any content.");

  // Defensive unwrap even though `format` should already constrain this:
  // reasoning models (e.g. deepseek-r1) can still prefix a <think> trace.
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  content = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`Local AI returned invalid JSON: ${(e as Error).message}`);
  }
}

// Picks the configured AI provider (Claude, or a local OpenAI-compatible
// endpoint) and returns a ready-to-call function plus a reason to skip if
// the chosen provider isn't configured yet - callers use this instead of
// duplicating the same "is a key/URL set" check three times.
function resolveAiProvider(modelSettingKey: string, defaultModel: string): { ready: boolean; skipReason: string; call: (prompt: string, schema: any, maxTokens?: number) => Promise<any> } {
  const provider = getSetting("ai_provider", "claude");

  if (provider === "local") {
    const baseUrl = getSetting("local_ai_base_url", "");
    const localApiKey = getSetting("local_ai_api_key", "");
    const localModel = getSetting("local_ai_model", "hermes3:latest");
    if (!baseUrl) {
      return { ready: false, skipReason: "Local AI base URL is not configured in settings.", call: async () => { throw new Error("Local AI is not configured."); } };
    }
    return { ready: true, skipReason: "", call: (prompt, schema, maxTokens) => callLocalAiJson(baseUrl, localApiKey, localModel, prompt, schema, maxTokens) };
  }

  const model = getSetting(modelSettingKey, defaultModel);
  const apiKey = getSetting("claude_api_key", process.env.ANTHROPIC_API_KEY || "");
  if (!apiKey || apiKey === "undefined" || apiKey === "null") {
    return { ready: false, skipReason: "Claude API Key is not configured in settings.", call: async () => { throw new Error("Claude is not configured."); } };
  }
  return { ready: true, skipReason: "", call: (prompt, schema, maxTokens) => callClaudeJson(apiKey, model, prompt, schema, maxTokens) };
}

// Fallback entities shown when Home Assistant is unreachable, so the UI has
// something to render instead of an empty screen. Shared by every route that
// needs to degrade gracefully when fetchHA() returns nothing.
const MOCK_HA_ENTITIES = [
  { entity_id: 'climate.zone_1_living_room', attributes: { friendly_name: 'Zone 1 (Living Room)' } },
  { entity_id: 'climate.zone_2_master', attributes: { friendly_name: 'Zone 2 (Master Bed)' } },
  { entity_id: 'climate.zone_3_kids', attributes: { friendly_name: 'Zone 3 (Kids Room)' } },
  { entity_id: 'climate.zone_4_basement', attributes: { friendly_name: 'Zone 4 (Basement)' } },
  { entity_id: 'person.chris', attributes: { friendly_name: 'Chris' } },
  { entity_id: 'device_tracker.kids_ipad', attributes: { friendly_name: 'Kids iPad' } },
  { entity_id: 'light.kitchen', attributes: { friendly_name: 'Kitchen Lights' } }
];

function filterTransitions(history: any[]) {
  const transitions: any[] = [];
  const lastStates: Record<string, string> = {};

  history.forEach(entry => {
    if (lastStates[entry.entity_id] !== entry.state) {
      transitions.push({
        entity_id: entry.entity_id,
        state: entry.state,
        last_changed: entry.last_changed
      });
      lastStates[entry.entity_id] = entry.state;
    }
  });

  return transitions;
}

const VALID_SCHEDULE_DAYS = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);

// Defense-in-depth against a bad AI run producing structurally-valid-JSON
// garbage (confirmed live: a local-model test once produced literal "..."
// placeholders and a date like "2023-05-01" in the "day" field, which
// silently made it into the live schedules table with no error at all).
// Provider quality varies, so this stays a plain code check rather than
// trusting any model to self-police its own output.
function isScheduleSane(schedule: any): { sane: boolean; reason?: string } {
  if (!schedule || !Array.isArray(schedule.schedule_data)) {
    return { sane: false, reason: "schedule_data is missing or not an array" };
  }
  if (schedule.schedule_data.length === 0) {
    return { sane: false, reason: "schedule_data is empty" };
  }
  for (const entry of schedule.schedule_data) {
    const textFields = [entry.day, entry.time, entry.action, entry.entity_id, entry.state];
    if (textFields.some(f => typeof f === "string" && f.trim() === "...")) {
      return { sane: false, reason: `entry contains a literal "..." placeholder instead of real content: ${JSON.stringify(entry)}` };
    }
    if (typeof entry.day !== "string" || !VALID_SCHEDULE_DAYS.has(entry.day)) {
      return { sane: false, reason: `entry has an invalid "day" (expected a weekday name, got ${JSON.stringify(entry.day)})` };
    }
    if (typeof entry.time !== "string" || !/^\d{1,2}:\d{2}$/.test(entry.time)) {
      return { sane: false, reason: `entry has an invalid "time" (expected HH:MM, got ${JSON.stringify(entry.time)})` };
    }
    if (typeof entry.entity_id !== "string" || !entry.entity_id.includes(".")) {
      return { sane: false, reason: `entry has an invalid "entity_id" (got ${JSON.stringify(entry.entity_id)})` };
    }
  }
  return { sane: true };
}

// Custody calendar support: the user's shared Google Calendar exports as a
// public/secret ICS feed where every day is covered by a contiguous "Busy"
// block in a 2-2-3 rotation (classic pattern: each block flips to the other
// parent, regardless of whether it's a 2-day or 3-day block - A,B,A,B,A,B...
// in sequence). The feed itself never says WHICH parent owns a given block,
// so a known anchor date + its owner is used to derive parity for any other
// date by counting blocks between them.
// KNOWN LIMITATION (tracked for later, see README roadmap): one-off swaps
// that get added as a separate overlapping calendar event are NOT detected -
// Google's ICS export strips the event description field entirely (public
// and "secret" feeds alike), which is where swap notes actually live. Seeing
// those reliably would require the full Google Calendar API with OAuth
// instead of a plain feed URL. Until then this only reflects the *default*
// rotation, which is an accepted tradeoff since ghost mode means it only
// affects AI suggestions, not real hardware control.
let custodyCache: { fetchedAt: number; blocks: { start: Date; end: Date }[] } | null = null;

function parseIcsDate(raw: string): Date | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

async function fetchCustodyBlocks(icsUrl: string): Promise<{ start: Date; end: Date }[]> {
  const now = Date.now();
  if (custodyCache && now - custodyCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return custodyCache.blocks;
  }
  const res = await fetch(icsUrl);
  if (!res.ok) throw new Error(`Failed to fetch custody calendar: ${res.status}`);
  const text = await res.text();
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const blocks: { start: Date; end: Date }[] = [];
  for (const chunk of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = chunk.split("END:VEVENT")[0];
    const startMatch = body.match(/DTSTART[^:]*:([^\r\n]+)/);
    const endMatch = body.match(/DTEND[^:]*:([^\r\n]+)/);
    if (!startMatch || !endMatch) continue;
    const start = parseIcsDate(startMatch[1]);
    const end = parseIcsDate(endMatch[1]);
    // Ignore anything shorter than a day: the calendar sometimes has short,
    // unrelated "Busy" entries (personal appointments) sitting nested inside
    // a real multi-day custody block. Sorted by start time alone, those would
    // otherwise slot in as a phantom extra block and throw off parity for
    // every date afterward - confirmed against real data before this filter
    // was added (the true blocks are always 2+ days).
    if (start && end && end.getTime() - start.getTime() >= 20 * 60 * 60 * 1000) {
      blocks.push({ start, end });
    }
  }
  blocks.sort((a, b) => a.start.getTime() - b.start.getTime());
  custodyCache = { fetchedAt: now, blocks };
  return blocks;
}

// Returns whether the kids are with the app's user (as opposed to the other
// parent) on the given date, per the default rotation - or null if the
// custody calendar isn't configured or the date falls outside the feed.
async function isKidsHomeOn(date: Date): Promise<boolean | null> {
  const icsUrl = getSetting("custody_calendar_ics_url", "");
  const anchorDateStr = getSetting("custody_anchor_date", "");
  const anchorOwner = getSetting("custody_anchor_owner", "user");
  if (!icsUrl || !anchorDateStr) return null;

  try {
    const blocks = await fetchCustodyBlocks(icsUrl);
    if (blocks.length === 0) return null;

    const anchorDate = new Date(anchorDateStr + "T12:00:00Z");
    const anchorIndex = blocks.findIndex(b => anchorDate >= b.start && anchorDate < b.end);
    const targetIndex = blocks.findIndex(b => date >= b.start && date < b.end);
    if (anchorIndex === -1 || targetIndex === -1) return null;

    const sameParityAsAnchor = (targetIndex - anchorIndex) % 2 === 0;
    const targetOwner = sameParityAsAnchor ? anchorOwner : (anchorOwner === "user" ? "other" : "user");
    return targetOwner === "user";
  } catch (e) {
    console.error("Failed to resolve custody schedule:", e);
    return null;
  }
}

// Initialize PostgreSQL Pool
let pgPool: pg.Pool | null = null;
let pgReady = false;
const dbUrl = process.env.DATABASE_URL;

if (dbUrl) {
  try {
    pgPool = new Pool({
      connectionString: dbUrl,
      // For local Ubuntu setup, we usually don't need SSL
      ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    
    // Test connection immediately
    pgPool.query('SELECT NOW()', async (err, res) => {
      if (err) {
        console.warn("PostgreSQL connection failed (check DATABASE_URL):", err.message);
      } else {
        console.log("PostgreSQL connected successfully.");
        // Initialize PostgreSQL schema
        try {
          await pgPool?.query(`
            CREATE TABLE IF NOT EXISTS device_history (
              id SERIAL PRIMARY KEY,
              entity_id TEXT,
              state TEXT,
              attributes TEXT,
              last_changed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS schedules (
              id SERIAL PRIMARY KEY,
              name TEXT,
              description TEXT,
              schedule_data TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
          
            CREATE TABLE IF NOT EXISTS tracked_entities (
              entity_id TEXT PRIMARY KEY,
              tracked BOOLEAN DEFAULT TRUE,
              notes TEXT DEFAULT ''
            );
          
            CREATE TABLE IF NOT EXISTS insights (
              id SERIAL PRIMARY KEY,
              content TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
          
            CREATE TABLE IF NOT EXISTS ai_reasoning (
              id SERIAL PRIMARY KEY,
              context TEXT,
              decision TEXT,
              reasoning TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS users (
              id SERIAL PRIMARY KEY,
              username TEXT UNIQUE,
              password TEXT,
              role TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT
            );
          `);
          console.log("PostgreSQL schema initialized successfully.");
          pgReady = true;
        } catch (schemaErr) {
          console.error("Failed to initialize PostgreSQL schema:", schemaErr);
        }
      }
    });
  } catch (e) {
    console.error("PostgreSQL initialization failed:", e);
  }
} else {
  console.log("PostgreSQL not configured (DATABASE_URL missing). Using SQLite only.");
}

const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Initialize SQLite Database
const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "home_brain.db");
const OLD_DB_PATH = path.join(process.cwd(), "home_brain.db");

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  console.log(`Creating data directory at ${DB_DIR}`);
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Move database if it exists in the old location
if (fs.existsSync(OLD_DB_PATH) && !fs.existsSync(DB_PATH)) {
  console.log(`Moving database from ${OLD_DB_PATH} to ${DB_PATH}`);
  fs.renameSync(OLD_DB_PATH, DB_PATH);
}

const db = new Database(DB_PATH);

// Persist sessions in SQLite so logins survive server restarts (the default
// express-session MemoryStore drops every session on process exit).
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER
  );
`);
db.prepare("DELETE FROM sessions WHERE expires IS NOT NULL AND expires < ?").run(Date.now());

class SqliteSessionStore extends session.Store {
  get(sid: string, callback: (err: any, session?: any) => void) {
    try {
      const row = db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?").get(sid) as any;
      if (!row) return callback(null, null);
      if (row.expires && row.expires < Date.now()) {
        db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (e) {
      callback(e);
    }
  }

  set(sid: string, sessionData: any, callback?: (err?: any) => void) {
    try {
      const expires = sessionData.cookie?.expires ? new Date(sessionData.cookie.expires).getTime() : null;
      db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = ?, expires = ?")
        .run(sid, JSON.stringify(sessionData), expires, JSON.stringify(sessionData), expires);
      callback?.();
    } catch (e) {
      callback?.(e);
    }
  }

  destroy(sid: string, callback?: (err?: any) => void) {
    try {
      db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      callback?.();
    } catch (e) {
      callback?.(e);
    }
  }

  touch(sid: string, sessionData: any, callback?: (err?: any) => void) {
    this.set(sid, sessionData, callback);
  }
}

app.use(session({
  store: new SqliteSessionStore(),
  secret: process.env.SESSION_SECRET || "home-brain-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

const CURRENT_DB_VERSION = 5; // Increment this when adding new migrations

function parseUserContext(rawValue: string): string {
  if (!rawValue) return "";
  try {
    const parsed = safeParse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.map((n: any, i: number) => `${i + 1}. ${n.text}`).join('\n');
    }
    return `1. ${rawValue}`;
  } catch (e) {
    return `1. ${rawValue}`;
  }
}

function initializeDatabase() {
  console.log("Initializing database...");
  
  // 1. Create core settings table first to track version
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // 2. Check current version
  const getVer = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get() as any;
  let currentVersion = getVer ? parseInt(getVer.value) : 0;
  
  console.log(`Current DB Version: ${currentVersion}, Target Version: ${CURRENT_DB_VERSION}`);

  // 3. Initial Schema (Version 1)
  if (currentVersion < 1) {
    console.log("Applying Migration: Version 1 (Initial Schema)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT,
        state TEXT,
        attributes TEXT,
        last_changed DATETIME DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        description TEXT,
        schedule_data TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    
      CREATE TABLE IF NOT EXISTS tracked_entities (
        entity_id TEXT PRIMARY KEY,
        tracked BOOLEAN DEFAULT 1
      );
    
      CREATE TABLE IF NOT EXISTS insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    
      CREATE TABLE IF NOT EXISTS ai_reasoning (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context TEXT,
        decision TEXT,
        reasoning TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
      );
    
      CREATE TABLE IF NOT EXISTS ha_system_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    
      CREATE TABLE IF NOT EXISTS occupancy_roster (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        entity_id TEXT,
        status TEXT DEFAULT 'unknown',
        is_tracked INTEGER DEFAULT 1
      );
    
      CREATE TABLE IF NOT EXISTS logbook_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT,
        message TEXT,
        when_ts DATETIME,
        context_user_id TEXT,
        domain TEXT,
        attributes TEXT
      );

      -- Reserved for future use: currently only copied by the SQLite<->Postgres
      -- migration, no route reads or populates it from Home Assistant yet.
      CREATE TABLE IF NOT EXISTS ha_rules (
        entity_id TEXT PRIMARY KEY,
        name TEXT,
        domain TEXT,
        state TEXT,
        attributes TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    
      CREATE TABLE IF NOT EXISTS ha_automations_scripts (
        entity_id TEXT PRIMARY KEY,
        name TEXT,
        domain TEXT,
        content TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    
      CREATE INDEX IF NOT EXISTS idx_device_history_entity_time ON device_history(entity_id, last_changed);
      CREATE INDEX IF NOT EXISTS idx_device_history_time ON device_history(last_changed);
      CREATE INDEX IF NOT EXISTS idx_logbook_time ON logbook_history(when_ts);
      CREATE INDEX IF NOT EXISTS idx_logbook_entity ON logbook_history(entity_id);
    `);
    
    currentVersion = 1;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(String(currentVersion));
  }

  // 4. Sequential Migrations
  if (currentVersion < 2) {
    console.log("Applying Migration: Version 2 (Adding notes to tracked_entities)");
    try {
      db.exec("ALTER TABLE tracked_entities ADD COLUMN notes TEXT DEFAULT ''");
    } catch (e) {
      console.warn("Migration V2 Warning: 'notes' column might already exist.");
    }
    currentVersion = 2;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(String(currentVersion));
  }

  if (currentVersion < 3) {
    console.log("Applying Migration: Version 3 (Adding is_tracked to occupancy_roster)");
    try {
      db.exec("ALTER TABLE occupancy_roster ADD COLUMN is_tracked INTEGER DEFAULT 1");
    } catch (e) {
      console.warn("Migration V3 Warning: 'is_tracked' column might already exist.");
    }
    currentVersion = 3;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(String(currentVersion));
  }

  if (currentVersion < 4) {
    console.log("Applying Migration: Version 4 (Hashing plaintext user passwords)");
    try {
      const users = db.prepare("SELECT id, password FROM users").all() as any[];
      const rehash = db.prepare("UPDATE users SET password = ? WHERE id = ?");
      for (const user of users) {
        // bcrypt hashes always start with $2a$/$2b$/$2y$ - anything else is legacy plaintext.
        if (!/^\$2[aby]\$/.test(user.password || "")) {
          rehash.run(bcrypt.hashSync(user.password || "", 10), user.id);
        }
      }
    } catch (e) {
      console.warn("Migration V4 Warning: failed to hash existing passwords.", e);
    }
    currentVersion = 4;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(String(currentVersion));
  }

  if (currentVersion < 5) {
    console.log("Applying Migration: Version 5 (Replacing stale Gemini ai_model value)");
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'ai_model'").get() as any;
      if (row && row.value && row.value.startsWith("gemini-")) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'ai_model'").run("claude-sonnet-5");
      }
    } catch (e) {
      console.warn("Migration V5 Warning: failed to replace stale ai_model value.", e);
    }
    currentVersion = 5;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(String(currentVersion));
  }

  // 5. Default Settings & Admin User
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  insertSetting.run("ha_url", "http://homeassistant.local:8123");
  insertSetting.run("ha_token", "");
  insertSetting.run("user_ai_context", JSON.stringify([
    {
      id: "seed-household-context",
      text: "Chris is the primary resident, with a professional anchor of an early morning departure (~6:00 AM) and a coastal commute — treat this as the working baseline when it recurs 3+ times a week. Key devices that indicate a 'Project State' when active: a Dell PowerEdge server and a Bambu X1C 3D printer. A Blackstone griddle indicates outdoor cooking/hosting. The solar/heat pump system is branded 'Utility Zero' — cross-reference its production data with Chris's presence to see if projects start when solar production is high."
    }
  ]));
  insertSetting.run("dashboard_graph_zones", "[]");
  insertSetting.run("ai_realtime_interval", "5");
  insertSetting.run("ai_lookback_days", "60");
  insertSetting.run("ai_context_window_hours", "2");
  insertSetting.run("ai_daily_analysis_hour", "3");
  insertSetting.run("ai_model", "claude-sonnet-5");
  insertSetting.run("ai_model_realtime", "claude-haiku-4-5-20251001");
  insertSetting.run("ai_realtime_enabled", "false");
  insertSetting.run("ai_provider", "claude");
  insertSetting.run("local_ai_base_url", "");
  insertSetting.run("local_ai_api_key", "");
  insertSetting.run("local_ai_model", "hermes3:latest");
  insertSetting.run("custody_calendar_ics_url", "");
  insertSetting.run("custody_anchor_date", "");
  insertSetting.run("custody_anchor_owner", "user");
  insertSetting.run("custody_kids_zones", "");
  insertSetting.run("custody_away_setback", "4");
  insertSetting.run("climate_abs_min", "55");
  insertSetting.run("climate_abs_max", "80");
  insertSetting.run("dashboard_default_timeframe", "24h");
  insertSetting.run("ghost_mode_hvac", "true");
  insertSetting.run("ghost_mode_whole_home", "true");
  insertSetting.run("github_branch", "main");

  const insertUser = db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)");
  insertUser.run("admin", bcrypt.hashSync("admin", 10), "admin");

  console.log("Database initialization complete.");
}

// Helper to get setting with fallback
function getSetting(key: string, fallback: string): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
    return row?.value ?? fallback;
  } catch (err) {
    console.error(`Error fetching setting ${key}:`, err);
    return fallback;
  }
}

initializeDatabase();

// --- WebSocket Setup ---
const wss = new WebSocketServer({ noServer: true });

function broadcastToFrontend(message: any) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

let haWs: WebSocket | null = null;
let haMessageId = 1;
let haStatus = 'disconnected';
let haError = '';
let haReconnectTimeout: NodeJS.Timeout | null = null;
let haHeartbeatInterval: NodeJS.Timeout | null = null;
let haLastPongAt = 0;

function setHaStatus(status: string, error = '') {
  haStatus = status;
  haError = error;
  broadcastToFrontend({ type: 'HA_STATUS', status, error });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fillHistoryGaps(fullSync = false) {
  try {
    console.log(fullSync ? "Starting full history sync..." : "Checking for history gaps...");
    
    const trackedRows = db.prepare("SELECT entity_id FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    
    const lookbackDays = Number(getSetting("ai_lookback_days", "60"));
    
    // Task: Robust Entity Search
    // Fetch all states to find all relevant entities for a "complete" picture
    const allStates = await fetchHA('/api/states');
    let entitiesToFetch = new Set<string>(trackedIds);
    
    const importantDomains = [
      'climate.', 'sensor.', 'binary_sensor.', 'person.', 'device_tracker.', 
      'light.', 'switch.', 'input_boolean.', 'input_select.', 'input_number.', 
      'input_datetime.', 'lock.', 'cover.', 'fan.', 'humidifier.', 'water_heater.'
    ];

    if (allStates && Array.isArray(allStates)) {
      for (const stateObj of allStates) {
        const eid = stateObj.entity_id;
        const isImportant = importantDomains.some(domain => eid.startsWith(domain));
        
        // Filter sensors to avoid noise (like uptime, version, etc) unless tracked
        if (isImportant) {
          if (eid.startsWith('sensor.')) {
            const lower = eid.toLowerCase();
            if (lower.includes('temp') || lower.includes('hum') || lower.includes('batt') || 
                lower.includes('occup') || lower.includes('power') || lower.includes('energy') || 
                lower.includes('illuminance') || lower.includes('co2') || lower.includes('presence')) {
              entitiesToFetch.add(eid);
            }
          } else {
            entitiesToFetch.add(eid);
          }
        }
      }
    }
    
    const entitiesArray = Array.from(entitiesToFetch);
    if (entitiesArray.length === 0) {
      console.log("No entities to fetch history for. Skipping history gap fill.");
      return;
    }

    console.log(`Checking history for ${entitiesArray.length} entities over ${lookbackDays} days...`);
    const insertHistory = db.prepare("INSERT OR IGNORE INTO device_history (entity_id, state, attributes, last_changed) VALUES (?, ?, ?, ?)");
    const insertLogbook = db.prepare("INSERT OR IGNORE INTO logbook_history (entity_id, message, when_ts, context_user_id, domain, attributes) VALUES (?, ?, ?, ?, ?, ?)");
    
    let entitiesProcessed = 0;
    const now = new Date();

    for (const entity_id of entitiesArray) {
      // Task: Day-by-Day Fetching
      for (let dayOffset = lookbackDays; dayOffset >= 0; dayOffset--) {
        const startTimeDate = new Date(now.getTime() - (dayOffset + 1) * 24 * 60 * 60 * 1000);
        const endTimeDate = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
        
        const startTime = startTimeDate.toISOString();
        const endTime = endTimeDate.toISOString();

        try {
          // 1. Fetch History for this day
          const historyUrl = `/api/history/period/${encodeURIComponent(startTime)}?filter_entity_id=${entity_id}&end_time=${encodeURIComponent(endTime)}`;
          const historyData = await fetchHA(historyUrl);
          
          if (historyData && Array.isArray(historyData)) {
            db.transaction(() => {
              for (const entityHistory of historyData) {
                for (const stateObj of entityHistory) {
                  let ts = stateObj.last_changed;
                  if (ts) {
                    try {
                      const d = new Date(ts);
                      if (!isNaN(d.getTime())) {
                        ts = d.toISOString().replace('T', ' ').replace('Z', '');
                      }
                    } catch (e) {}
                  }
                  insertHistory.run(stateObj.entity_id, stateObj.state, JSON.stringify(stateObj.attributes || {}), ts);
                }
              }
            })();
          }

          // 2. Fetch Logbook for this day
          const logbookUrl = `/api/logbook/${encodeURIComponent(startTime)}?entity=${entity_id}&end_time=${encodeURIComponent(endTime)}`;
          const logbookData = await fetchHA(logbookUrl);
          
          if (logbookData && Array.isArray(logbookData)) {
            db.transaction(() => {
              for (const entry of logbookData) {
                let ts = entry.when;
                if (ts) {
                  try {
                    const d = new Date(ts);
                    if (!isNaN(d.getTime())) {
                      ts = d.toISOString().replace('T', ' ').replace('Z', '');
                    }
                  } catch (e) {}
                }
                insertLogbook.run(
                  entry.entity_id || entity_id,
                  entry.message || '',
                  ts,
                  entry.context_user_id || null,
                  entry.domain || (entry.entity_id ? entry.entity_id.split('.')[0] : null),
                  JSON.stringify(entry)
                );
              }
            })();
          }

          // Small delay to avoid hammering HA too hard
          await sleep(100);
        } catch (err: any) {
          console.error(`Error fetching data for ${entity_id} on day -${dayOffset}:`, err.message);
        }
      }
      
      entitiesProcessed++;
      if (fullSync) {
        broadcastToFrontend({ 
          type: 'SYNC_PROGRESS', 
          progress: Math.round((entitiesProcessed / entitiesArray.length) * 100),
          entity: entity_id
        });
      }
      
      // Wait between entities
      await sleep(200);
    }
    
    console.log("History and Logbook sync complete.");
    if (fullSync) {
      broadcastToFrontend({ type: 'SYNC_COMPLETE' });
    }
  } catch (e) {
    console.error("Gap fill error", e);
  }
}

function isLocalAddress(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('.local') || 
         lowerUrl.includes('192.168.') || 
         lowerUrl.includes('10.') || 
         lowerUrl.includes('172.16.') || 
         lowerUrl.includes('172.17.') || 
         lowerUrl.includes('172.18.') || 
         lowerUrl.includes('172.19.') || 
         lowerUrl.includes('172.20.') || 
         lowerUrl.includes('172.21.') || 
         lowerUrl.includes('172.22.') || 
         lowerUrl.includes('172.23.') || 
         lowerUrl.includes('172.24.') || 
         lowerUrl.includes('172.25.') || 
         lowerUrl.includes('172.26.') || 
         lowerUrl.includes('172.27.') || 
         lowerUrl.includes('172.28.') || 
         lowerUrl.includes('172.29.') || 
         lowerUrl.includes('172.30.') || 
         lowerUrl.includes('172.31.') ||
         lowerUrl.includes('localhost') ||
         lowerUrl.includes('127.0.0.1');
}

function stopHaHeartbeat() {
  if (haHeartbeatInterval) {
    clearInterval(haHeartbeatInterval);
    haHeartbeatInterval = null;
  }
}

function startHaHeartbeat() {
  stopHaHeartbeat();
  haLastPongAt = Date.now();
  haHeartbeatInterval = setInterval(() => {
    if (!haWs || haWs.readyState !== WebSocket.OPEN) return;
    // No traffic (including our own pings) in 45s means the connection is
    // silently dead (e.g. a NAT/router timeout that never sends a close
    // frame) - terminate it so the close handler reconnects.
    if (Date.now() - haLastPongAt > 45000) {
      console.warn('[HA] No response in 45s, connection appears dead. Forcing reconnect.');
      haWs.terminate();
      return;
    }
    haWs.send(JSON.stringify({ id: haMessageId++, type: 'ping' }));
  }, 20000);
}

function connectToHA() {
  if (haReconnectTimeout) {
    clearTimeout(haReconnectTimeout);
    haReconnectTimeout = null;
  }
  stopHaHeartbeat();

  setHaStatus('connecting');
  const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }

  const ha_url = settings["ha_url"];
  const ha_token = settings["ha_token"];
  if (!ha_url || !ha_token) {
    setHaStatus('disconnected', 'Missing HA URL or Token');
    return;
  }

  if (!ha_url.startsWith('http')) {
    setHaStatus('disconnected', 'URL must start with http:// or https://');
    return;
  }

  const baseUrl = ha_url.endsWith('/') ? ha_url.slice(0, -1) : ha_url;
  
  if (isLocalAddress(baseUrl)) {
    console.warn(`[HA] Warning: Attempting to connect to a local address (${baseUrl}) from a cloud environment. This will likely fail unless a tunnel is established.`);
  }

  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/websocket';
  
  console.log(`Attempting to connect to HA at: ${wsUrl}`);
  
  if (haWs) {
    haWs.removeAllListeners();
    if (haWs.readyState === WebSocket.OPEN || haWs.readyState === WebSocket.CONNECTING) {
      try {
        haWs.close();
      } catch (e) {}
    }
    haWs = null;
  }

  try {
    haWs = new WebSocket(wsUrl);
    
    haWs.on('message', (data) => {
      haLastPongAt = Date.now(); // any traffic proves the connection is alive
      const msg = safeParse(data.toString());
      if (msg.type === 'auth_required') {
        haWs?.send(JSON.stringify({ type: 'auth', access_token: ha_token }));
      } else if (msg.type === 'auth_ok') {
        console.log('Connected to HA WebSocket');
        setHaStatus('connected');
        haWs?.send(JSON.stringify({ id: haMessageId++, type: 'subscribe_events', event_type: 'state_changed' }));
        fillHistoryGaps();
        startHaHeartbeat();
      } else if (msg.type === 'auth_invalid') {
        setHaStatus('disconnected', 'Invalid Access Token');
        console.error('HA WS Auth Invalid');
      } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
        const entity_id = msg.event.data.entity_id;
        const state = msg.event.data.new_state?.state;
        const attributes = JSON.stringify(msg.event.data.new_state?.attributes || {});
        
        const insertHistory = db.prepare("INSERT OR IGNORE INTO device_history (entity_id, state, attributes, last_changed) VALUES (?, ?, ?, datetime('now'))");
        const info = insertHistory.run(entity_id, state, attributes);
        
        if (pgPool && pgReady) {
          try {
            pgPool.query(
              "INSERT INTO device_history (entity_id, state, attributes, last_changed) VALUES ($1, $2, $3, $4)",
              [entity_id, state, attributes, new Date().toISOString()]
            );
          } catch (e) {
            console.error("Failed to save history to PostgreSQL:", e);
          }
        }
        
        const newRecord = db.prepare("SELECT * FROM device_history WHERE id = ?").get(info.lastInsertRowid);
        
        // Real-time Self-Correction Logic
        // Only fire when someone actually just arrived home (a genuine
        // not-home -> home transition), not on every attribute-only update
        // (GPS/battery/etc.) HA sends while an entity stays "home". Also
        // debounce against flapping trackers/connectivity: if this same
        // entity was already "home" within the last 10 minutes, treat this
        // as a bounce rather than a fresh arrival worth alerting on.
        const oldState = msg.event.data.old_state?.state;
        if ((entity_id.startsWith('person.') || entity_id.startsWith('device_tracker.')) && state === 'home' && oldState !== 'home') {
           const recentHome = db.prepare(`
             SELECT id FROM device_history
             WHERE entity_id = ? AND state = 'home' AND id != ? AND last_changed >= datetime('now', '-10 minutes')
             ORDER BY last_changed DESC LIMIT 1
           `).get(entity_id, info.lastInsertRowid);

           if (!recentHome) {
             const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))");
             insertReasoning.run(
               "Real-time Presence Event",
               "Self-Correction Triggered",
               `Detected ${entity_id} arriving home unexpectedly or triggering a state change. Overriding schedule to ensure comfort in active zones.`
             );
             broadcastToFrontend({ type: 'NEW_REASONING' });
           }
        }

        // Broadcast to frontend (guard in case the row lookup somehow misses)
        if (newRecord) broadcastToFrontend({ type: 'NEW_HISTORY', data: newRecord });
      }
    });

    haWs.on('error', (err) => {
      console.error('HA WS Error:', err.message);
      let errorMsg = err.message;
      if (errorMsg.includes('ENOTFOUND')) errorMsg = 'Address not found (DNS failure)';
      else if (errorMsg.includes('ECONNREFUSED')) errorMsg = 'Connection refused (Check port/firewall)';
      else if (errorMsg.includes('ETIMEDOUT')) errorMsg = 'Connection timed out';

      stopHaHeartbeat();
      setHaStatus('disconnected', errorMsg);
    });

    haWs.on('close', (code, reason) => {
      console.log(`HA WS Closed (Code: ${code}, Reason: ${reason}). Reconnecting in 5s...`);
      stopHaHeartbeat();
      setHaStatus('disconnected', reason.toString() || `Closed with code ${code}`);
      if (!haReconnectTimeout) {
        haReconnectTimeout = setTimeout(connectToHA, 5000);
      }
    });
  } catch (err) {
    console.error('Failed to connect to HA WS:', err);
    setHaStatus('disconnected');
    if (!haReconnectTimeout) {
      haReconnectTimeout = setTimeout(connectToHA, 5000);
    }
  }
}

// --- HA REST API Helper ---
async function fetchHA(endpoint: string, timeoutMs = 30000) {
  const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }
  const ha_url = settings["ha_url"];
  const ha_token = settings["ha_token"];
  if (!ha_url || !ha_token) {
    console.warn("[HA REST] Missing URL or Token in settings.");
    return null;
  }

  const baseUrl = ha_url.endsWith('/') ? ha_url.slice(0, -1) : ha_url;
  const endpointUrl = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const fullUrl = `${baseUrl}${endpointUrl}`;

  if (isLocalAddress(baseUrl)) {
    console.warn(`[HA REST] Warning: Using local address ${baseUrl}. This may fail in cloud environments.`);
    // Prevent infinite loops if ha_url points to this server
    if (baseUrl.includes(`localhost:${PORT}`) || baseUrl.includes(`0.0.0.0:${PORT}`) || baseUrl.includes(`127.0.0.1:${PORT}`)) {
      throw new Error(`HA URL points to the local HomeBrain server (${baseUrl}). This would cause an infinite loop. Please check your Home Assistant URL in Settings.`);
    }
  }

  console.log(`[HA REST] Fetching: ${fullUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(fullUrl, {
      headers: {
        "Authorization": `Bearer ${ha_token}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[HA REST] Error ${res.status}: ${errorText}`);
      throw new Error(`HA API Error (${res.status} ${res.statusText}) on ${endpointUrl}: ${errorText}`);
    }
    return res.json();
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`HA API Timeout (${timeoutMs/1000}s) on ${endpointUrl}. Check if your HA instance is reachable.`);
    }
    console.error(`[HA REST] Fetch failed for ${fullUrl}:`, err.message);
    throw err;
  }
}

async function callHAService(domain: string, service: string, serviceData: any) {
  const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }
  const ha_url = settings["ha_url"];
  const ha_token = settings["ha_token"];
  if (!ha_url || !ha_token) return null;

  const baseUrl = ha_url.endsWith('/') ? ha_url.slice(0, -1) : ha_url;

  const res = await fetch(`${baseUrl}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${ha_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(serviceData)
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HA Service Error (${res.status} ${res.statusText}) on ${domain}/${service}: ${errorText}`);
  }
  return res.json();
}

// --- Telegram Alerting ---
async function sendTelegramAlert(message: string) {
  const token = getSetting("telegram_bot_token", process.env.TELEGRAM_BOT_TOKEN || "");
  const chatId = getSetting("telegram_chat_id", process.env.TELEGRAM_CHAT_ID || "");
  if (!token || !chatId) {
    console.warn("Telegram alerting not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing)");
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🚨 *HomeBrain AI Alert*\n\n${message}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error("Failed to send Telegram alert", e);
  }
}

// --- Daily AI Analysis ---
async function runDailyAnalysis() {
  try {
    const lookbackDays = Number(getSetting("ai_lookback_days", "60"));
    const climateAbsMin = getSetting("climate_abs_min", "55");
    const climateAbsMax = getSetting("climate_abs_max", "80");
    const climateMasterHome = getSetting("climate_master_home", "72");
    const climateMasterAway = getSetting("climate_master_away", "65");
    const climateMasterNight = getSetting("climate_master_night", "68");
    const climateZoneModifiers = safeParse(getSetting("climate_zone_modifiers", "{}"), {});
    const custodyKidsZones = getSetting("custody_kids_zones", "").split(",").map(z => z.trim()).filter(Boolean);
    const custodyAwaySetback = Number(getSetting("custody_away_setback", "4"));

    let custodySchedule: { date: string; kidsHome: boolean | null }[] = [];
    if (getSetting("custody_calendar_ics_url", "")) {
      for (let i = 0; i < 14; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + i);
        const kidsHome = await isKidsHomeOn(d);
        custodySchedule.push({ date: d.toISOString().slice(0, 10), kidsHome });
      }
    }

    const ai = resolveAiProvider("ai_model", "claude-sonnet-5");
    if (!ai.ready) {
      console.warn(`${ai.skipReason} Skipping daily analysis.`);
      return {};
    }

    // Fetch context
    const states = await fetchHA('/api/states') || [];
    
    let trackedRows: any[] = [];
    let occupancyRows: any[] = [];
    let settingsRow: any = null;

    if (pgPool && pgReady) {
      const tRes = await pgPool.query("SELECT entity_id, notes FROM tracked_entities WHERE tracked = true");
      trackedRows = tRes.rows;
      const oRes = await pgPool.query("SELECT entity_id, name as notes FROM occupancy_roster WHERE is_tracked = 1");
      occupancyRows = oRes.rows;
      const sRes = await pgPool.query("SELECT value FROM settings WHERE key = 'user_ai_context'");
      settingsRow = sRes.rows[0];
    } else {
      trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[] || [];
      occupancyRows = db.prepare("SELECT entity_id, name as notes FROM occupancy_roster WHERE is_tracked = 1").all() as any[] || [];
      settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'user_ai_context'").get() as any;
    }
    
    // Combine and deduplicate
    const allTracked = [...trackedRows];
    occupancyRows.forEach(occ => {
      if (!allTracked.find(t => t.entity_id === occ.entity_id)) {
        allTracked.push(occ);
      }
    });

    const trackedIds = allTracked.map(t => t.entity_id);
    
    let history: any[] = [];
    let logbook: any[] = [];
    if (trackedIds.length > 0) {
      if (pgPool && pgReady) {
        const hRes = await pgPool.query(`
          SELECT entity_id, state, attributes, last_changed 
          FROM device_history 
          WHERE last_changed >= NOW() - INTERVAL '${lookbackDays} days'
          AND entity_id = ANY($1)
          ORDER BY last_changed ASC
        `, [trackedIds]);
        history = hRes.rows;

        const lRes = await pgPool.query(`
          SELECT entity_id, message, when_ts, domain 
          FROM logbook_history 
          WHERE when_ts >= NOW() - INTERVAL '${lookbackDays} days'
          AND entity_id = ANY($1)
          ORDER BY when_ts ASC
        `, [trackedIds]);
        logbook = lRes.rows;
      } else {
        const placeholders = trackedIds.map(() => '?').join(',');
        history = db.prepare(`
          SELECT entity_id, state, attributes, last_changed 
          FROM device_history 
          WHERE last_changed >= datetime('now', '-${lookbackDays} days') 
          AND entity_id IN (${placeholders})
          ORDER BY last_changed ASC
        `).all(...trackedIds) as any[] || [];

        logbook = db.prepare(`
          SELECT entity_id, message, when_ts, domain 
          FROM logbook_history 
          WHERE when_ts >= datetime('now', '-${lookbackDays} days') 
          AND entity_id IN (${placeholders})
          ORDER BY when_ts ASC
        `).all(...trackedIds) as any[] || [];
      }
    }

    const userContextRaw = settingsRow ? settingsRow.value : "";
    const userContext = parseUserContext(userContextRaw);

    let snapshotRaw = null;
    if (pgPool && pgReady) {
      const snapRes = await pgPool.query("SELECT data FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 1");
      snapshotRaw = snapRes.rows[0]?.data;
    } else {
      const snapshotRow = db.prepare("SELECT data FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 1").get() as any;
      snapshotRaw = snapshotRow?.data;
    }
    const systemSnapshot = snapshotRaw ? safeParse(snapshotRaw) : {};

    let automationsScripts: any[] = [];
    if (pgPool && pgReady) {
      const autoRes = await pgPool.query("SELECT entity_id, name, domain, content FROM ha_automations_scripts");
      automationsScripts = autoRes.rows;
    } else {
      automationsScripts = db.prepare("SELECT entity_id, name, domain, content FROM ha_automations_scripts").all() as any[] || [];
    }

    const now = new Date();
    const currentTimeUTC = now.toISOString();
    const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const currentTimeLocal = now.toLocaleString('en-US', { timeZone: serverTimeZone, timeZoneName: 'short' });
    const currentDayOfWeek = now.toLocaleDateString('en-US', { timeZone: serverTimeZone, weekday: 'long' });

    // Live weather/climate readings, fetched fresh right now - the
    // ha_system_snapshots row used for SYSTEM SNAPSHOT below is only
    // refreshed when the user manually syncs, so it can be stale; current
    // conditions (temperature, forecast, humidity) matter for
    // pre-conditioning decisions and shouldn't depend on that.
    const currentConditions = states.filter((s: any) =>
      s.entity_id.startsWith('weather.') || s.entity_id.startsWith('climate.')
    );

    const filteredHistory = filterTransitions(history);

    const prompt = `
      You are the HomeBrain Intelligence Engine. Your core logic is built on "Behavioral Heuristics"—you do not just see logs; you see human intent.

      ### CORE LOGIC ADJUSTMENTS:
      1. THE ANCHOR RULE: Identify "Professional Anchors" for the household's residents (e.g., a consistent early-morning departure and commute pattern). When a pattern occurs 3+ times a week, define the median times as the "Working Baseline." Use USER PROVIDED CONTEXT below for the specific residents and their known routines.
      2. DEVICE PROXY LOGIC:
         - If lights are OFF but a person is HOME, prioritize the state "Sleeping/Resting" over "Inactive."
         - High activity/wattage on any specific workstation, workshop, or hobby devices named in USER PROVIDED CONTEXT indicates a "Project State."
         - If kitchen or outdoor-cooking entities named in USER PROVIDED CONTEXT are active, enter "Cooking/Hosting State."
      3. TRANSITION ANALYSIS:
         - A "Home -> Not Home -> Home" sequence under 90 minutes is an "Errand."
         - A "Not Home" state lasting >10 hours is "Overtime/Project Site."
      4. ENVIRONMENTAL CORRELATION: Cross-reference any solar/heat-pump production data named in USER PROVIDED CONTEXT with resident presence. Does activity increase when solar production is high?

      ### CLIMATE TARGET PREFERENCES (set by the user - use these as your baseline, do not invent your own targets):
      - Home Mode master target: ${climateMasterHome}°F
      - Away Mode master target: ${climateMasterAway}°F
      - Night Mode master target: ${climateMasterNight}°F
      - Per-zone offsets (add to the master target for that zone's mode; zero if a zone isn't listed): ${JSON.stringify(climateZoneModifiers)}
      - Absolute safety bounds - NEVER schedule a temperature outside this range regardless of any other reasoning: ${climateAbsMin}°F to ${climateAbsMax}°F
For every climate/HVAC schedule entry, populate target_temperature as (master temp for that entry's mode) + (that zone's offset), then adjust only modestly from that baseline if strong historical evidence supports it (e.g. pre-conditioning lead time) - explain any such deviation in the entry's reasoning. Use "state" for the HVAC mode (heat_cool/cool/eco/etc.), not for the temperature.
${custodySchedule.length > 0 ? `
      ### HOUSEHOLD CUSTODY SCHEDULE (from the family calendar - this is KNOWN, ground-truth data, do NOT try to re-derive it from presence history):
      Kids' zones: ${JSON.stringify(custodyKidsZones)}
      For each date below where kidsHome is false, set those zones to (their normal target_temperature) ${custodyAwaySetback}°F further from comfortable (warmer in cooling season, cooler in heating season) to save energy while they're away - still respecting the absolute safety bounds above. A null value means the custody schedule couldn't be resolved for that date; treat it as unknown and use normal targets.
      ${JSON.stringify(custodySchedule)}
      KNOWN LIMITATION: this reflects the default rotation only - one-off swaps entered as a separate calendar event are not yet visible to this system, so it may occasionally be wrong on an exception day.
` : ''}
      ### ANALYSIS GOALS:
      1. Generate a rolling ${lookbackDays}-day schedule.
      2. For custody: use the HOUSEHOLD CUSTODY SCHEDULE above if provided (it's ground truth) rather than inferring it from presence data. Otherwise, infer long-term seasonal or monthly patterns based on presence patterns in the ${lookbackDays}-day history.
      3. Infer school/work arrival/departure times and pre-heat/pre-cool appropriate zones, accounting for weekly variations.
      4. Identify "Ghost" patterns (recurring times when the house is empty but HVAC is active).
      5. Provide detailed reasoning for every schedule block.
      6. LEARN FROM USER AUTOMATIONS: I have provided a list of your existing Home Assistant automations and scripts. Use these to understand how you group actions (e.g., "Night Mode", "Away Mode", "Arriving Home") and what triggers you typically use (e.g., sunrise, sunset, presence).
      7. GLOBAL HOUSE MODES: Transition from basic temperature scheduling to a state-based mode engine (e.g., Night, Away, Home). Factor the current and upcoming "Mode" into your decisions.
      8. PREDICTIVE PRE-CONDITIONING: Calculate "Thermal Inertia" from the device_history (e.g., recognizing how long a room takes to drop 2 degrees) and factor in external elements like humidity to trigger HVAC ahead of schedule.
      9. SCRIPT EXECUTION PRIORITY: Prioritize triggering existing Home Assistant scripts or automations using the Long-Lived Access Token.
      10. TRANSITIONAL DATA ANALYSIS: Focus on state changes (transitions) rather than static states. Use these transition timestamps to build your schedule, as they represent the actual events.

      ### OUTPUT STYLE:
      Always analyze data chronologically. Before answering, perform an internal "Chain of Thought" step to identify consistency vs. outliers. Speak as a collaborative partner in managing the home.
      
      USER PROVIDED CONTEXT:
      ${userContext}

      CURRENT DATE/TIME: ${currentTimeLocal} (${currentDayOfWeek}) - use this to anchor which day the schedule starts from and how recent the history below actually is.
      TIMEZONE NOTE: all timestamps in "Recent History" and "Logbook Events" below are stored in UTC (currently ${currentTimeUTC}), NOT the server's local time shown above. When you produce schedule times ("time" field) or reason about clock times in your output, convert to and express them in the server's local time zone (${serverTimeZone}), since that's the household's real wall-clock time - do not output raw UTC hours as if they were local.
      CURRENT CONDITIONS (live weather/climate, fetched just now): ${JSON.stringify(currentConditions)}

      SYSTEM SNAPSHOT (Full Entity List & Config, may be from an earlier manual sync): ${JSON.stringify(systemSnapshot)}
      USER AUTOMATIONS & SCRIPTS (For Learning Patterns): ${JSON.stringify(automationsScripts)}
      Tracked Devices (including People): ${JSON.stringify(allTracked)}
      Recent History (State Transitions Only): ${JSON.stringify(filteredHistory.slice(-1000))}
      Logbook Events (Last ${lookbackDays} Days): ${JSON.stringify(logbook.slice(-500))}

      REMINDER: every schedule_data entry whose entity_id starts with "climate." MUST include a numeric target_temperature field (master temp for that mode + zone offset, per CLIMATE TARGET PREFERENCES above). Do not leave it blank or omit it for climate entries - "state" alone (heat_cool/cool/eco/etc.) is not sufficient.

      Return a JSON object with:
      {
        "insights": ["insight 1", ...],
        "reasoning": [{ "context": "...", "decision": "...", "reasoning": "...", "evidence": "Specific data points observed..." }],
        "schedule": { "name": "...", "description": "...", "schedule_data": [{ "day": "...", "time": "...", "action": "...", "entity_id": "...", "state": "...", "target_temperature": 72, "reasoning": "...", "evidence": "..." }] }
      }
    `;

    const result = await ai.call(prompt, {
      type: "object",
      properties: {
        insights: {
          type: "array",
          items: { type: "string" }
        },
        reasoning: {
          type: "array",
          items: {
            type: "object",
            properties: {
              context: { type: "string" },
              decision: { type: "string" },
              reasoning: { type: "string" },
              evidence: { type: "string", description: "Specific data points or history events that support this decision" }
            },
            required: ["context", "decision", "reasoning", "evidence"]
          }
        },
        schedule: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            schedule_data: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  day: { type: "string", description: "Day of the week (e.g., Monday)" },
                  time: { type: "string", description: "Time in 24h format (e.g., 07:30)" },
                  action: { type: "string", description: "Friendly description of the action (e.g., Turn on kitchen lights)" },
                  entity_id: { type: "string" },
                  state: { type: "string", description: "For climate entities this is ONLY the bare HVAC mode word: 'heat_cool', 'cool', 'heat', 'eco', 'idle', or 'off'. Correct: \"cool\". WRONG - never do this: \"cool_72\", \"cool-72F\", \"away_setback_65\". The temperature always goes in the separate target_temperature field below, never appended to or combined with state. For lights/switches, use on/off." },
                  target_temperature: { type: "number", description: "For climate entities (entity_id starting with 'climate.'): the target temperature in °F, computed as master temp for that mode + that zone's offset from CLIMATE TARGET PREFERENCES. For any non-climate entity (lights, switches, etc.), this field is not applicable - set it to exactly 0 as a sentinel rather than a real temperature." },
                  reasoning: { type: "string", description: "Specific reasoning for this individual event" },
                  evidence: { type: "string", description: "The specific data point (e.g. motion sensor trigger time) that led to this schedule entry" }
                },
                // Claude's tool-use doesn't reliably honor `required` here - it silently
                // omits the field regardless (documented dead end after several attempts).
                // Local Ollama models genuinely enforce required fields via grammar-
                // constrained decoding, so only force it for that provider.
                required: getSetting("ai_provider", "claude") === "local"
                  ? ["day", "time", "action", "entity_id", "state", "target_temperature", "evidence"]
                  : ["day", "time", "action", "entity_id", "state", "evidence"]
              }
            }
          },
          required: ["name", "schedule_data"]
        }
      },
      required: ["insights", "reasoning", "schedule"]
    }, 16384);

    if (!result.schedule) {
      throw new Error("AI returned invalid JSON format or missing schedule. Please try again.");
    }
    
    // Save analysis
    if (result.schedule && result.schedule.name) {
      const sanityCheck = isScheduleSane(result.schedule);
      if (!sanityCheck.sane) {
        console.error(`Refusing to save AI-generated schedule - failed sanity check: ${sanityCheck.reason}`);
        await sendTelegramAlert(`AI schedule generation produced invalid output and was NOT saved:\n\n${sanityCheck.reason}`);
      } else {
        if (pgPool && pgReady) {
          try {
            await pgPool.query(
              "INSERT INTO schedules (name, description, schedule_data, created_at) VALUES ($1, $2, $3, $4)",
              [result.schedule.name, result.schedule.description || "", JSON.stringify(result.schedule.schedule_data), new Date().toISOString()]
            );
          } catch (e) {
            console.error("Failed to save schedule to PostgreSQL:", e);
          }
        }
        const insertSchedule = db.prepare("INSERT INTO schedules (name, description, schedule_data, created_at) VALUES (?, ?, ?, datetime('now'))");
        insertSchedule.run(result.schedule.name, result.schedule.description || "", JSON.stringify(result.schedule.schedule_data));
      }
    }
    
    if (result.insights && Array.isArray(result.insights)) {
      for (const insight of result.insights) {
        if (pgPool && pgReady) {
          await pgPool.query("INSERT INTO insights (content, created_at) VALUES ($1, NOW())", [insight]);
        }
        db.prepare("INSERT INTO insights (content, created_at) VALUES (?, datetime('now'))").run(insight);
      }
    }

    if (result.reasoning && Array.isArray(result.reasoning)) {
      for (const r of result.reasoning) {
        if (pgPool && pgReady) {
          await pgPool.query(
            "INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES ($1, $2, $3, NOW())",
            [r.context || "General", r.decision || "Adjustment", r.reasoning || ""]
          );
        }
        db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))")
          .run(r.context || "General", r.decision || "Adjustment", r.reasoning || "");
      }
    }
    
    broadcastToFrontend({ type: 'NEW_REASONING' });
    return result;

  } catch (e: any) {
    if (e.status === 401 || (e.message && e.message.includes("authentication_error"))) {
      console.warn("Skipping daily analysis: Claude API key not valid.");
      return {};
    }
    console.error("Daily analysis error", e);
    await sendTelegramAlert(`Daily Analysis Failed:\n\n${e.stack || e.message}`);
    throw e;
  }
}

// Run daily analysis at a fixed local time each day (default 3 AM), rather
// than 24h after whatever moment the process happened to last start - so
// restarts/deploys don't cause the run time to drift.
let dailyAnalysisTimeoutId: NodeJS.Timeout | null = null;

function scheduleDailyAnalysis() {
  if (dailyAnalysisTimeoutId) clearTimeout(dailyAnalysisTimeoutId);

  const hour = Math.min(23, Math.max(0, Number(getSetting("ai_daily_analysis_hour", "3"))));
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const delayMs = next.getTime() - now.getTime();
  console.log(`Next daily analysis scheduled for ${next.toLocaleString()} ${Intl.DateTimeFormat().resolvedOptions().timeZone} (in ${Math.round(delayMs / 60000)} minutes). If this timezone doesn't match your household's actual local time, the "Daily Schedule Generation Hour" setting will fire at the wrong wall-clock time - set the server's TZ environment variable (or system timezone) to match.`);

  dailyAnalysisTimeoutId = setTimeout(async () => {
    try {
      await runDailyAnalysis();
    } catch (e) {
      console.error("Scheduled daily analysis failed:", e);
    }
    scheduleDailyAnalysis(); // reschedule for the following day, picking up any setting change
  }, delayMs);
}

scheduleDailyAnalysis();

// --- Real-time AI Control Loop ---
// Uses a separate (cheaper/faster) model setting from the daily deep
// analysis, since this runs far more often - and skips the AI call
// entirely when nothing relevant has changed since the last check, since
// there is nothing new for it to react to.
let lastRealTimeCheckAt = new Date().toISOString();

async function executeRealTimeAIControl() {
  const checkStartedAt = new Date().toISOString();
  try {
    const contextWindowHours = Number(getSetting("ai_context_window_hours", "2"));

    const ai = resolveAiProvider("ai_model_realtime", "claude-haiku-4-5-20251001");
    if (!ai.ready) {
      console.warn(`${ai.skipReason} Skipping real-time control.`);
      return;
    }

    const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
    const settings: Record<string, string> = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    const ghostModeHvac = settings.ghost_mode_hvac === 'true';
    const ghostModeWholeHome = settings.ghost_mode_whole_home === 'true';
    const userContext = parseUserContext(settings.user_ai_context || "");

    // Task 1: Fetch Occupancy Roster (Strict Initialization)
    const occupancyRoster = db.prepare("SELECT * FROM occupancy_roster").all() as any[] || [];
    
    // Fetch context
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[] || [];
    const trackedIds = trackedRows.map(t => t.entity_id);
    const trackedContext = trackedRows.map(t => ({ id: t.entity_id, notes: t.notes }));

    const states = await fetchHA('/api/states') || [];
    
    // Update occupancy status based on HA states
    for (const person of occupancyRoster) {
      const haState = states.find((s: any) => s.entity_id === person.entity_id);
      if (haState) {
        db.prepare("UPDATE occupancy_roster SET status = ? WHERE id = ?").run(haState.state, person.id);
        person.status = haState.state;
      }
    }

    const trackedStates = states.filter((s: any) => {
      // Task 2: Include media_player, light, and binary_sensor (motion)
      const domain = s.entity_id.split('.')[0];
      return trackedIds.includes(s.entity_id) ||
             ['media_player', 'light', 'binary_sensor'].includes(domain);
    }) || [];

    // Skip the (paid) AI call entirely if nothing relevant has changed
    // since the last check - there's nothing new for it to react to.
    const relevantPlaceholders = trackedIds.map(() => '?').join(',');
    const activitySinceLastCheck = db.prepare(`
      SELECT id FROM device_history
      WHERE last_changed >= ?
      AND (${trackedIds.length > 0 ? `entity_id IN (${relevantPlaceholders}) OR ` : ''}entity_id LIKE 'media_player.%' OR entity_id LIKE 'light.%' OR entity_id LIKE 'binary_sensor.%')
      LIMIT 1
    `).get(lastRealTimeCheckAt, ...trackedIds);

    if (!activitySinceLastCheck) {
      lastRealTimeCheckAt = checkStartedAt;
      return;
    }

    const placeholders = trackedIds.map(() => '?').join(',');
    const recentHistory = trackedIds.length > 0 ? db.prepare(`
      SELECT entity_id, state, attributes, last_changed 
      FROM device_history 
      WHERE last_changed >= datetime('now', '-${contextWindowHours} hours') 
      AND entity_id IN (${placeholders})
      ORDER BY last_changed ASC
    `).all(...trackedIds) as any[] : [];

    const recentLogbook = trackedIds.length > 0 ? db.prepare(`
      SELECT entity_id, message, when_ts, domain 
      FROM logbook_history 
      WHERE when_ts >= datetime('now', '-${contextWindowHours} hours') 
      AND entity_id IN (${placeholders})
      ORDER BY when_ts ASC
    `).all(...trackedIds) as any[] : [];

    const snapshotRow = db.prepare("SELECT data FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 1").get() as any;
    const systemSnapshot = snapshotRow ? safeParse(snapshotRow.data) : {};

    const automationsScripts = db.prepare("SELECT entity_id, name, domain, content FROM ha_automations_scripts").all() as any[] || [];

    const prompt = `
      You are the HomeBrain Intelligence Engine. Your core logic is built on "Behavioral Heuristics"—you do not just see logs; you see human intent.

      ### CORE LOGIC ADJUSTMENTS:
      1. THE ANCHOR RULE: Identify "Professional Anchors" for the household's residents (e.g., a consistent early-morning departure and commute pattern). When a pattern occurs 3+ times a week, define the median times as the "Working Baseline." Use USER PROVIDED CONTEXT below for the specific residents and their known routines.
      2. DEVICE PROXY LOGIC:
         - If lights are OFF but a person is HOME, prioritize the state "Sleeping/Resting" over "Inactive."
         - High activity/wattage on any specific workstation, workshop, or hobby devices named in USER PROVIDED CONTEXT indicates a "Project State."
         - If kitchen or outdoor-cooking entities named in USER PROVIDED CONTEXT are active, enter "Cooking/Hosting State."
      3. TRANSITION ANALYSIS:
         - A "Home -> Not Home -> Home" sequence under 90 minutes is an "Errand."
         - A "Not Home" state lasting >10 hours is "Overtime/Project Site."
      4. ENVIRONMENTAL CORRELATION: Cross-reference any solar/heat-pump production data named in USER PROVIDED CONTEXT with resident presence. Does activity increase when solar production is high?

      ### CLIMATE TARGET PREFERENCES (set by the user - use these as your baseline, do not invent your own targets):
      - Home Mode master target: ${settings.climate_master_home || 72}°F
      - Away Mode master target: ${settings.climate_master_away || 65}°F
      - Night Mode master target: ${settings.climate_master_night || 68}°F
      - Per-zone offsets (add to the master target for that zone's mode; zero if a zone isn't listed): ${settings.climate_zone_modifiers || '{}'}
      - Absolute safety bounds - NEVER request a temperature outside this range: ${settings.climate_abs_min || 55}°F to ${settings.climate_abs_max || 80}°F

      ### REAL-TIME INSTRUCTIONS:
      1. Analyze the current state and recent history to determine the home state and if actions are needed.
      2. NO ASSUMPTION POLICY: Base your inferred_home_state strictly on the provided Tracked States and history. Do not assume someone is asleep just because of the time of day; verify lack of motion (binary_sensor) or media player activity.
      3. If the home state transitions to 'Sleep' or 'Away', you must output actions to proactively adjust the HVAC zone temperatures and turn off active lights.
      4. Analyze media_player, light, and binary_sensor (motion) entities alongside climate data to infer human behavior.
      5. LEARN FROM USER AUTOMATIONS: Use the provided Home Assistant automations and scripts to understand user intent for various home states.
      6. GLOBAL HOUSE MODES: Factor the current and upcoming "Mode" (e.g., Night, Away, Home) into your decisions.
      7. PREDICTIVE PRE-CONDITIONING: Calculate "Thermal Inertia" from the device_history and factor in external elements like humidity to trigger HVAC ahead of schedule.
      8. SCRIPT EXECUTION PRIORITY: Prioritize triggering existing Home Assistant scripts or automations using the Long-Lived Access Token.

      ### OUTPUT STYLE:
      Always analyze data chronologically. Before answering, perform an internal "Chain of Thought" step to identify consistency vs. outliers. Speak as a collaborative partner in managing the home.

      USER PROVIDED CONTEXT:
      ${userContext}

      CURRENT DATE/TIME: ${new Date().toLocaleString('en-US', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, timeZoneName: 'short' })} (${new Date().toLocaleDateString('en-US', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekday: 'long' })})
      TIMEZONE NOTE: "RECENT HISTORY" and "RECENT LOGBOOK" timestamps below are stored in UTC, not local time. Convert to the server's local time zone when reasoning about or outputting clock times.
      SYSTEM SNAPSHOT: ${JSON.stringify(systemSnapshot)}
      USER AUTOMATIONS & SCRIPTS (For Learning Patterns): ${JSON.stringify(automationsScripts)}
      OCCUPANCY STATUS (People): ${JSON.stringify(occupancyRoster)}
      TRACKED DEVICES (General): ${JSON.stringify(trackedContext)}
      CURRENT STATES: ${JSON.stringify(trackedStates)}
      RECENT HISTORY (Last ${contextWindowHours} Hours): ${JSON.stringify(recentHistory)}
      RECENT LOGBOOK (Last ${contextWindowHours} Hours): ${JSON.stringify(recentLogbook)}
      
      Return a JSON object with:
      { 
        "inferred_home_state": "Active" | "Winding_Down" | "Sleep" | "Away",
        "confidence_score": 0-100,
        "actions": [{ "type": "hvac"|"whole_home", "domain": "...", "service": "...", "entity_id": "...", "service_data": {...}, "reasoning": "..." }] 
      }
    `;

    const result = await ai.call(prompt, {
      type: "object",
      properties: {
        inferred_home_state: {
          type: "string",
          description: "The current inferred state of the home."
        },
        confidence_score: {
          type: "integer",
          description: "Confidence level of the inference (0-100)."
        },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              domain: { type: "string" },
              service: { type: "string" },
              entity_id: { type: "string" },
              service_data: { type: "object" },
              reasoning: { type: "string" }
            },
            required: ["type", "domain", "service", "entity_id", "reasoning"]
          }
        }
      },
      required: ["inferred_home_state", "confidence_score", "actions"]
    });

    lastRealTimeCheckAt = checkStartedAt;

    // Task 4: Fail-Safe Defaults
    if (result.confidence_score === undefined || result.confidence_score === null) {
      console.warn("AI returned missing or null confidence_score. Ignoring actions.");
      return;
    }

    if (result.actions && Array.isArray(result.actions)) {
      const absMin = Number(getSetting("climate_abs_min", "55"));
      const absMax = Number(getSetting("climate_abs_max", "80"));

      for (const action of result.actions) {
        let ghostModeActive = false;
        if (action.type === 'hvac') {
          if (ghostModeHvac) ghostModeActive = true;
        } else {
          if (ghostModeWholeHome) ghostModeActive = true;
        }

        // Task 2: Safety Intercept
        let blockedByGuardrail = false;
        let blockReason = "";

        // Prevent rapid HVAC cycling (no toggling the same entity within a 5-minute window)
        if (action.domain === 'climate') {
          const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const recentToggle = db.prepare(`
            SELECT id FROM device_history 
            WHERE entity_id = ? AND last_changed >= ? 
            ORDER BY last_changed DESC LIMIT 1
          `).get(action.entity_id, fiveMinsAgo);

          if (recentToggle) {
            blockedByGuardrail = true;
            blockReason = `[BLOCKED BY GUARDRAIL] Rapid HVAC cycling prevented for ${action.entity_id} (toggled within last 5 minutes).`;
            console.warn(blockReason);
          }
        }

        if (!blockedByGuardrail && action.domain === 'climate' && action.service === 'set_temperature') {
          const targetTemp = Number(action.service_data?.temperature);
          if (!isNaN(targetTemp)) {
            if (targetTemp < absMin || targetTemp > absMax) {
              blockedByGuardrail = true;
              blockReason = `[BLOCKED BY GUARDRAIL] Requested temperature ${targetTemp}°F is outside safety bounds (${absMin}°F - ${absMax}°F).`;
              console.warn(blockReason);
            }
          }
        }

        if (!ghostModeActive && !blockedByGuardrail) {
          try {
            await callHAService(action.domain, action.service, { entity_id: action.entity_id, ...action.service_data });
          } catch (err: any) {
            console.error(`Failed to call HA service for ${action.entity_id}:`, err.stack || err.message);
            await sendTelegramAlert(`HA Service Call Failed for ${action.entity_id}:\n\n${err.stack || err.message}`);
          }
        }

        const finalReasoning = blockedByGuardrail ? blockReason : (ghostModeActive ? `[GHOST MODE - ACTION BLOCKED] ${action.reasoning}` : `[EXECUTED] ${action.reasoning}`);
        const decisionText = `[State: ${result.inferred_home_state} (Conf: ${result.confidence_score}%)] ${action.service} on ${action.entity_id} ${action.service_data ? JSON.stringify(action.service_data) : ''}`;
        
        const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))");
        insertReasoning.run(
          action.type === 'hvac' ? 'Real-time HVAC Control' : 'Real-time Whole Home Control',
          decisionText,
          finalReasoning
        );
      }
      if (result.actions.length > 0) broadcastToFrontend({ type: 'NEW_REASONING' });
    }
  } catch (error: any) {
    if (error.status === 401 || (error.message && error.message.includes("authentication_error"))) {
      console.warn("Skipping real-time control: Claude API key not valid.");
      return;
    }
    // Task 4: Traceback Visibility
    console.error("Real-time control error:\n", error.stack);
    await sendTelegramAlert(`Real-time AI Control Failed:\n\n${error.stack || error.message}`);
  }
}

// Run real-time control based on interval setting
let realTimeIntervalId: NodeJS.Timeout | null = null;

function startRealTimeAIControl() {
  if (realTimeIntervalId) clearInterval(realTimeIntervalId);
  realTimeIntervalId = null;

  if (getSetting("ai_realtime_enabled", "false") !== "true") {
    console.log("Real-time AI control loop is disabled. Relying on the once-daily schedule analysis only.");
    return;
  }

  const intervalMins = Number(getSetting("ai_realtime_interval", "5"));
  const intervalMs = Math.max(1, intervalMins) * 60 * 1000;
  console.log(`Starting real-time AI control loop with ${intervalMins} minute interval.`);
  realTimeIntervalId = setInterval(executeRealTimeAIControl, intervalMs);
}

startRealTimeAIControl();

// --- API Routes ---

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;

  const dbType = getSetting("database_type", "sqlite");
  let user: any = null;

  if (dbType === "postgresql" && pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT * FROM users WHERE username = $1", [username]);
      user = result.rows[0];
    } catch (e) {
      console.error("PostgreSQL auth failed:", e);
    }
  }

  if (!user) {
    user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
  }

  if (user && password && bcrypt.compareSync(password, user.password)) {
    const userData = { id: user.id, username: user.username, role: user.role };
    req.session.user = userData;
    res.json({ success: true, user: userData });
  } else {
    res.status(401).json({ success: false, error: "Invalid credentials" });
  }
});

// Require an authenticated session for every /api/* route below this point,
// except the auth routes themselves (login needs to be reachable while
// logged out; me/logout need to work whether or not a session exists).
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.session.user) return next();
  res.status(401).json({ success: false, error: "Not authenticated" });
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.session.user?.role === "admin") return next();
  res.status(403).json({ success: false, error: "Admin access required" });
}

app.use((req, res, next) => {
  if (req.path.startsWith("/api/auth/")) return next();
  if (req.path.startsWith("/api/")) return requireAuth(req, res, next);
  next();
});

app.get("/api/auth/me", (req, res) => {
  if (req.session.user) {
    res.json({ success: true, user: req.session.user });
  } else {
    res.status(401).json({ success: false, error: "Not authenticated" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: "Logout failed" });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get("/api/users", requireAdmin, async (req, res) => {
  if (pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT id, username, role FROM users");
      return res.json(result.rows);
    } catch (e) {
      console.error("PostgreSQL users fetch failed:", e);
    }
  }
  const users = db.prepare("SELECT id, username, role FROM users").all();
  res.json(users);
});

app.post("/api/users", requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    if (pgPool && pgReady) {
      await pgPool.query(
        "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
        [username, hashedPassword, role]
      );
    }
    const stmt = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
    stmt.run(username, hashedPassword, role);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  try {
    if (pgPool && pgReady) {
      await pgPool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Occupancy Roster Routes
app.get("/api/occupancy", async (req, res) => {
  if (pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT * FROM occupancy_roster");
      return res.json(result.rows);
    } catch (e) {
      console.error("PostgreSQL occupancy fetch failed:", e);
    }
  }
  try {
    const roster = db.prepare("SELECT * FROM occupancy_roster").all();
    res.json(roster);
  } catch (e: any) {
    console.error("Failed to fetch occupancy roster:\n", e.stack);
    sendTelegramAlert(`Failed to fetch occupancy roster:\n\n${e.stack}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/occupancy", async (req, res) => {
  const { name, entity_id, is_tracked } = req.body;
  const trackedVal = is_tracked === false ? 0 : 1;
  try {
    if (pgPool && pgReady) {
      await pgPool.query(
        "INSERT INTO occupancy_roster (name, entity_id, is_tracked) VALUES ($1, $2, $3)",
        [name, entity_id, trackedVal]
      );
    }
    const stmt = db.prepare("INSERT INTO occupancy_roster (name, entity_id, is_tracked) VALUES (?, ?, ?)");
    stmt.run(name, entity_id, trackedVal);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Failed to add to occupancy roster:\n", e.stack);
    sendTelegramAlert(`Failed to add to occupancy roster:\n\n${e.stack}`);
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/occupancy/:id", async (req, res) => {
  const { is_tracked } = req.body;
  const trackedVal = is_tracked ? 1 : 0;
  try {
    if (pgPool && pgReady) {
      await pgPool.query("UPDATE occupancy_roster SET is_tracked = $1 WHERE id = $2", [trackedVal, req.params.id]);
    }
    db.prepare("UPDATE occupancy_roster SET is_tracked = ? WHERE id = ?").run(trackedVal, req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Failed to update occupancy roster:\n", e.stack);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/occupancy/:id", async (req, res) => {
  try {
    if (pgPool && pgReady) {
      await pgPool.query("DELETE FROM occupancy_roster WHERE id = $1", [req.params.id]);
    }
    db.prepare("DELETE FROM occupancy_roster WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Failed to delete from occupancy roster:\n", e.stack);
    sendTelegramAlert(`Failed to delete from occupancy roster:\n\n${e.stack}`);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ha/status", (req, res) => {
  res.json({ status: haStatus, error: haError });
});

app.post("/api/ha/force-connect", (req, res) => {
  connectToHA();
  res.json({ success: true, status: haStatus });
});

app.post("/api/ha/sync-history", async (req, res) => {
  try {
    // Run in background
    fillHistoryGaps(true);
    res.json({ status: "started" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/settings", async (req, res) => {
  let settingsRows: any[] = [];
  if (pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT * FROM settings");
      settingsRows = result.rows;
    } catch (e) {
      console.error("PostgreSQL settings fetch failed:", e);
      settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
    }
  } else {
    settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
  }

  const settingsObj = settingsRows.reduce((acc: any, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
  res.json(settingsObj);
});

app.post("/api/settings", async (req, res) => {
  const updates = req.body;
  
  if (pgPool && pgReady) {
    try {
      for (const [key, value] of Object.entries(updates)) {
        await pgPool.query(
          "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
          [key, String(value)]
        );
      }
    } catch (e) {
      console.error("PostgreSQL settings update failed:", e);
    }
  }

  const updateSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?");
  for (const [key, value] of Object.entries(updates)) {
    updateSetting.run(key, String(value), String(value));
  }
  
  // Reconnect to HA if url/token changed
  if (updates.ha_url !== undefined || updates.ha_token !== undefined) {
    connectToHA();
  }

  // Restart real-time loop if interval or enabled flag changed
  if (updates.ai_realtime_interval !== undefined || updates.ai_realtime_enabled !== undefined) {
    startRealTimeAIControl();
  }

  // Reschedule the daily analysis if its target hour changed
  if (updates.ai_daily_analysis_hour !== undefined) {
    scheduleDailyAnalysis();
  }

  res.json({ success: true });
});

// System Update Endpoints
app.get("/api/system/check-update", async (req, res) => {
  try {
    const projectRoot = process.cwd();
    const gitDir = path.join(projectRoot, '.git');
    
    if (!fs.existsSync(gitDir)) {
      return res.json({ 
        updateAvailable: false, 
        message: "System updates are disabled in this environment (not a git repository). To enable updates, ensure the application was installed via 'git clone'." 
      });
    }

    const branch = getSetting("github_branch", "main");
    
    // Diagnostic info
    let currentBranch = "unknown";
    let remoteUrl = "unknown";
    let remotes = "unknown";
    try {
      const branchRes = await execAsync('git rev-parse --abbrev-ref HEAD');
      currentBranch = branchRes.stdout.trim();
      const remoteRes = await execAsync('git remote get-url origin');
      remoteUrl = remoteRes.stdout.trim();
      const remotesRes = await execAsync('git remote -v');
      remotes = remotesRes.stdout.trim();
    } catch (e) {}

    // Check if we are inside a work tree
    try {
      await execAsync('git rev-parse --is-inside-work-tree');
    } catch (e) {
      return res.json({ updateAvailable: false, message: "Not inside a git work tree." });
    }
    
    // Fetch latest from origin
    console.log(`[Update Check] Fetching from origin ${branch}...`);
    try {
      await execAsync('git fetch origin');
    } catch (e: any) {
      return res.json({ updateAvailable: false, message: `Failed to fetch from origin: ${e.message}` });
    }
    
    const local = await execAsync('git rev-parse HEAD');
    
    // Try to get remote hash for the configured branch
    let remoteHash = "";
    try {
      const remoteRes = await execAsync(`git rev-parse origin/${branch}`);
      remoteHash = remoteRes.stdout.trim();
    } catch (e) {
      // Fallback to upstream if origin/branch fails
      try {
        const upstreamRes = await execAsync('git rev-parse @{u}');
        remoteHash = upstreamRes.stdout.trim();
      } catch (uErr: any) {
        return res.json({ 
          updateAvailable: false, 
          message: `Could not determine remote version. Ensure you are on a branch that tracks origin/${branch} or has an upstream set.` 
        });
      }
    }
    
    if (local.stdout.trim() !== remoteHash) {
      res.json({ 
        updateAvailable: true, 
        message: `A new version is available on GitHub (branch: ${branch}).`,
        localHash: local.stdout.trim().substring(0, 7),
        remoteHash: remoteHash.substring(0, 7),
        currentBranch,
        remoteUrl,
        remotes
      });
    } else {
      res.json({ 
        updateAvailable: false, 
        message: `System is up to date (Branch: ${branch}, Commit: ${remoteHash.substring(0, 7)}).`,
        currentBranch,
        remoteUrl,
        remotes
      });
    }
  } catch (e: any) {
    console.error("Update check failed:", e.message);
    res.json({ updateAvailable: false, message: `Update check failed: ${e.message}` });
  }
});

app.post("/api/system/update", async (req, res) => {
  try {
    const gitDir = path.join(__dirname, '.git');
    if (!fs.existsSync(gitDir)) {
      return res.status(400).json({ success: false, error: "System updates are disabled in this environment (not a git repository)." });
    }

    const broadcastProgress = (message: string) => {
      console.log(`[Update] ${message}`);
      broadcastToFrontend({ type: 'UPDATE_PROGRESS', message });
    };

    const branch = getSetting("github_branch", "main");
    broadcastProgress(`Starting robust system update for branch: ${branch}...`);
    
    // Execute the standalone script
    const { spawn } = await import('child_process');
    const child = spawn('npm', ['run', 'update-system'], {
      env: { ...process.env, GITHUB_BRANCH: branch }
    });

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line: string) => {
        if (line.trim()) broadcastProgress(line.trim());
      });
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach((line: string) => {
        if (line.trim()) broadcastProgress(`[Error] ${line.trim()}`);
      });
    });

    child.on('close', (code) => {
      if (code === 0) {
        broadcastProgress("Update script finished successfully.");
        res.json({ 
          success: true, 
          message: "Update pulled and built successfully! The server will now attempt to restart." 
        });

        setTimeout(() => {
          broadcastProgress("Restarting process...");
          process.exit(0);
        }, 2000);
      } else {
        broadcastProgress(`Update script failed with code ${code}`);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: `Update script failed with code ${code}` });
        }
      }
    });

  } catch (e: any) {
    console.error("[Update] Update failed:", e.message);
    broadcastToFrontend({ type: 'UPDATE_PROGRESS', message: `ERROR: ${e.message}` });
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: `Update failed: ${e.message}` });
    }
  }
});

app.post("/api/ha/test-connection", async (req, res) => {
  try {
    const config = await fetchHA('/api/config');
    if (config && config.version) {
      res.json({ success: true, message: `Successfully connected to Home Assistant v${config.version}` });
    } else {
      res.status(500).json({ success: false, error: "Connected but received invalid configuration data." });
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/ha/sync-automations-scripts", async (req, res) => {
  try {
    console.log("[Sync] Syncing automations and scripts from HA...");
    const automations = await fetchHA('/api/states', 60000); // 60s timeout for full state dump
    
    if (automations === null) {
      console.error("[Sync] HA Connection not configured.");
      throw new Error("Home Assistant URL or Access Token is not configured in Settings.");
    }
    
    if (!Array.isArray(automations)) {
      console.error("[Sync] HA Response was not an array:", typeof automations);
      throw new Error("Failed to fetch states from HA: Response was not an array.");
    }

    const filtered = automations.filter((s: any) => s.entity_id && (s.entity_id.startsWith('automation.') || s.entity_id.startsWith('script.')));
    console.log(`[Sync] Found ${filtered.length} automations/scripts to sync.`);
    
    const insertStmt = db.prepare("INSERT INTO ha_automations_scripts (entity_id, name, domain, content, last_updated) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(entity_id) DO UPDATE SET name=excluded.name, domain=excluded.domain, content=excluded.content, last_updated=datetime('now')");
    
    db.transaction(() => {
      for (const item of filtered) {
        insertStmt.run(
          item.entity_id,
          item.attributes?.friendly_name || item.entity_id,
          item.entity_id.split('.')[0],
          JSON.stringify(item)
        );
      }
    })();

    console.log("[Sync] Sync complete.");
    res.json({ success: true, count: filtered.length });
  } catch (e: any) {
    console.error("[Sync] Error:", e.message);
    res.status(500).json({ error: e.message || "Unknown error during sync" });
  }
});

app.post("/api/ha/sync-system-data", async (req, res) => {
  // Strict Initialization
  let fullExport: Record<string, any> = {
    states: [],
    config: {},
    history: [],
    logbook: [],
    exported_at: new Date().toISOString()
  };

  try {
    const contextWindowHours = Number(getSetting("ai_context_window_hours", "2"));
    // 1. Full State Dump
    try {
      const states = await fetchHA('/api/states');
      fullExport.states = Array.isArray(states) ? states : [];
    } catch (err: any) {
      console.error("Error fetching states:\n", err.stack || err);
    }

    // 2. System Config
    try {
      const config = await fetchHA('/api/config');
      fullExport.config = (config && typeof config === 'object') ? config : {};
    } catch (err: any) {
      console.error("Error fetching config:\n", err.stack || err);
    }

    // 3. Targeted History Sampling (Last X hours, filtered domains)
    try {
      const contextWindowHours = Number(getSetting("ai_context_window_hours", "2"));
      const startTime = new Date(Date.now() - contextWindowHours * 60 * 60 * 1000).toISOString();
      
      // Get all tracked entities
      const trackedRows = db.prepare("SELECT entity_id FROM tracked_entities WHERE tracked = 1").all() as any[];
      const trackedIds = trackedRows.map(t => t.entity_id);
      
      // Also include climate and weather entities from current states for context
      const states = fullExport.states || [];
      const extraIds = states
        .filter((s: any) => s.entity_id.startsWith('climate.') || s.entity_id.startsWith('weather.'))
        .map((s: any) => s.entity_id);
      
      const allIds = Array.from(new Set([...trackedIds, ...extraIds]));
      
      if (allIds.length > 0) {
        const historyData = await fetchHA(`/api/history/period/${encodeURIComponent(startTime)}?filter_entity_id=${allIds.join(',')}`);
        
        if (Array.isArray(historyData)) {
          const filteredHistory = historyData.map((entityHistory: any) => {
            if (!Array.isArray(entityHistory)) return [];
            return entityHistory.filter((stateObj: any) => {
              const entityId = stateObj?.entity_id || "";
              return entityId.startsWith('climate.') || 
                     entityId.startsWith('weather.') || 
                     entityId.startsWith('sensor.');
            });
          }).filter((arr: any) => arr.length > 0);
          
          fullExport.history = filteredHistory;
        }

        // 4. Targeted Logbook Sampling
        try {
          const logbookData = await fetchHA(`/api/logbook/${encodeURIComponent(startTime)}?entity=${allIds.join(',')}`);
          fullExport.logbook = Array.isArray(logbookData) ? logbookData : [];
        } catch (err: any) {
          console.error("Error fetching logbook for sync:\n", err.stack || err);
        }
      } else {
        console.log("No entities to fetch history for during sync.");
      }
    } catch (err: any) {
      console.error("Error fetching history:\n", err.stack || err);
    }

    // Save to Database instead of just returning
    const insertSnapshot = db.prepare("INSERT INTO ha_system_snapshots (data) VALUES (?)");
    insertSnapshot.run(JSON.stringify(fullExport));

    // Keep only the last 5 snapshots to save space
    db.prepare("DELETE FROM ha_system_snapshots WHERE id NOT IN (SELECT id FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 5)").run();

    res.json({ success: true, message: "System data synced and saved for AI context." });

  } catch (criticalError: any) {
    console.error("CRITICAL ERROR IN SYNC SCRIPT:\n", criticalError.stack || criticalError);
    res.status(500).json({ 
      error: "Critical failure during system sync", 
      details: criticalError.message
    });
  }
});

app.get("/api/history", async (req, res) => {
  const { entity_id, state, start_date, end_date, limit = 100, offset = 0 } = req.query;
  
  // Try PostgreSQL first if initialized
  if (pgPool && pgReady) {
    try {
      let query = "SELECT * FROM device_history WHERE 1=1";
      const params: any[] = [];
      let paramIdx = 1;

      if (entity_id) {
        query += ` AND entity_id LIKE $${paramIdx++}`;
        params.push(`%${entity_id}%`);
      }
      
      if (state) {
        query += ` AND state = $${paramIdx++}`;
        params.push(state);
      }
      
      if (start_date) {
        query += ` AND last_changed >= $${paramIdx++}`;
        params.push(start_date);
      }
      
      if (end_date) {
        query += ` AND last_changed <= $${paramIdx++}`;
        params.push(end_date);
      }
      
      // Get total count
      const countQuery = query.replace("SELECT *", "SELECT COUNT(*) as count");
      const countRes = await pgPool.query(countQuery, params);
      const totalCount = parseInt(countRes.rows[0].count);

      query += ` ORDER BY last_changed DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      params.push(Number(limit), Number(offset));
      
      const result = await pgPool.query(query, params);

      return res.json({
        data: result.rows,
        total: totalCount,
        limit: Number(limit),
        offset: Number(offset),
        source: 'postgresql'
      });
    } catch (e) {
      console.error("PostgreSQL history fetch failed, falling back to SQLite:", e);
    }
  }

  // Fallback to SQLite
  let query = "SELECT * FROM device_history WHERE 1=1";
  const params: any[] = [];
  
  if (entity_id) {
    query += " AND entity_id LIKE ?";
    params.push(`%${entity_id}%`);
  }
  
  if (state) {
    query += " AND state = ?";
    params.push(state);
  }
  
  if (start_date) {
    query += " AND last_changed >= ?";
    params.push(start_date);
  }
  
  if (end_date) {
    query += " AND last_changed <= ?";
    params.push(end_date);
  }
  
  // Get total count for pagination
  const countQuery = query.replace("SELECT *", "SELECT COUNT(*) as count");
  const totalCount = (db.prepare(countQuery).get(...params) as any).count;
  
  query += " ORDER BY last_changed DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));
  
  const history = db.prepare(query).all(...params);
  res.json({
    data: history,
    total: totalCount,
    limit: Number(limit),
    offset: Number(offset),
    source: 'sqlite'
  });
});

app.get("/api/history/graph", (req, res) => {
  const zonesParam = req.query.zones as string;
  const timeframe = req.query.timeframe as string || '24h';
  
  if (!zonesParam) {
    return res.json([]);
  }
  
  const zones = safeParse(zonesParam, []);
  if (!Array.isArray(zones) || zones.length === 0) {
    return res.json([]);
  }
  
  let timeModifier = '-1 day';
  if (timeframe === '7d') timeModifier = '-7 days';
  else if (timeframe === '30d') timeModifier = '-30 days';
  else if (timeframe === 'all') timeModifier = '-100 years'; // practically all

  const placeholders = zones.map(() => '?').join(',');
  const graphData = db.prepare(`
    SELECT entity_id, state, attributes, last_changed 
    FROM device_history 
    WHERE last_changed >= datetime('now', '${timeModifier}') 
    AND entity_id IN (${placeholders})
    ORDER BY last_changed ASC
  `).all(...zones);
  
  res.json(graphData);
});

app.get("/api/ai/real-time-context", async (req, res) => {
  try {
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    const trackedContext = trackedRows.map(t => ({ id: t.entity_id, notes: t.notes }));

    if (trackedIds.length === 0) return res.json({ trackedContext: [], trackedStates: [], recentHistory: [] });

    const states = await fetchHA('/api/states');
    if (!states) return res.status(500).json({ error: "Could not fetch states" });
    const trackedStates = states.filter((s: any) => trackedIds.includes(s.entity_id));

    const placeholders = trackedIds.map(() => '?').join(',');
    const recentHistory = db.prepare(`
      SELECT entity_id, state, attributes, last_changed 
      FROM device_history 
      WHERE last_changed >= datetime('now', '-2 hours') 
      AND entity_id IN (${placeholders})
      ORDER BY last_changed ASC
    `).all(...trackedIds) as any[];

    const settingsRows = db.prepare("SELECT * FROM settings WHERE key = 'user_ai_context'").get() as any;
    const userContextRaw = settingsRows ? settingsRows.value : "";
    const userContext = parseUserContext(userContextRaw);

    // Fetch latest system snapshot
    const snapshotRow = db.prepare("SELECT data FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 1").get() as any;
    const systemSnapshot = snapshotRow ? safeParse(snapshotRow.data, null) : null;

    res.json({
      trackedContext,
      trackedStates,
      recentHistory,
      systemSnapshot
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ha/call-service", async (req, res) => {
  const { domain, service, serviceData } = req.body;
  try {
    await callHAService(domain, service, serviceData);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ai/save-reasoning", async (req, res) => {
  const { context, decision, reasoning } = req.body;
  try {
    const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))");
    insertReasoning.run(context, decision, reasoning);
    broadcastToFrontend({ type: 'NEW_REASONING' });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ai/analysis-context", async (req, res) => {
  try {
    const states = await fetchHA('/api/states');
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    
    const lookbackDays = Number(getSetting("ai_lookback_days", "60"));
    
    let history: any[] = [];
    if (trackedIds.length > 0) {
      const placeholders = trackedIds.map(() => '?').join(',');
      // Fetch history for better pattern recognition (custody, work, etc)
      history = db.prepare(`
        SELECT entity_id, state, attributes, last_changed 
        FROM device_history 
        WHERE last_changed >= datetime('now', '-${lookbackDays} days') 
        AND entity_id IN (${placeholders})
        ORDER BY last_changed ASC
      `).all(...trackedIds) as any[];

      // If history is sparse (less than 50 entries), try to force a gap fill from HA
      if (history.length < 50) {
        console.log("History sparse, triggering emergency gap fill for AI analysis...");
        await fillHistoryGaps();
        // Re-fetch after gap fill
        history = db.prepare(`
          SELECT entity_id, state, attributes, last_changed 
          FROM device_history 
          WHERE last_changed >= datetime('now', '-${lookbackDays} days') 
          AND entity_id IN (${placeholders})
          ORDER BY last_changed ASC
        `).all(...trackedIds) as any[];
      }
    }

    const settingsRows = db.prepare("SELECT * FROM settings WHERE key = 'user_ai_context'").get() as any;
    const userContextRaw = settingsRows ? settingsRows.value : "";
    const userContext = parseUserContext(userContextRaw);

    // Fetch latest system snapshot
    const snapshotRow = db.prepare("SELECT data FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 1").get() as any;
    const systemSnapshot = snapshotRow ? safeParse(snapshotRow.data, null) : null;

    res.json({
      states,
      trackedEntities: trackedRows,
      history: history.slice(-1000), // Increased limit to allow AI to see more patterns
      userContext,
      systemSnapshot
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ai/save-analysis", async (req, res) => {
  const { insights, reasoning, schedule } = req.body;
  try {
    if (schedule && schedule.name) {
      const sanityCheck = isScheduleSane(schedule);
      if (!sanityCheck.sane) {
        return res.status(400).json({ success: false, error: `Refusing to save - ${sanityCheck.reason}` });
      }
      const insertSchedule = db.prepare("INSERT INTO schedules (name, description, schedule_data, created_at) VALUES (?, ?, ?, datetime('now'))");
      insertSchedule.run(schedule.name, schedule.description || "", JSON.stringify(schedule.schedule_data));
    }
    
    if (insights && Array.isArray(insights)) {
      const insertInsight = db.prepare("INSERT INTO insights (content, created_at) VALUES (?, datetime('now'))");
      for (const insight of insights) {
        insertInsight.run(insight);
      }
    }

    if (reasoning && Array.isArray(reasoning)) {
      const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))");
      for (const r of reasoning) {
        insertReasoning.run(r.context || "General", r.decision || "Adjustment", r.reasoning || "");
      }
    }
    
    broadcastToFrontend({ type: 'NEW_REASONING' });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/ai/generate-schedule", async (req, res) => {
  try {
    const result = await runDailyAnalysis();
    res.json({ success: true, result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ai/real-time-control", async (req, res) => {
  try {
    await executeRealTimeAIControl();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/migrate-to-postgres", async (req, res) => {
  if (!pgPool) {
    return res.status(500).json({ error: "PostgreSQL not initialized. Please set DATABASE_URL in environment." });
  }

  const broadcastProgress = (message: string) => {
    console.log(`[Migration] ${message}`);
    broadcastToFrontend({ type: 'MIGRATION_PROGRESS', message });
  };

  try {
    broadcastProgress("Starting robust migration to PostgreSQL...");
    
    // 1. Create tables in Postgres if they don't exist
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS device_history (
        id SERIAL PRIMARY KEY,
        entity_id TEXT,
        state TEXT,
        attributes TEXT,
        last_changed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        name TEXT,
        description TEXT,
        schedule_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS tracked_entities (
        entity_id TEXT PRIMARY KEY,
        tracked BOOLEAN DEFAULT TRUE,
        notes TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS insights (
        id SERIAL PRIMARY KEY,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ai_reasoning (
        id SERIAL PRIMARY KEY,
        context TEXT,
        decision TEXT,
        reasoning TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS ha_system_snapshots (
        id SERIAL PRIMARY KEY,
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS occupancy_roster (
        id SERIAL PRIMARY KEY,
        name TEXT,
        entity_id TEXT,
        status TEXT DEFAULT 'unknown',
        is_tracked INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS logbook_history (
        id SERIAL PRIMARY KEY,
        entity_id TEXT,
        message TEXT,
        when_ts TIMESTAMP,
        context_user_id TEXT,
        domain TEXT,
        attributes TEXT
      );
      CREATE TABLE IF NOT EXISTS ha_rules (
        entity_id TEXT PRIMARY KEY,
        name TEXT,
        domain TEXT,
        state TEXT,
        attributes TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS ha_automations_scripts (
        entity_id TEXT PRIMARY KEY,
        name TEXT,
        domain TEXT,
        content TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_pg_history_entity_time ON device_history(entity_id, last_changed);
      CREATE INDEX IF NOT EXISTS idx_pg_history_time ON device_history(last_changed);
      CREATE INDEX IF NOT EXISTS idx_pg_logbook_time ON logbook_history(when_ts);
      CREATE INDEX IF NOT EXISTS idx_pg_logbook_entity ON logbook_history(entity_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_history_unique ON device_history(entity_id, last_changed);
    `);

    // 2. Migrate Settings
    const settings = db.prepare("SELECT * FROM settings").all() as any[];
    broadcastProgress(`Migrating ${settings.length} settings...`);
    for (const s of settings) {
      await pgPool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
        [s.key, s.value]
      );
    }

    // 3. Migrate Users
    const users = db.prepare("SELECT * FROM users").all() as any[];
    broadcastProgress(`Migrating ${users.length} users...`);
    for (const u of users) {
      await pgPool.query(
        "INSERT INTO users (username, password, role) VALUES ($1, $2, $3) ON CONFLICT(username) DO NOTHING",
        [u.username, u.password, u.role]
      );
    }

    // 4. Migrate Tracked Entities
    const tracked = db.prepare("SELECT * FROM tracked_entities").all() as any[];
    broadcastProgress(`Migrating ${tracked.length} tracked entities...`);
    for (const t of tracked) {
      await pgPool.query(
        "INSERT INTO tracked_entities (entity_id, tracked, notes) VALUES ($1, $2, $3) ON CONFLICT(entity_id) DO UPDATE SET tracked = $2, notes = $3",
        [t.entity_id, t.tracked === 1, t.notes]
      );
    }

    // 5. Migrate Insights
    const insights = db.prepare("SELECT * FROM insights").all() as any[];
    broadcastProgress(`Migrating ${insights.length} insights...`);
    for (const i of insights) {
      await pgPool.query(
        "INSERT INTO insights (content, created_at) VALUES ($1, $2)",
        [i.content, i.created_at]
      );
    }

    // 6. Migrate AI Reasoning
    const reasoning = db.prepare("SELECT * FROM ai_reasoning").all() as any[];
    broadcastProgress(`Migrating ${reasoning.length} reasoning records...`);
    for (const r of reasoning) {
      await pgPool.query(
        "INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES ($1, $2, $3, $4)",
        [r.context, r.decision, r.reasoning, r.created_at]
      );
    }

    // 7. Migrate Occupancy Roster
    const roster = db.prepare("SELECT * FROM occupancy_roster").all() as any[];
    broadcastProgress(`Migrating ${roster.length} roster entries...`);
    for (const r of roster) {
      await pgPool.query(
        "INSERT INTO occupancy_roster (name, entity_id, status) VALUES ($1, $2, $3)",
        [r.name, r.entity_id, r.status]
      );
    }

    // 8. Migrate HA Rules
    const rules = db.prepare("SELECT * FROM ha_rules").all() as any[];
    broadcastProgress(`Migrating ${rules.length} HA rules...`);
    for (const r of rules) {
      await pgPool.query(
        "INSERT INTO ha_rules (entity_id, name, domain, state, attributes, last_updated) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(entity_id) DO NOTHING",
        [r.entity_id, r.name, r.domain, r.state, r.attributes, r.last_updated]
      );
    }

    // 9. Migrate HA Automations/Scripts
    const autos = db.prepare("SELECT * FROM ha_automations_scripts").all() as any[];
    broadcastProgress(`Migrating ${autos.length} automations/scripts...`);
    for (const a of autos) {
      await pgPool.query(
        "INSERT INTO ha_automations_scripts (entity_id, name, domain, content, last_updated) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(entity_id) DO NOTHING",
        [a.entity_id, a.name, a.domain, a.content, a.last_updated]
      );
    }

    // 10. Migrate History (Large table, use transaction)
    const history = db.prepare("SELECT * FROM device_history").all() as any[];
    broadcastProgress(`Migrating ${history.length} history records...`);
    
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      for (const record of history) {
        await client.query(
          "INSERT INTO device_history (entity_id, state, attributes, last_changed) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
          [record.entity_id, record.state, record.attributes, record.last_changed]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // 11. Migrate Logbook
    const logbook = db.prepare("SELECT * FROM logbook_history").all() as any[];
    broadcastProgress(`Migrating ${logbook.length} logbook entries...`);
    for (const l of logbook) {
      await pgPool.query(
        "INSERT INTO logbook_history (entity_id, message, when_ts, context_user_id, domain, attributes) VALUES ($1, $2, $3, $4, $5, $6)",
        [l.entity_id, l.message, l.when_ts, l.context_user_id, l.domain, l.attributes]
      );
    }

    // 12. Migrate Schedules
    const schedules = db.prepare("SELECT * FROM schedules").all() as any[];
    broadcastProgress(`Migrating ${schedules.length} schedules...`);
    for (const s of schedules) {
      await pgPool.query(
        "INSERT INTO schedules (name, description, schedule_data, created_at) VALUES ($1, $2, $3, $4)",
        [s.name, s.description, s.schedule_data, s.created_at]
      );
    }

    // 13. Mark migration as complete in settings
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run("database_type", "postgresql", "postgresql");
    await pgPool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2", ["database_type", "postgresql"]);

    broadcastProgress("Migration to local PostgreSQL complete.");
    res.json({ success: true, message: "Migration to local PostgreSQL complete. All data has been moved and the app is now using PostgreSQL." });
  } catch (e: any) {
    console.error("PostgreSQL Migration failed:", e);
    broadcastToFrontend({ type: 'MIGRATION_PROGRESS', message: `ERROR: ${e.message}` });
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/schedules", async (req, res) => {
  // Capped like /api/insights and /api/reasoning - with daily generation
  // this grows slowly, but nothing should ever query the full unbounded
  // history (each row's schedule_data can be several KB on its own).
  if (pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT * FROM schedules ORDER BY created_at DESC LIMIT 50");
      return res.json(result.rows);
    } catch (e) {
      console.error("PostgreSQL schedules fetch failed:", e);
    }
  }
  const schedules = db.prepare("SELECT * FROM schedules ORDER BY created_at DESC LIMIT 50").all();
  res.json(schedules);
});

app.delete("/api/schedules/:id", requireAdmin, async (req, res) => {
  try {
    if (pgPool && pgReady) {
      await pgPool.query("DELETE FROM schedules WHERE id = $1", [req.params.id]);
    }
    db.prepare("DELETE FROM schedules WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/insights", async (req, res) => {
  if (pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT * FROM insights ORDER BY created_at DESC LIMIT 20");
      return res.json(result.rows);
    } catch (e) {
      console.error("PostgreSQL insights fetch failed:", e);
    }
  }
  const insights = db.prepare("SELECT * FROM insights ORDER BY created_at DESC LIMIT 20").all();
  res.json(insights);
});

app.get("/api/reasoning", async (req, res) => {
  if (pgPool && pgReady) {
    try {
      const result = await pgPool.query("SELECT * FROM ai_reasoning ORDER BY created_at DESC LIMIT 50");
      return res.json(result.rows);
    } catch (e) {
      console.error("PostgreSQL reasoning fetch failed:", e);
    }
  }
  const reasoning = db.prepare("SELECT * FROM ai_reasoning ORDER BY created_at DESC LIMIT 50").all();
  res.json(reasoning);
});

app.post("/api/ai/scan-entities", async (req, res) => {
  try {
    const ai = resolveAiProvider("ai_model", "claude-sonnet-5");
    if (!ai.ready) {
      throw new Error(ai.skipReason);
    }

    let states = await fetchHA('/api/states');
    if (!states) {
      states = MOCK_HA_ENTITIES;
    }

    const entityList = states.map((e: any) => ({
      entity_id: e.entity_id,
      friendly_name: e.attributes.friendly_name || e.entity_id,
      domain: e.entity_id.split('.')[0]
    }));

    const result = await ai.call(`Analyze these Home Assistant entities and identify which ones are critical for an AI-driven climate control and home automation system.
      Focus on:
      1. Climate/Thermostat entities.
      2. Temperature/Humidity sensors.
      3. Presence/Occupancy sensors (person, device_tracker, binary_sensor.motion).
      4. Main lights or switches that indicate occupancy or activity.

      Return the entities with a brief reason why each should be tracked.

      Entities: ${JSON.stringify(entityList.slice(0, 300))} (truncated if too many)`, {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity_id: { type: "string" },
              reason: { type: "string" }
            },
            required: ["entity_id", "reason"]
          }
        }
      },
      required: ["suggestions"]
    });

    res.json(result.suggestions || []);

  } catch (e: any) {
    if (e.status === 401 || (e.message && e.message.includes("authentication_error"))) {
      console.warn("Skipping AI scan: Claude API key not valid.");
      return res.status(400).json({ error: "API key not valid. Please pass a valid API key." });
    }
    console.error("AI Scan failed", e.message);
    await sendTelegramAlert(`AI Scan Failed:\n\n${e.stack || e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/ha/bulk-track", async (req, res) => {
  const { entities } = req.body; // Array of { entity_id, notes }
  if (!Array.isArray(entities)) {
    return res.status(400).json({ success: false, error: "Invalid entities array" });
  }

  try {
    if (pgPool && pgReady) {
      try {
        for (const entity of entities) {
          await pgPool.query(
            "INSERT INTO tracked_entities (entity_id, tracked, notes) VALUES ($1, TRUE, $2) ON CONFLICT(entity_id) DO UPDATE SET tracked = TRUE, notes = $2",
            [entity.entity_id, entity.notes || '']
          );
        }
      } catch (e) {
        console.error("PostgreSQL bulk track failed:", e);
      }
    }

    const stmt = db.prepare("INSERT INTO tracked_entities (entity_id, tracked, notes) VALUES (?, 1, ?) ON CONFLICT(entity_id) DO UPDATE SET tracked = 1, notes = ?");
    
    db.transaction(() => {
      for (const entity of entities) {
        stmt.run(entity.entity_id, entity.notes || '', entity.notes || '');
      }
    })();

    // Trigger history gap fill for newly tracked entities
    fillHistoryGaps();

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/ha/entities", async (req, res) => {
  try {
    let states = await fetchHA('/api/states');
    if (!states) {
      // Provide mock states for preview environment if HA is not connected
      states = MOCK_HA_ENTITIES;
    }
    
    const entities = states.map((s: any) => ({
      entity_id: s.entity_id,
      friendly_name: s.attributes.friendly_name || s.entity_id,
      domain: s.entity_id.split('.')[0],
      state: s.state,
      attributes: s.attributes
    }));
    
    let trackedRows: any[] = [];
    if (pgPool && pgReady) {
      try {
        const result = await pgPool.query("SELECT * FROM tracked_entities");
        trackedRows = result.rows;
      } catch (e) {
        console.error("PostgreSQL tracked_entities fetch failed:", e);
        trackedRows = db.prepare("SELECT * FROM tracked_entities").all() as any[];
      }
    } else {
      trackedRows = db.prepare("SELECT * FROM tracked_entities").all() as any[];
    }
    
    const trackedMap = trackedRows.reduce((acc: any, row: any) => {
      acc[row.entity_id] = { tracked: row.tracked === 1 || row.tracked === true, notes: row.notes || '' };
      return acc;
    }, {});

    res.json({ entities, tracked: trackedMap });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ha/tracked", async (req, res) => {
  const { entity_id, tracked, notes } = req.body;
  
  if (pgPool && pgReady) {
    try {
      await pgPool.query(
        "INSERT INTO tracked_entities (entity_id, tracked, notes) VALUES ($1, $2, $3) ON CONFLICT(entity_id) DO UPDATE SET tracked = $2, notes = $3",
        [entity_id, !!tracked, notes || '']
      );
    } catch (e) {
      console.error("PostgreSQL tracked_entities update failed:", e);
    }
  }

  const stmt = db.prepare("INSERT INTO tracked_entities (entity_id, tracked, notes) VALUES (?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET tracked = ?, notes = ?");
  stmt.run(entity_id, tracked ? 1 : 0, notes || '', tracked ? 1 : 0, notes || '');
  res.json({ success: true });
});

app.post("/api/ai/trigger-daily-analysis", async (req, res) => {
  // Manual trigger for testing
  runDailyAnalysis().then(() => {
    res.json({ success: true, message: "Analysis started in background" });
  }).catch(err => {
    res.status(500).json({ error: err.message });
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Sync settings from PostgreSQL if it's the primary DB
    if (pgPool && pgReady) {
      try {
        const result = await pgPool.query("SELECT * FROM settings");
        const updateSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?");
        for (const row of result.rows) {
          updateSetting.run(row.key, row.value, row.value);
        }
        console.log(`Synced ${result.rows.length} settings from PostgreSQL to SQLite.`);
      } catch (e) {
        console.error("Failed to sync settings from PostgreSQL on startup:", e);
      }
    }

    connectToHA();
  });

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/api/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });
}

startServer();
