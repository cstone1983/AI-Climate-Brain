# HomeBrain AI

A full-stack, AI-powered smart home dashboard built with React, Vite, Express, and Tailwind CSS. It integrates with Home Assistant, Claude, and Telegram for intelligent smart home management and notifications, with HVAC autopilot (predictive, occupancy-aware climate scheduling) as its flagship feature.

## Features
- **Home Assistant Integration:** View entities, track occupancy, and sync automations/scripts for AI context.
- **AI Automation Engine:** Uses Claude to analyze home state and history, then generates rolling multi-day HVAC/whole-home schedules and real-time control decisions.
- **Telegram Notifications:** Get real-time alerts and summaries sent directly to your phone.
- **Settings Dashboard:** Configure API keys, URLs, and tokens directly from the UI.

## Prerequisites for Linux/Raspberry Pi Deployment

To run this on a dedicated Linux machine (like a Raspberry Pi or VPS), you will need:
- **Node.js** (v18 or higher)
- **npm** (Node Package Manager)
- **Nginx** (for serving on port 80)

You can install these on a Debian/Ubuntu-based system using:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
```

## Installation & Setup (Linux / Raspberry Pi)

We have included an automated installation script that will:
1. Install all Node.js dependencies.
2. Build the production version of the app.
3. Create a `systemd` service so the app runs automatically on boot.
4. Configure `nginx` to serve the app on port 80 (standard HTTP).

### Step 1: Clone or copy the files to your server
Place the project files in a directory of your choice (e.g., `/home/pi/ai-smarthome`).

### Step 2: Make the script executable
Navigate to the project directory and make the installation script executable:
```bash
cd /path/to/ai-smarthome
chmod +x install-service.sh
```

### Step 3: Run the installation script
Run the script with `sudo` privileges:
```bash
sudo ./install-service.sh
```

### Step 4: Access the Dashboard
Once the script completes, you can access the dashboard by navigating to your server's IP address in a web browser:
```
http://<your-server-ip>
```

Go to the **Settings** tab in the dashboard to configure your Home Assistant URL, Claude API Key, and Telegram Bot details.

## Manual Development Setup

If you want to run the app locally for development:

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. The app will be available at `http://localhost:3000`.

## Future Ideas / Roadmap

Not started - notes for later, roughly in order of what's been discussed:

- **Local LLM option for routine checks.** Run the daily analysis and/or
  real-time control loop against a local model (e.g. via Ollama/LM Studio)
  running on a home machine instead of the Claude API, to cut or eliminate
  API costs for the more frequent checks. Would need a pluggable AI-provider
  layer alongside the existing `callClaudeJson` helper in `server.ts`.
- **Additional context sources beyond Home Assistant.** e.g. syncing a kids'
  school calendar so the AI can factor in known schedule exceptions
  (early dismissal, school holidays) instead of only inferring patterns
  from device/presence history. Would likely plug into the same
  `user_ai_context` mechanism already used for manual AI notes, or a
  dedicated sync job similar to the existing automation/script sync.
- **Season-over-season comparison.** `device_history`/`logbook_history`
  already retain data indefinitely (no pruning), so the raw data for this
  already exists - the AI just doesn't use it yet. The daily/real-time
  prompts only ever pull a rolling recent window (`ai_lookback_days`).
  Would need a deliberate "same time last year" query added to the daily
  analysis prompt.

## Troubleshooting

- **Check App Logs:** If the app isn't starting, you can view the background service logs using:
  ```bash
  sudo journalctl -u ai-smarthome -f
  ```
- **Restart the App:** If you make manual changes to the code or environment variables, restart the service:
  ```bash
  sudo systemctl restart ai-smarthome
  ```
- **Nginx Issues:** If you can't access the app on port 80, check Nginx status:
  ```bash
  sudo systemctl status nginx
  ```
