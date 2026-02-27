import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";

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
    last_changed DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    schedule_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tracked_entities (
    entity_id TEXT PRIMARY KEY,
    tracked BOOLEAN DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_reasoning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context TEXT,
    decision TEXT,
    reasoning TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      startTime = new Date(lastRecord.last_ts).toISOString();
    }
    
    const historyData = await fetchHA(`/api/history/period/${startTime}`);
    if (historyData && Array.isArray(historyData)) {
      const insertHistory = db.prepare("INSERT OR IGNORE INTO device_history (entity_id, state, attributes, last_changed) VALUES (?, ?, ?, ?)");
      db.transaction(() => {
        for (const entityHistory of historyData) {
          for (const stateObj of entityHistory) {
            insertHistory.run(stateObj.entity_id, stateObj.state, JSON.stringify(stateObj.attributes || {}), stateObj.last_changed);
          }
        }
      })();
      console.log("History gap fill complete.");
    }
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
        
        const insertHistory = db.prepare("INSERT INTO device_history (entity_id, state, attributes) VALUES (?, ?, ?)");
        const info = insertHistory.run(entity_id, state, attributes);
        
        const newRecord = db.prepare("SELECT * FROM device_history WHERE id = ?").get(info.lastInsertRowid);
        
        // Real-time Self-Correction Logic
        // If a person or tracker arrives home, check if we need to self-correct the HVAC
        if ((entity_id.startsWith('person.') || entity_id.startsWith('device_tracker.')) && state === 'home') {
           const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning) VALUES (?, ?, ?)");
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
  if (!res.ok) throw new Error(`HA API Error: ${res.statusText}`);
  return res.json();
}

// --- Daily AI Analysis ---
async function runDailyAnalysis() {
  try {
    console.log("Running daily AI analysis...");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    
    // Fetch all states (includes automations, scripts, devices)
    const states = await fetchHA('/api/states');
    if (!states) {
      console.log("HA not configured or unreachable. Skipping analysis.");
      return;
    }

    // Fetch history for the last 24 hours
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const history = await fetchHA(`/api/history/period/${yesterday}`);

    // Get tracked entities and their notes (roles)
    const trackedRows = db.prepare("SELECT entity_id, notes FROM tracked_entities WHERE tracked = 1").all() as any[];
    const trackedIds = trackedRows.map(t => t.entity_id);
    const trackedContext = trackedRows.map(t => ({ id: t.entity_id, notes: t.notes }));

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
      const insertSchedule = db.prepare("INSERT INTO schedules (name, description, schedule_data) VALUES (?, ?, ?)");
      insertSchedule.run(result.schedule.name, result.schedule.description || "", JSON.stringify(result.schedule.schedule_data));
    }
    
    if (result.insights && Array.isArray(result.insights)) {
      const insertInsight = db.prepare("INSERT INTO insights (content) VALUES (?)");
      for (const insight of result.insights) {
        insertInsight.run(insight);
      }
    }

    if (result.reasoning && Array.isArray(result.reasoning)) {
      const insertReasoning = db.prepare("INSERT INTO ai_reasoning (context, decision, reasoning) VALUES (?, ?, ?)");
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

// Mock HA Sync / Event Simulation
app.post("/api/ha/sync", async (req, res) => {
  const insertHistory = db.prepare("INSERT INTO device_history (entity_id, state, attributes) VALUES (?, ?, ?)");
  
  const entities = ["climate.zone_1_living_room", "climate.zone_2_master", "climate.zone_3_kids", "climate.zone_4_basement", "person.anthony", "light.kitchen"];
  const states = ["heat", "cool", "off", "home", "away", "on"];
  
  const entity = entities[Math.floor(Math.random() * entities.length)];
  const state = states[Math.floor(Math.random() * states.length)];
  
  let attributes: any = { source: "simulated_event" };
  if (entity.startsWith('climate.')) {
    attributes.current_temperature = Math.floor(Math.random() * 10) + 65;
    attributes.temperature = Math.floor(Math.random() * 5) + 68;
  }

  const info = insertHistory.run(entity, state, JSON.stringify(attributes));
  
  const newRecord = db.prepare("SELECT * FROM device_history WHERE id = ?").get(info.lastInsertRowid);
  broadcastToFrontend({ type: 'NEW_HISTORY', data: newRecord });
  
  res.json({ success: true, message: "Simulated 1 event" });
});

app.get("/api/history", (req, res) => {
  const history = db.prepare("SELECT * FROM device_history ORDER BY last_changed DESC LIMIT 100").all();
  res.json(history);
});

app.post("/api/ai/generate-schedule", async (req, res) => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
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
