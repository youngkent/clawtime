#!/bin/bash
# ClawTime Setup Script
# Usage: ./scripts/setup.sh

set -e

echo "🦞 ClawTime Setup"
echo "=================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DATA_DIR="$HOME/.clawtime"
CLAWTIME_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Step 1: Create data directory and copy default avatars
mkdir -p "$DATA_DIR/avatars"
cp -n "$CLAWTIME_DIR/public/avatars/"*.js "$DATA_DIR/avatars/" 2>/dev/null || true
echo -e "${GREEN}Copied default avatars to $DATA_DIR/avatars/${NC}"

# Step 2: Get gateway token
echo -e "\n${YELLOW}Step 1: Gateway Token${NC}"
EXISTING_TOKEN=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' ~/.openclaw/openclaw.json 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"' | head -1 || true)

if [ -n "$EXISTING_TOKEN" ]; then
    echo -e "Found existing token: ${GREEN}${EXISTING_TOKEN:0:8}...${NC}"
    GW_TOKEN="$EXISTING_TOKEN"
else
    GW_TOKEN=$(openssl rand -hex 24)
    echo -e "Generated new token: ${GREEN}${GW_TOKEN:0:8}...${NC}"
    echo -e "${YELLOW}Add this token to ~/.openclaw/openclaw.json under gateway.auth.token${NC}"
fi

# Step 3: Get bot info and avatar
echo -e "\n${YELLOW}Step 2: Bot Configuration${NC}"

# List available avatars
AVATAR_DIR="$CLAWTIME_DIR/public/avatars"
echo -e "Available avatars:"
for avatar_file in "$AVATAR_DIR"/*.js; do
    avatar_name=$(basename "$avatar_file" .js)
    # Extract emoji from AVATAR_META
    avatar_emoji=$(grep -o '"emoji"[[:space:]]*:[[:space:]]*"[^"]*"' "$avatar_file" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"' || echo "")
    avatar_desc=$(grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' "$avatar_file" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"' || echo "")
    echo -e "  ${GREEN}$avatar_name${NC} $avatar_emoji - $avatar_desc"
done

read -p "Choose avatar [lobster]: " AVATAR_NAME
AVATAR_NAME="${AVATAR_NAME:-lobster}"

# Validate avatar exists
if [ ! -f "$AVATAR_DIR/$AVATAR_NAME.js" ]; then
    echo -e "${RED}Avatar '$AVATAR_NAME' not found, using 'lobster'${NC}"
    AVATAR_NAME="lobster"
fi

# Get default bot name and emoji from avatar metadata
DEFAULT_NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$AVATAR_DIR/$AVATAR_NAME.js" 2>/dev/null | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "ClawTime")
DEFAULT_EMOJI=$(grep -o '"emoji"[[:space:]]*:[[:space:]]*"[^"]*"' "$AVATAR_DIR/$AVATAR_NAME.js" 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"' || echo "🦞")

read -p "Bot name [$DEFAULT_NAME]: " BOT_NAME
BOT_NAME="${BOT_NAME:-$DEFAULT_NAME}"

read -p "Bot emoji [$DEFAULT_EMOJI]: " BOT_EMOJI
BOT_EMOJI="${BOT_EMOJI:-$DEFAULT_EMOJI}"

# Step 4: Tunnel URL (optional for now)
echo -e "\n${YELLOW}Step 3: Tunnel URL${NC}"
echo "If using ngrok/cloudflare tunnel, enter the URL (or leave empty to set later):"
read -p "Tunnel URL: " PUBLIC_URL

# Step 5: Generate setup token
SETUP_TOKEN=$(openssl rand -hex 16)

# Step 6: Write .env
cat > "$DATA_DIR/.env" << EOF
GATEWAY_TOKEN=$GW_TOKEN
BOT_NAME=$BOT_NAME
BOT_EMOJI=$BOT_EMOJI
PUBLIC_URL=$PUBLIC_URL
SETUP_TOKEN=$SETUP_TOKEN
EOF

echo -e "\n${GREEN}Created $DATA_DIR/.env${NC}"

# Write avatar selection to config.json
cat > "$DATA_DIR/config.json" << EOF
{
  "selectedAvatar": "$AVATAR_NAME"
}
EOF
echo -e "${GREEN}Set avatar to $AVATAR_NAME${NC}"

# Step 7: Create systemd service
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/clawtime.service << EOF
[Unit]
Description=ClawTime Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$CLAWTIME_DIR
EnvironmentFile=$DATA_DIR/.env
ExecStart=/usr/bin/node server.js
KillSignal=SIGTERM
TimeoutStopSec=120
Restart=always
EOF

systemctl --user daemon-reload
systemctl --user enable clawtime

echo -e "${GREEN}Created systemd service${NC}"

# Step 8: Configure gateway allowedOrigins if PUBLIC_URL is set
if [ -n "$PUBLIC_URL" ]; then
    echo -e "\n${YELLOW}Configuring gateway...${NC}"
    CONFIG_FILE="$HOME/.openclaw/openclaw.json"
    if [ -f "$CONFIG_FILE" ] && command -v python3 &> /dev/null; then
        python3 << PYEOF
import json
with open('$CONFIG_FILE', 'r') as f:
    config = json.load(f)
if 'gateway' not in config:
    config['gateway'] = {}
if 'controlUi' not in config['gateway']:
    config['gateway']['controlUi'] = {}
origins = config['gateway']['controlUi'].get('allowedOrigins', [])
if '$PUBLIC_URL' not in origins:
    origins.append('$PUBLIC_URL')
config['gateway']['controlUi']['allowedOrigins'] = origins
with open('$CONFIG_FILE', 'w') as f:
    json.dump(config, f, indent=2)
PYEOF
        echo -e "${GREEN}Added $PUBLIC_URL to gateway allowedOrigins${NC}"
        # Restart gateway to apply config
        if systemctl --user is-active --quiet openclaw-gateway 2>/dev/null; then
            systemctl --user restart openclaw-gateway
            echo -e "${GREEN}Restarted openclaw-gateway${NC}"
        fi
    else
        echo -e "${YELLOW}Add to ~/.openclaw/openclaw.json → gateway.controlUi.allowedOrigins: [\"$PUBLIC_URL\"]${NC}"
    fi
fi

# Step 9: Start service
echo -e "\n${YELLOW}Starting ClawTime...${NC}"
systemctl --user start clawtime
sleep 2

if systemctl --user is-active --quiet clawtime; then
    echo -e "${GREEN}✅ ClawTime is running${NC}"
else
    echo -e "${RED}❌ Failed to start. Check: journalctl --user -u clawtime${NC}"
    exit 1
fi

# Done
echo -e "\n${GREEN}=================="
echo -e "Setup Complete!"
echo -e "==================${NC}"

if [ -n "$PUBLIC_URL" ]; then
    echo -e "\nSetup URL: ${PUBLIC_URL}?setup=${SETUP_TOKEN}"
else
    echo -e "\nSetup token: $SETUP_TOKEN"
    echo -e "${YELLOW}Set PUBLIC_URL in $DATA_DIR/.env and restart to get full URL${NC}"
fi

echo -e "\nNext steps:"
echo "  1. Open the setup URL on your phone"
echo "  2. Register your passkey (Face ID / fingerprint)"
echo "  3. Add to home screen for app-like experience"
echo ""
echo "Docs: SKILL.md"
