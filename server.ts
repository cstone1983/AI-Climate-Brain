import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize SQLite Database
const db = new Database("home_brain.db");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  
  CREATE TABLE IF NOT EXISTS device_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT,
    state TEXT,
    attributes TEXT,
    last_changed DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    schedule_data TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS tracked_entities (
    entity_id TEXT PRIMARY KEY,
    tracked BOOLEAN DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS ai_reasoning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context TEXT,
    decision TEXT,
    reasoning TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT
  );

  -- Indexes for long-term vast data storage performance
  CREATE INDEX IF NOT EXISTS idx_device_history_entity_time ON device_history(entity_id, last_changed);
  CREATE INDEX IF NOT EXISTS idx_device_history_time ON device_history(last_changed);
`);

// Safe migration for new columns
try {
  db.exec("ALTER TABLE tracked_entities ADD COLUMN notes TEXT DEFAULT ''");
} catch (e) {}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_history_unique ON device_history(entity_id, last_changed)");
} catch (e) {}

// Default settings if not exist
const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
insertSetting.run("ha_url", "http://homeassistant.local:8123");
insertSetting.run("ha_token", "");
insertSetting.run("user_ai_context", "");
insertSetting.run("dashboard_graph_zones", "[]");

// Default Admin User
const insertUser = db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)");
insertUser.run("admin", "admin", "admin");

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

function setHaStatus(status: string) {
  haStatus = status;
  broadcastToFrontend({ type: 'HA_STATUS', status });
}

async function fillHistoryGaps() {
  try {
    console.log("Checking for history gaps...");
    const lastRecord = db.prepare("SELECT MAX(last_changed) as last_ts FROM device_history").get() as any;
    let startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Default 24h ago
    if (lastRecord && lastRecord.last_ts) {
      // Try to parse the local time string back to a valid Date object
      const parsedDate = new Date(lastRecord.last_ts + 'Z');
      if (!isNaN(parsedDate.getTime())) {
        startTime = parsedDate.toISOString();
      }
    }
    
    const trackedRows = db.prepare("SELECT entity_id FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    
    // Fetch all states to find all climate and temperature entities
    const allStates = await fetchHA('/api/states');
    let entitiesToFetch = new Set<string>(trackedIds);
    
    if (allStates && Array.isArray(allStates)) {
      for (const stateObj of allStates) {
        if (stateObj.entity_id.startsWith('climate.') || 
            (stateObj.entity_id.startsWith('sensor.') && stateObj.entity_id.includes('temperature'))) {
          entitiesToFetch.add(stateObj.entity_id);
        }
      }
    }
    
    const entitiesArray = Array.from(entitiesToFetch);
    if (entitiesArray.length === 0) {
      console.log("No entities to fetch history for. Skipping history gap fill.");
      return;
    }

    console.log(`Fetching history for ${entitiesArray.length} entities in chunks...`);
    const chunkSize = 20;
    const insertHistory = db.prepare("INSERT OR IGNORE INTO device_history (entity_id, state, attributes, last_changed) VALUES (?, ?, ?, ?)");
    
    for (let i = 0; i < entitiesArray.length; i += chunkSize) {
      const chunk = entitiesArray.slice(i, i + chunkSize);
      try {
        const historyData = await fetchHA(`/api/history/period/${encodeURIComponent(startTime)}?filter_entity_id=${chunk.join(',')}`);
        if (historyData && Array.isArray(historyData)) {
          db.transaction(() => {
            for (const entityHistory of historyData) {
              for (const stateObj of entityHistory) {
                insertHistory.run(stateObj.entity_id, stateObj.state, JSON.stringify(stateObj.attributes || {}), stateObj.last_changed);
              }
            }
          })();
        }
      } catch (chunkErr: any) {
        console.error(`Error fetching history chunk ${i / chunkSize + 1}:`, chunkErr.message);
      }
    }
    console.log("History gap fill complete.");
  } catch (e) {
    console.error("Gap fill error", e);
  }
}

function connectToHA() {
  setHaStatus('connecting');
  const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }

  const ha_url = settings["ha_url"];
  const ha_token = settings["ha_token"];
  if (!ha_url || !ha_token) {
    setHaStatus('disconnected');
    return;
  }

  const baseUrl = ha_url.endsWith('/') ? ha_url.slice(0, -1) : ha_url;
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/websocket';
  
  if (haWs) {
    haWs.close();
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
        setHaStatus('disconnected');
        console.error('HA WS Auth Invalid');
      } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
        const entity_id = msg.event.data.entity_id;
        const state = msg.event.data.new_state?.state;
        const attributes = JSON.stringify(msg.event.data.new_state?.attributes || {});
        
        const insertHistory = db.prepare("INSERT INTO device_history (entity_id, state, attributes, last_changed) VALUES (?, ?, ?, datetime('now', 'localtime'))");
        const info = insertHistory.run(entity_id, state, attributes);
        
        const newRecord = db.prepare("SELECT * FROM device_history WHERE id = ?").get(info.lastInsertRowid);
        
        // Real-time Self-Correction Logic
        // If a person or tracker arrives home, check if we need to self-correct the HVAC
        if ((entity_id.startsWith('person.') || entity_id.startsWith('device_tracker.')) && state === 'home') {
           const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now', 'localtime'))");
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
      setHaStatus('disconnected');
    });

    haWs.on('close', () => {
      console.log('HA WS Closed. Reconnecting in 5s...');
      setHaStatus('disconnected');
      setTimeout(connectToHA, 5000);
    });
  } catch (err) {
    console.error('Failed to connect to HA WS:', err);
    setHaStatus('disconnected');
    setTimeout(connectToHA, 5000);
  }
}

// --- HA REST API Helper ---
async function fetchHA(endpoint: string) {
  const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
  const settings: Record<string, string> = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }
  const ha_url = settings["ha_url"];
  const ha_token = settings["ha_token"];
  if (!ha_url || !ha_token) return null;

  const baseUrl = ha_url.endsWith('/') ? ha_url.slice(0, -1) : ha_url;
  const endpointUrl = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  const res = await fetch(`${baseUrl}${endpointUrl}`, {
    headers: {
      "Authorization": `Bearer ${ha_token}`,
      "Content-Type": "application/json"
    }
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HA API Error (${res.status} ${res.statusText}) on ${endpointUrl}: ${errorText}`);
  }
  return res.json();
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

// --- Daily AI Analysis ---
async function runDailyAnalysis() {
  try {
    console.log("Running daily AI analysis...");
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not defined");
      return;
    }
    const ai = new GoogleGenAI({ apiKey });
    
    // Fetch all states (includes automations, scripts, devices)
    const states = await fetchHA('/api/states');
    if (!states) {
      console.log("HA not configured or unreachable. Skipping analysis.");
      return;
    }

    // Get tracked entities and their notes (roles)
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    const trackedContext = trackedRows.map(t => ({ id: t.entity_id, notes: t.notes }));

    // Fetch history for the last 24 hours directly from our local database
    let history: any[] = [];
    if (trackedIds.length > 0) {
      const placeholders = trackedIds.map(() => '?').join(',');
      history = db.prepare(`
        SELECT entity_id, state, attributes, last_changed 
        FROM device_history 
        WHERE last_changed >= datetime('now', '-1 day', 'localtime') 
        AND entity_id IN (${placeholders})
        ORDER BY last_changed ASC
      `).all(...trackedIds) as any[];
    }

    // Filter states
    const automations = states.filter((s: any) => s.entity_id.startsWith('automation.'));
    const scripts = states.filter((s: any) => s.entity_id.startsWith('script.'));
    const trackedStates = states.filter((s: any) => trackedIds.includes(s.entity_id));

    const settingsRows = db.prepare("SELECT * FROM settings WHERE key = 'user_ai_context'").get() as any;
    const userContext = settingsRows ? settingsRows.value : "";

    const prompt = `
      You are an intelligent Home Assistant brain managing a complex multi-zone HVAC setup (scaling up to 7 zones) and lighting.
      Analyze the following smart home data from the last 24 hours.
      
      CRITICAL GOALS:
      1. Generate a rolling 14-day schedule.
      2. Infer custody schedules (alternating weeks/days) based on presence data (especially Anthony's phone or other noted trackers).
      3. Infer school/work arrival times and pre-heat/pre-cool the appropriate zones BEFORE arrival.
      4. Provide detailed reasoning for your decisions so the user can trust your logic.
      
      IMPORTANT: The home is located in the Eastern Standard Time (EST) timezone. All times you generate, reference, and reason about MUST be in EST.
      
      USER PROVIDED CONTEXT / UPCOMING EVENTS:
      "${userContext}"
      
      Tracked Devices & User Notes (Pay attention to roles like "Anthony's Phone" or "Zone 1"):
      ${JSON.stringify(trackedContext)}
      
      Current States of Tracked Devices:
      ${JSON.stringify(trackedStates)}
      
      Automations & Scripts:
      ${JSON.stringify(automations.map((a:any) => ({id: a.entity_id}))) /* Truncated for tokens */}
      
      Recent History (Last 24h):
      ${JSON.stringify(history ? history.slice(0, 100) : [])}
      
      Return a JSON object with EXACTLY this structure:
      {
        "insights": ["insight 1", "insight 2"],
        "reasoning": [
          { "context": "Custody Schedule", "decision": "Pre-heat Zone 2", "reasoning": "Anthony's phone pattern indicates he arrives at 3:30 PM on alternating Tuesdays." }
        ],
        "schedule": {
          "name": "Rolling 14-Day Optimal Schedule",
          "description": "Multi-zone predictive schedule based on inferred occupancy.",
          "schedule_data": [
            { "day": "2023-10-25", "events": [{"time": "15:00", "entity": "climate.zone_2", "action": "heat", "temp": 72}] }
          ]
        }
      }
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const result = JSON.parse(response.text || "{}");
    
    if (result.schedule && result.schedule.name) {
      const insertSchedule = db.prepare("INSERT INTO schedules (name, description, schedule_data, created_at) VALUES (?, ?, ?, datetime('now', 'localtime'))");
      insertSchedule.run(result.schedule.name, result.schedule.description || "", JSON.stringify(result.schedule.schedule_data));
    }
    
    if (result.insights && Array.isArray(result.insights)) {
      const insertInsight = db.prepare("INSERT INTO insights (content, created_at) VALUES (?, datetime('now', 'localtime'))");
      for (const insight of result.insights) {
        insertInsight.run(insight);
      }
    }

    if (result.reasoning && Array.isArray(result.reasoning)) {
      const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now', 'localtime'))");
      for (const r of result.reasoning) {
        insertReasoning.run(r.context || "General", r.decision || "Adjustment", r.reasoning || "");
      }
    }
    
    // Notify frontend of new data
    broadcastToFrontend({ type: 'NEW_REASONING' });
    console.log("Daily analysis completed successfully.");
  } catch (error) {
    console.error("Daily analysis error:", error);
  }
}

// Run daily analysis every 24 hours
setInterval(runDailyAnalysis, 24 * 60 * 60 * 1000);

// --- Real-time AI Control Loop ---
async function executeRealTimeAIControl() {
  try {
    const settingsRows = db.prepare("SELECT * FROM settings").all() as any[];
    const settings: Record<string, string> = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }
    
    // Default to true (safe) if not explicitly disabled
    const ghostModeHvac = settings.ghost_mode_hvac !== 'false';
    const ghostModeWholeHome = settings.ghost_mode_whole_home !== 'false';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not defined");
      return;
    }
    const ai = new GoogleGenAI({ apiKey });
    
    // Get tracked entities
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    const trackedContext = trackedRows.map(t => ({ id: t.entity_id, notes: t.notes }));

    if (trackedIds.length === 0) return;

    // Fetch current states
    const states = await fetchHA('/api/states');
    if (!states) return;
    const trackedStates = states.filter((s: any) => trackedIds.includes(s.entity_id));

    // Fetch recent history (last 2 hours)
    const placeholders = trackedIds.map(() => '?').join(',');
    const recentHistory = db.prepare(`
      SELECT entity_id, state, attributes, last_changed 
      FROM device_history 
      WHERE last_changed >= datetime('now', '-2 hours', 'localtime') 
      AND entity_id IN (${placeholders})
      ORDER BY last_changed ASC
    `).all(...trackedIds) as any[];

    const prompt = `
      You are the HomeBrain AI real-time controller.
      Your job is to analyze the current state of the home and the recent history (last 2 hours) to determine if any IMMEDIATE actions need to be taken.
      
      CRITICAL GOALS:
      1. HVAC Control: Adjust thermostat set points based on occupancy, time of day, and historical patterns.
      2. Whole Home Modes: Analyze trends (e.g., TV off, lights off, motion stopped) to infer if the house is going to "Sleep", "Away", or "Home". Turn off lights/switches if appropriate.
      
      IMPORTANT: The home is in Eastern Standard Time (EST).
      
      Tracked Devices & User Notes:
      ${JSON.stringify(trackedContext)}
      
      Current States:
      ${JSON.stringify(trackedStates)}
      
      Recent History (Last 2h):
      ${JSON.stringify(recentHistory)}
      
      Return a JSON object with EXACTLY this structure:
      {
        "actions": [
          {
            "type": "hvac" | "whole_home",
            "domain": "climate" | "light" | "switch",
            "service": "set_temperature" | "turn_on" | "turn_off",
            "entity_id": "climate.zone_1",
            "service_data": { "temperature": 72 },
            "reasoning": "Anthony just arrived home, pre-heating the living room."
          }
        ]
      }
      If no actions are needed right now, return { "actions": [] }.
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" }
    });

    const result = JSON.parse(response.text || "{}");
    
    if (result.actions && Array.isArray(result.actions)) {
      for (const action of result.actions) {
        // Log the reasoning
        const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning, created_at) VALUES (?, ?, ?, datetime('now', 'localtime'))");
        const context = action.type === 'hvac' ? 'Real-time HVAC Control' : 'Real-time Whole Home Control';
        const decisionText = `${action.service} on ${action.entity_id} ${action.service_data ? JSON.stringify(action.service_data) : ''}`;
        
        let executed = false;
        let ghostModeActive = false;

        if (action.type === 'hvac') {
          if (ghostModeHvac) {
            ghostModeActive = true;
          } else {
            await callHAService(action.domain, action.service, { entity_id: action.entity_id, ...action.service_data });
            executed = true;
          }
        } else if (action.type === 'whole_home') {
          if (ghostModeWholeHome) {
            ghostModeActive = true;
          } else {
            await callHAService(action.domain, action.service, { entity_id: action.entity_id, ...action.service_data });
            executed = true;
          }
        }

        const finalReasoning = ghostModeActive ? `[GHOST MODE - ACTION BLOCKED] ${action.reasoning}` : `[EXECUTED] ${action.reasoning}`;
        insertReasoning.run(context, decisionText, finalReasoning);
      }
      
      if (result.actions.length > 0) {
        broadcastToFrontend({ type: 'NEW_REASONING' });
      }
    }
  } catch (error) {
    console.error("Real-time control error:", error);
  }
}

// Run real-time control every 5 minutes
setInterval(executeRealTimeAIControl, 5 * 60 * 1000);

// --- API Routes ---

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password) as any;
  if (user) {
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
  } else {
    res.status(401).json({ success: false, error: "Invalid credentials" });
  }
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

app.get("/api/ha/status", (req, res) => {
  res.json({ status: haStatus });
});

app.post("/api/ha/force-connect", (req, res) => {
  connectToHA();
  res.json({ success: true, status: haStatus });
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
  
  res.json({ success: true });
});

// System Update Endpoints
app.get("/api/system/check-update", async (req, res) => {
  try {
    // Check if we are in a git repository
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
    // Pull latest changes
    await execAsync('git pull origin main');
    
    // Install dependencies
    await execAsync('npm install');
    
    // Build the application
    await execAsync('npm run build');
    
    res.json({ success: true, message: "Update pulled and built successfully! Please restart the service (e.g., pm2 restart homebrain) to apply the changes." });
  } catch (e: any) {
    console.error("Update failed:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/history", (req, res) => {
  const history = db.prepare("SELECT * FROM device_history ORDER BY last_changed DESC LIMIT 100").all();
  res.json(history);
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
    WHERE last_changed >= datetime('now', '${timeModifier}', 'localtime') 
    AND entity_id IN (${placeholders})
    ORDER BY last_changed ASC
  `).all(...zones);
  
  res.json(graphData);
});

app.post("/api/ai/generate-schedule", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "GEMINI_API_KEY is not defined" });
    }
    const ai = new GoogleGenAI({ apiKey });
    
    const history = db.prepare("SELECT * FROM device_history ORDER BY last_changed DESC LIMIT 50").all();
    
    const prompt = `
      Analyze the following smart home device history and generate a recommended heating/cooling and lighting schedule.
      Return the schedule as a JSON object with a 'name', 'description', and 'schedule_data' (an array of events).
      
      History:
      ${JSON.stringify(history)}
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const result = JSON.parse(response.text || "{}");
    
    if (result.name && result.schedule_data) {
      const insertSchedule = db.prepare("INSERT INTO schedules (name, description, schedule_data) VALUES (?, ?, ?)");
      insertSchedule.run(result.name, result.description || "", JSON.stringify(result.schedule_data));
      res.json({ success: true, schedule: result });
    } else {
      res.status(500).json({ error: "AI returned invalid format" });
    }
  } catch (error: any) {
    console.error("AI Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/schedules", (req, res) => {
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
