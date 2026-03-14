import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { exec } from "child_process";
import util from "util";
import { GoogleGenAI, Type } from "@google/genai";
import pg from "pg";
import session from "express-session";

// Extend express-session to include user
declare module 'express-session' {
  interface SessionData {
    user: { id: number; username: string; role: string };
  }
}

const { Pool } = pg;

// Initialize PostgreSQL Pool
let pgPool: pg.Pool | null = null;
const dbUrl = process.env.DATABASE_URL || "postgres://hb_user:homebrainpass@localhost:5432/home_brain";

try {
  pgPool = new Pool({
    connectionString: dbUrl,
    // For local Ubuntu setup, we usually don't need SSL
    ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  
  // Test connection immediately
  pgPool.query('SELECT NOW()', (err, res) => {
    if (err) {
      console.warn("Local PostgreSQL connection failed (expected if service not running yet):", err.message);
      // We don't nullify pgPool here so it can retry or be used for migration later
    } else {
      console.log("PostgreSQL connected successfully to local service.");
    }
  });
} catch (e) {
  console.error("PostgreSQL initialization failed:", e);
}

const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "home-brain-secret-key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  }
}));

// Initialize SQLite Database
const DB_PATH = "/data/home_brain.db";
const OLD_DB_PATH = path.join(process.cwd(), "home_brain.db");

// Ensure /data exists
if (!fs.existsSync("/data")) {
  fs.mkdirSync("/data", { recursive: true });
}

// Move database if it exists in the old location
if (fs.existsSync(OLD_DB_PATH) && !fs.existsSync(DB_PATH)) {
  console.log(`Moving database from ${OLD_DB_PATH} to ${DB_PATH}`);
  fs.renameSync(OLD_DB_PATH, DB_PATH);
}

const db = new Database(DB_PATH);

const CURRENT_DB_VERSION = 2; // Increment this when adding new migrations

function parseUserContext(rawValue: string): string {
  if (!rawValue) return "";
  try {
    const parsed = JSON.parse(rawValue);
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
        status TEXT DEFAULT 'unknown'
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
    console.log("Applying Migration: Version 2 (Adding notes to tracked_entities and unique index)");
    try {
      db.exec("ALTER TABLE tracked_entities ADD COLUMN notes TEXT DEFAULT ''");
    } catch (e) {
      // Column might already exist from previous manual attempts
      console.warn("Migration V2 Warning: 'notes' column might already exist.");
    }
    
    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_history_unique ON device_history(entity_id, last_changed)");
    } catch (e) {
      console.warn("Migration V2 Warning: 'idx_history_unique' might already exist.");
    }
    
    currentVersion = 2;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(String(currentVersion));
  }

  // 5. Default Settings & Admin User
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  insertSetting.run("ha_url", "http://homeassistant.local:8123");
  insertSetting.run("ha_token", "");
  insertSetting.run("user_ai_context", "");
  insertSetting.run("dashboard_graph_zones", "[]");
  insertSetting.run("ai_realtime_interval", "5");
  insertSetting.run("ai_lookback_days", "14");
  insertSetting.run("ai_context_window_hours", "2");
  insertSetting.run("ai_model", "gemini-3-flash-preview");
  insertSetting.run("climate_abs_min", "55");
  insertSetting.run("climate_abs_max", "80");
  insertSetting.run("dashboard_default_timeframe", "24h");
  insertSetting.run("ghost_mode_hvac", "true");
  insertSetting.run("ghost_mode_whole_home", "true");

  const insertUser = db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)");
  insertUser.run("admin", "admin", "admin");

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
    
    const lookbackDays = Number(getSetting("ai_lookback_days", "14"));
    
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

function connectToHA() {
  if (haReconnectTimeout) {
    clearTimeout(haReconnectTimeout);
    haReconnectTimeout = null;
  }

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
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_required') {
        haWs?.send(JSON.stringify({ type: 'auth', access_token: ha_token }));
      } else if (msg.type === 'auth_ok') {
        console.log('Connected to HA WebSocket');
        setHaStatus('connected');
        haWs?.send(JSON.stringify({ id: haMessageId++, type: 'subscribe_events', event_type: 'state_changed' }));
        fillHistoryGaps();
      } else if (msg.type === 'auth_invalid') {
        setHaStatus('disconnected', 'Invalid Access Token');
        console.error('HA WS Auth Invalid');
      } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
        const entity_id = msg.event.data.entity_id;
        const state = msg.event.data.new_state?.state;
        const attributes = JSON.stringify(msg.event.data.new_state?.attributes || {});
        
        const insertHistory = db.prepare("INSERT OR IGNORE INTO device_history (entity_id, state, attributes, last_changed) VALUES (?, ?, ?, datetime('now'))");
        const info = insertHistory.run(entity_id, state, attributes);
        
        if (pgPool) {
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
        // If a person or tracker arrives home, check if we need to self-correct the HVAC
        if ((entity_id.startsWith('person.') || entity_id.startsWith('device_tracker.')) && state === 'home') {
           const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))");
           insertReasoning.run(
             "Real-time Presence Event", 
             "Self-Correction Triggered", 
             `Detected ${entity_id} arriving home unexpectedly or triggering a state change. Overriding schedule to ensure comfort in active zones.`
           );
           broadcastToFrontend({ type: 'NEW_REASONING' });
        }

        // Broadcast to frontend
        broadcastToFrontend({ type: 'NEW_HISTORY', data: newRecord });
      }
    });

    haWs.on('error', (err) => {
      console.error('HA WS Error:', err.message);
      let errorMsg = err.message;
      if (errorMsg.includes('ENOTFOUND')) errorMsg = 'Address not found (DNS failure)';
      else if (errorMsg.includes('ECONNREFUSED')) errorMsg = 'Connection refused (Check port/firewall)';
      else if (errorMsg.includes('ETIMEDOUT')) errorMsg = 'Connection timed out';
      
      setHaStatus('disconnected', errorMsg);
    });

    haWs.on('close', (code, reason) => {
      console.log(`HA WS Closed (Code: ${code}, Reason: ${reason}). Reconnecting in 5s...`);
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
    const aiModel = getSetting("ai_model", "gemini-3-flash-preview");
    const lookbackDays = Number(getSetting("ai_lookback_days", "14"));
    const apiKey = getSetting("gemini_api_key", process.env.GEMINI_API_KEY || "");
    
    if (!apiKey || apiKey === "undefined" || apiKey === "null") {
      const msg = "Gemini API Key is not configured in settings.";
      console.error(msg);
      throw new Error(msg);
    }
    
    const ai = new GoogleGenAI({ apiKey });

    // Fetch context
    const states = await fetchHA('/api/states') || [];
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[] || [];
    const trackedIds = trackedRows.map(t => t.entity_id);
    
    let history: any[] = [];
    let logbook: any[] = [];
    if (trackedIds.length > 0) {
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

    const settingsRows = db.prepare("SELECT * FROM settings WHERE key = 'user_ai_context'").get() as any;
    const userContextRaw = settingsRows ? settingsRows.value : "";
    const userContext = parseUserContext(userContextRaw);

    const snapshotRow = db.prepare("SELECT data FROM ha_system_snapshots ORDER BY created_at DESC LIMIT 1").get() as any;
    const systemSnapshot = snapshotRow ? JSON.parse(snapshotRow.data) : {};

    const automationsScripts = db.prepare("SELECT entity_id, name, domain, content FROM ha_automations_scripts").all() as any[] || [];

    const prompt = `
      You are an intelligent Home Assistant brain managing a complex multi-zone HVAC setup (scaling up to 7 zones) and lighting.
      Analyze the following smart home data from the last ${lookbackDays} days.
      
      CRITICAL GOALS:
      1. Generate a rolling ${lookbackDays}-day schedule.
      2. Infer custody schedules (alternating weeks/days) based on presence patterns in the ${lookbackDays}-day history.
      3. Infer school/work arrival/departure times and pre-heat/pre-cool appropriate zones.
      4. Identify "Ghost" patterns (recurring times when the house is empty but HVAC is active).
      5. Provide detailed reasoning for every schedule block.
      6. LEARN FROM USER AUTOMATIONS: I have provided a list of your existing Home Assistant automations and scripts. Use these to understand how you group actions (e.g., "Night Mode", "Away Mode", "Arriving Home") and what triggers you typically use (e.g., sunrise, sunset, presence). This helps you align your generated schedules with your existing preferences.
      7. GLOBAL HOUSE MODES: Transition from basic temperature scheduling to a state-based mode engine (e.g., Night, Away, Home). Factor the current and upcoming "Mode" into your decisions.
      8. PREDICTIVE PRE-CONDITIONING: Calculate "Thermal Inertia" from the device_history (e.g., recognizing how long a room takes to drop 2 degrees) and factor in external elements like humidity to trigger HVAC ahead of schedule.
      9. SCRIPT EXECUTION PRIORITY: Prioritize triggering existing Home Assistant scripts or automations using the Long-Lived Access Token, rather than attempting to micro-manage devices directly.
      10. SCOPE EXCLUSION: Do not include or plan for any solar-production logic or solar-weighted algorithms at this time. If Home Assistant disconnects, do not attempt to build hardware failsafes; simply log the error and halt commands.
      11. HIGH PRIORITY CONTEXT: Pay extremely close attention to the USER PROVIDED CONTEXT notes below. These notes represent explicit user instructions, overrides, or upcoming events. Also, any notes or descriptions attached to specific devices must be treated as high priority constraints.
      
      USER PROVIDED CONTEXT:
      ${userContext}
      
      SYSTEM SNAPSHOT (Full Entity List & Config): ${JSON.stringify(systemSnapshot)}
      USER AUTOMATIONS & SCRIPTS (For Learning Patterns): ${JSON.stringify(automationsScripts)}
      Tracked Devices: ${JSON.stringify(trackedRows)}
      Recent History (Last ${lookbackDays} Days): ${JSON.stringify(history.slice(-1000))}
      Logbook Events (Last ${lookbackDays} Days): ${JSON.stringify(logbook.slice(-500))}
      
      Return a JSON object with:
      {
        "insights": ["insight 1", ...],
        "reasoning": [{ "context": "...", "decision": "...", "reasoning": "..." }],
        "schedule": { "name": "...", "description": "...", "schedule_data": [...] }
      }
    `;

    const response = await ai.models.generateContent({
      model: aiModel,
      contents: prompt,
      config: { 
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            insights: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            reasoning: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  context: { type: Type.STRING },
                  decision: { type: Type.STRING },
                  reasoning: { type: Type.STRING }
                },
                required: ["context", "decision", "reasoning"]
              }
            },
            schedule: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                schedule_data: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      day: { type: Type.STRING },
                      time: { type: Type.STRING },
                      entity_id: { type: Type.STRING },
                      state: { type: Type.STRING },
                      reasoning: { type: Type.STRING }
                    },
                    required: ["day", "time", "entity_id", "state"]
                  }
                }
              },
              required: ["name", "schedule_data"]
            }
          },
          required: ["insights", "reasoning", "schedule"]
        }
      }
    });

    const result = JSON.parse((response.text || "{}").replace(/```json\n?|```/g, '').trim());
    
    // Save analysis
    if (result.schedule && result.schedule.name) {
      if (pgPool) {
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
    
    if (result.insights && Array.isArray(result.insights)) {
      const insertInsight = db.prepare("INSERT INTO insights (content, created_at) VALUES (?, datetime('now'))");
      for (const insight of result.insights) {
        insertInsight.run(insight);
      }
    }

    if (result.reasoning && Array.isArray(result.reasoning)) {
      const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now'))");
      for (const r of result.reasoning) {
        insertReasoning.run(r.context || "General", r.decision || "Adjustment", r.reasoning || "");
      }
    }
    
    broadcastToFrontend({ type: 'NEW_REASONING' });
    return result;

  } catch (e: any) {
    if (e.message && e.message.includes("API key not valid")) {
      console.warn("Skipping daily analysis: API key not valid.");
      return {};
    }
    console.error("Daily analysis error", e);
    await sendTelegramAlert(`Daily Analysis Failed:\n\n${e.stack || e.message}`);
    throw e;
  }
}

// Run daily analysis every 24 hours
setInterval(runDailyAnalysis, 24 * 60 * 60 * 1000);

// --- Real-time AI Control Loop ---
async function executeRealTimeAIControl() {
  try {
    const aiModel = getSetting("ai_model", "gemini-3-flash-preview");
    const contextWindowHours = Number(getSetting("ai_context_window_hours", "2"));
    const apiKey = getSetting("gemini_api_key", process.env.GEMINI_API_KEY || "");
    
    if (!apiKey || apiKey === "undefined" || apiKey === "null") {
      console.warn("Gemini API Key is not configured in settings. Skipping real-time control.");
      return;
    }
    
    const ai = new GoogleGenAI({ apiKey });

    const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
    const settings: Record<string, string> = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    const ghostModeHvac = settings.ghost_mode_hvac === 'true';
    const ghostModeWholeHome = settings.ghost_mode_whole_home === 'true';

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
    const systemSnapshot = snapshotRow ? JSON.parse(snapshotRow.data) : {};

    const automationsScripts = db.prepare("SELECT entity_id, name, domain, content FROM ha_automations_scripts").all() as any[] || [];

    const prompt = `
      You are the HomeBrain AI real-time controller and predictive trend-based inference engine.
      Analyze the current state and recent history to determine the home state and if actions are needed.
      
      NO ASSUMPTION POLICY: Base your inferred_home_state strictly on the provided Tracked States and history. 
      Do not assume someone is asleep just because of the time of day; verify lack of motion (binary_sensor) or media player activity.
      
      INSTRUCTIONS:
      1. If the home state transitions to 'Sleep' or 'Away', you must output actions to proactively adjust the HVAC zone temperatures and turn off active lights.
      2. Analyze media_player, light, and binary_sensor (motion) entities alongside climate data to infer human behavior.
      3. LEARN FROM USER AUTOMATIONS: Use the provided Home Assistant automations and scripts to understand user intent for various home states (e.g., what "Night Mode" means to this specific user).
      4. GLOBAL HOUSE MODES: Factor the current and upcoming "Mode" (e.g., Night, Away, Home) into your decisions.
      5. PREDICTIVE PRE-CONDITIONING: Calculate "Thermal Inertia" from the device_history (e.g., recognizing how long a room takes to drop 2 degrees) and factor in external elements like humidity to trigger HVAC ahead of schedule.
      6. SCRIPT EXECUTION PRIORITY: Prioritize triggering existing Home Assistant scripts or automations using the Long-Lived Access Token, rather than attempting to micro-manage devices directly.
      7. SCOPE EXCLUSION: Do not include or plan for any solar-production logic or solar-weighted algorithms at this time. If Home Assistant disconnects, do not attempt to build hardware failsafes; simply log the error and halt commands.
      
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

    const response = await ai.models.generateContent({
      model: aiModel,
      contents: prompt,
      config: { 
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            inferred_home_state: { 
              type: Type.STRING,
              description: "The current inferred state of the home."
            },
            confidence_score: { 
              type: Type.INTEGER,
              description: "Confidence level of the inference (0-100)."
            },
            actions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  domain: { type: Type.STRING },
                  service: { type: Type.STRING },
                  entity_id: { type: Type.STRING },
                  service_data: { type: Type.OBJECT },
                  reasoning: { type: Type.STRING }
                },
                required: ["type", "domain", "service", "entity_id", "reasoning"]
              }
            }
          },
          required: ["inferred_home_state", "confidence_score", "actions"]
        }
      }
    });

    const result = JSON.parse((response.text || "{}").replace(/```json\n?|```/g, '').trim());
    
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
    if (error.message && error.message.includes("API key not valid")) {
      console.warn("Skipping real-time control: API key not valid.");
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

  if (dbType === "postgresql" && pgPool) {
    try {
      const result = await pgPool.query("SELECT * FROM users WHERE username = $1 AND password = $2", [username, password]);
      user = result.rows[0];
    } catch (e) {
      console.error("PostgreSQL auth failed:", e);
    }
  }

  if (!user) {
    user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password) as any;
  }

  if (user) {
    const userData = { id: user.id, username: user.username, role: user.role };
    req.session.user = userData;
    res.json({ success: true, user: userData });
  } else {
    res.status(401).json({ success: false, error: "Invalid credentials" });
  }
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

app.get("/api/users", (req, res) => {
  const users = db.prepare("SELECT id, username, role FROM users").all();
  res.json(users);
});

app.post("/api/users", (req, res) => {
  const { username, password, role } = req.body;
  try {
    const stmt = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
    stmt.run(username, password, role);
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/users/:id", (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Occupancy Roster Routes
app.get("/api/occupancy", (req, res) => {
  try {
    const roster = db.prepare("SELECT * FROM occupancy_roster").all();
    res.json(roster);
  } catch (e: any) {
    console.error("Failed to fetch occupancy roster:\n", e.stack);
    sendTelegramAlert(`Failed to fetch occupancy roster:\n\n${e.stack}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/occupancy", (req, res) => {
  const { name, entity_id } = req.body;
  try {
    const stmt = db.prepare("INSERT INTO occupancy_roster (name, entity_id) VALUES (?, ?)");
    stmt.run(name, entity_id);
    res.json({ success: true });
  } catch (e: any) {
    console.error("Failed to add to occupancy roster:\n", e.stack);
    sendTelegramAlert(`Failed to add to occupancy roster:\n\n${e.stack}`);
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/occupancy/:id", (req, res) => {
  try {
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

app.get("/api/settings", (req, res) => {
  const settings = db.prepare("SELECT * FROM settings").all();
  const settingsObj = settings.reduce((acc: any, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
  res.json(settingsObj);
});

app.post("/api/settings", (req, res) => {
  const updates = req.body;
  const updateSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?");
  
  for (const [key, value] of Object.entries(updates)) {
    updateSetting.run(key, String(value), String(value));
  }
  
  // Reconnect to HA if url/token changed
  if (updates.ha_url !== undefined || updates.ha_token !== undefined) {
    connectToHA();
  }

  // Restart real-time loop if interval changed
  if (updates.ai_realtime_interval !== undefined) {
    startRealTimeAIControl();
  }
  
  res.json({ success: true });
});

// System Update Endpoints
app.get("/api/system/check-update", async (req, res) => {
  try {
    // Check if we are in a git repository
    if (!fs.existsSync(path.join(__dirname, '.git'))) {
      return res.json({ updateAvailable: false, message: "System updates are disabled in this environment (not a git repository)." });
    }

    await execAsync('git rev-parse --is-inside-work-tree');
    
    // Fetch latest from origin
    await execAsync('git fetch origin');
    
    const local = await execAsync('git rev-parse HEAD');
    const remote = await execAsync('git rev-parse @{u}');
    
    if (local.stdout.trim() !== remote.stdout.trim()) {
      res.json({ updateAvailable: true, message: "A new version is available on GitHub." });
    } else {
      res.json({ updateAvailable: false, message: "System is up to date." });
    }
  } catch (e: any) {
    console.error("Update check failed:", e.message);
    res.json({ updateAvailable: false, message: "Could not check for updates. Ensure this is a git repository connected to origin." });
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

    broadcastProgress("Starting robust system update...");
    
    // 1. Stash any local changes to avoid pull conflicts
    try {
      broadcastProgress("Stashing local changes...");
      await execAsync('git stash');
    } catch (e) {
      broadcastProgress("No local changes to stash or stash failed (ignoring).");
    }

    // 2. Pull latest changes
    broadcastProgress("Pulling latest changes from origin/main...");
    await execAsync('git pull origin main');
    
    // 3. Install dependencies
    broadcastProgress("Installing dependencies (this may take a minute)...");
    await execAsync('npm install');
    
    // 4. Build the application
    broadcastProgress("Building application (this may take a minute)...");
    await execAsync('npm run build');
    
    // 5. Verify build output exists
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) {
      throw new Error("Build failed: 'dist' directory not found after npm run build.");
    }

    broadcastProgress("Update successful.");
    res.json({ 
      success: true, 
      message: "Update pulled and built successfully! The server will now attempt to restart to apply changes. If it doesn't come back online in 30 seconds, please manually restart the service." 
    });

    // 6. Optional: Trigger a graceful exit to allow PM2 or systemd to restart the process
    setTimeout(() => {
      broadcastProgress("Restarting process to apply migrations and new code...");
      process.exit(0);
    }, 2000);

  } catch (e: any) {
    console.error("[Update] Update failed:", e.message);
    broadcastToFrontend({ type: 'UPDATE_PROGRESS', message: `ERROR: ${e.message}` });
    res.status(500).json({ success: false, error: `Update failed: ${e.message}` });
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
  if (pgPool) {
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
  
  const zones = JSON.parse(zonesParam);
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
    const systemSnapshot = snapshotRow ? JSON.parse(snapshotRow.data) : null;

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
    
    let history: any[] = [];
    if (trackedIds.length > 0) {
      const placeholders = trackedIds.map(() => '?').join(',');
      // Fetch 14 days of history for better pattern recognition (custody, work, etc)
      history = db.prepare(`
        SELECT entity_id, state, attributes, last_changed 
        FROM device_history 
        WHERE last_changed >= datetime('now', '-14 days') 
        AND entity_id IN (${placeholders})
        ORDER BY last_changed ASC
      `).all(...trackedIds) as any[];

      // If history is sparse (less than 50 entries for 14 days), try to force a gap fill from HA
      if (history.length < 50) {
        console.log("History sparse, triggering emergency gap fill for AI analysis...");
        await fillHistoryGaps();
        // Re-fetch after gap fill
        history = db.prepare(`
          SELECT entity_id, state, attributes, last_changed 
          FROM device_history 
          WHERE last_changed >= datetime('now', '-14 days') 
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
    const systemSnapshot = snapshotRow ? JSON.parse(snapshotRow.data) : null;

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
        last_changed TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        name TEXT,
        description TEXT,
        schedule_data TEXT,
        created_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_history_entity_time ON device_history(entity_id, last_changed);
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

    // 4. Migrate History
    const history = db.prepare("SELECT * FROM device_history").all() as any[];
    broadcastProgress(`Migrating ${history.length} history records...`);
    
    // Use a transaction for history to be faster
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      for (const record of history) {
        await client.query(
          "INSERT INTO device_history (entity_id, state, attributes, last_changed) VALUES ($1, $2, $3, $4)",
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

    // 5. Migrate Schedules
    const schedules = db.prepare("SELECT * FROM schedules").all() as any[];
    broadcastProgress(`Migrating ${schedules.length} schedules...`);
    for (const s of schedules) {
      await pgPool.query(
        "INSERT INTO schedules (name, description, schedule_data, created_at) VALUES ($1, $2, $3, $4)",
        [s.name, s.description, s.schedule_data, s.created_at]
      );
    }

    // 6. Mark migration as complete in settings
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run("database_type", "postgresql", "postgresql");
    await pgPool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2", ["database_type", "postgresql"]);

    broadcastProgress("Migration to local PostgreSQL complete.");
    res.json({ success: true, message: "Migration to local PostgreSQL complete. All users and settings have been moved." });
  } catch (e: any) {
    console.error("PostgreSQL Migration failed:", e);
    broadcastToFrontend({ type: 'MIGRATION_PROGRESS', message: `ERROR: ${e.message}` });
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/schedules", async (req, res) => {
  if (pgPool) {
    try {
      const result = await pgPool.query("SELECT * FROM schedules ORDER BY created_at DESC");
      return res.json(result.rows);
    } catch (e) {
      console.error("PostgreSQL schedules fetch failed:", e);
    }
  }
  const schedules = db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all();
  res.json(schedules);
});

app.get("/api/insights", (req, res) => {
  const insights = db.prepare("SELECT * FROM insights ORDER BY created_at DESC LIMIT 20").all();
  res.json(insights);
});

app.get("/api/reasoning", (req, res) => {
  const reasoning = db.prepare("SELECT * FROM ai_reasoning ORDER BY created_at DESC LIMIT 50").all();
  res.json(reasoning);
});

app.post("/api/ai/scan-entities", async (req, res) => {
  try {
    const apiKey = getSetting("gemini_api_key", process.env.GEMINI_API_KEY || "");
    if (!apiKey || apiKey === "undefined" || apiKey === "null") {
      throw new Error("Gemini API Key is not configured in settings.");
    }
    const ai = new GoogleGenAI({ apiKey });
    
    let states = await fetchHA('/api/states');
    if (!states) {
      states = [
        { entity_id: 'climate.zone_1_living_room', attributes: { friendly_name: 'Zone 1 (Living Room)' } },
        { entity_id: 'climate.zone_2_master', attributes: { friendly_name: 'Zone 2 (Master Bed)' } },
        { entity_id: 'climate.zone_3_kids', attributes: { friendly_name: 'Zone 3 (Kids Room)' } },
        { entity_id: 'climate.zone_4_basement', attributes: { friendly_name: 'Zone 4 (Basement)' } },
        { entity_id: 'person.anthony', attributes: { friendly_name: 'Anthony' } },
        { entity_id: 'device_tracker.kids_ipad', attributes: { friendly_name: 'Kids iPad' } },
        { entity_id: 'light.kitchen', attributes: { friendly_name: 'Kitchen Lights' } }
      ];
    }

    const entityList = states.map((e: any) => ({
      entity_id: e.entity_id,
      friendly_name: e.attributes.friendly_name || e.entity_id,
      domain: e.entity_id.split('.')[0]
    }));

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Analyze these Home Assistant entities and identify which ones are critical for an AI-driven climate control and home automation system. 
      Focus on:
      1. Climate/Thermostat entities.
      2. Temperature/Humidity sensors.
      3. Presence/Occupancy sensors (person, device_tracker, binary_sensor.motion).
      4. Main lights or switches that indicate occupancy or activity.
      
      Return a JSON array of objects with 'entity_id' and a brief 'reason' why it should be tracked.
      
      Entities: ${JSON.stringify(entityList.slice(0, 300))} (truncated if too many)`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              entity_id: { type: Type.STRING },
              reason: { type: Type.STRING }
            },
            required: ["entity_id", "reason"]
          }
        }
      }
    });

    const suggestions = JSON.parse((response.text || "[]").replace(/```json\n?|```/g, '').trim());
    res.json(suggestions);

  } catch (e: any) {
    if (e.message && e.message.includes("API key not valid")) {
      console.warn("Skipping AI scan: API key not valid.");
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
      states = [
        { entity_id: 'climate.zone_1_living_room', attributes: { friendly_name: 'Zone 1 (Living Room)' } },
        { entity_id: 'climate.zone_2_master', attributes: { friendly_name: 'Zone 2 (Master Bed)' } },
        { entity_id: 'climate.zone_3_kids', attributes: { friendly_name: 'Zone 3 (Kids Room)' } },
        { entity_id: 'climate.zone_4_basement', attributes: { friendly_name: 'Zone 4 (Basement)' } },
        { entity_id: 'person.anthony', attributes: { friendly_name: 'Anthony' } },
        { entity_id: 'device_tracker.kids_ipad', attributes: { friendly_name: 'Kids iPad' } },
        { entity_id: 'light.kitchen', attributes: { friendly_name: 'Kitchen Lights' } }
      ];
    }
    
    const entities = states.map((s: any) => ({
      entity_id: s.entity_id,
      friendly_name: s.attributes.friendly_name || s.entity_id,
      domain: s.entity_id.split('.')[0]
    }));
    
    const trackedRows = db.prepare("SELECT * FROM tracked_entities").all() as any[];
    const trackedMap = trackedRows.reduce((acc: any, row: any) => {
      acc[row.entity_id] = { tracked: row.tracked === 1, notes: row.notes || '' };
      return acc;
    }, {});

    res.json({ entities, tracked: trackedMap });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/ha/tracked", (req, res) => {
  const { entity_id, tracked, notes } = req.body;
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
    app.use(express.static(path.join(__dirname, "dist")));
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
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
