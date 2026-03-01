#!/bin/bash

# AI Smart Home Dashboard - Linux Installation Script
# This script configures the app to run at boot via systemd and serves it on port 80 via Nginx.

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (e.g., sudo ./install-service.sh)"
  exit 1
fi

APP_USER=${SUDO_USER:-$(whoami)}
APP_DIR=$(pwd)

echo "====================================================="
echo " Installing AI Smart Home Dashboard"
echo " User: $APP_USER"
echo " Directory: $APP_DIR"
echo "====================================================="

# 1. Install dependencies and build
echo "-> Installing dependencies and building the application..."
sudo -u $APP_USER npm install
sudo -u $APP_USER npm run build

# 2. Configure systemd service
SERVICE_FILE="/etc/systemd/system/ai-smarthome.service"
echo "-> Creating systemd service at $SERVICE_FILE..."

cat <<EOF > $SERVICE_FILE
[Unit]
Description=AI Smart Home Dashboard
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/npm run start
Restart=on-failure
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

echo "-> Enabling and starting systemd service..."
systemctl daemon-reload
systemctl enable ai-smarthome
systemctl start ai-smarthome

# 3. Configure Nginx
if command -v nginx > /dev/null; then
    echo "-> Configuring Nginx for port 80..."
    NGINX_CONF="/etc/nginx/sites-available/ai-smarthome"
    
    cat <<EOF > $NGINX_CONF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

    ln -sf $NGINX_CONF /etc/nginx/sites-enabled/
    
    # Remove default nginx site if it exists to avoid port 80 conflicts
    if [ -f /etc/nginx/sites-enabled/default ]; then
        echo "-> Removing default Nginx site to avoid port 80 conflicts..."
        rm /etc/nginx/sites-enabled/default
    fi

    echo "-> Testing and restarting Nginx..."
    nginx -t && systemctl restart nginx
    echo "-> Nginx configured successfully."
else
    echo "-> WARNING: Nginx is not installed. Skipping Nginx configuration."
    echo "   If you want to use port 80, please install nginx (sudo apt install nginx) and run this script again."
fi

echo "====================================================="
echo " Installation Complete!"
echo " The application should now be running on port 80 (if Nginx is installed) or port 3000."
echo "====================================================="
