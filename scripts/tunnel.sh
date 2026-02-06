#!/bin/bash
# ClawTime Cloudflare Tunnel Manager
# Starts tunnel, detects URL, updates config, notifies user on changes

set -e

CLAWTIME_DIR="${CLAWTIME_DIR:-$HOME/.clawtime}"
CLAWTIME_ENV="$CLAWTIME_DIR/.env"
LOG_FILE="/tmp/clawtime-tunnel.log"
URL_FILE="$CLAWTIME_DIR/.tunnel-url"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[tunnel]${NC} $1"; }
warn() { echo -e "${YELLOW}[tunnel]${NC} $1"; }
error() { echo -e "${RED}[tunnel]${NC} $1"; }

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    error "cloudflared not found. Installing..."
    if [[ "$(uname -m)" == "aarch64" ]]; then
        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /tmp/cloudflared
    else
        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
    fi
    chmod +x /tmp/cloudflared
    sudo mv /tmp/cloudflared /usr/local/bin/
    log "cloudflared installed"
fi

# Start cloudflared and capture URL
log "Starting Cloudflare tunnel..."
cloudflared tunnel --url http://localhost:3000 2>&1 | tee "$LOG_FILE" &
TUNNEL_PID=$!

# Wait for URL to appear in logs
for i in {1..30}; do
    if grep -q "trycloudflare.com" "$LOG_FILE" 2>/dev/null; then
        break
    fi
    sleep 1
done

# Extract URL
TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | head -1)

if [ -z "$TUNNEL_URL" ]; then
    error "Failed to get tunnel URL"
    cat "$LOG_FILE"
    exit 1
fi

DOMAIN=$(echo "$TUNNEL_URL" | sed 's|https://||')
log "Tunnel URL: $TUNNEL_URL"

# Check if URL changed
OLD_URL=""
if [ -f "$URL_FILE" ]; then
    OLD_URL=$(cat "$URL_FILE")
fi

if [ "$TUNNEL_URL" != "$OLD_URL" ]; then
    warn "URL changed! Updating config..."
    
    # Update ClawTime config
    sed -i "s|^RPID=.*|RPID=${DOMAIN}|" "$CLAWTIME_ENV"
    sed -i "s|^ORIGIN=.*|ORIGIN=${TUNNEL_URL}|" "$CLAWTIME_ENV"
    
    # Generate new setup token and clear passkeys
    NEW_TOKEN=$(openssl rand -hex 16)
    sed -i "s|^SETUP_TOKEN=.*|SETUP_TOKEN=${NEW_TOKEN}|" "$CLAWTIME_ENV"
    echo "[]" > "$CLAWTIME_DIR/credentials.json"
    
    # Save new URL
    echo "$TUNNEL_URL" > "$URL_FILE"
    
    # Restart ClawTime to pick up new config
    if systemctl --user is-active clawtime &>/dev/null; then
        systemctl --user restart clawtime
        log "ClawTime restarted"
    fi
    
    SETUP_URL="${TUNNEL_URL}?setup=${NEW_TOKEN}"
    
    # Try to notify via OpenClaw gateway (if available)
    if [ -f "$CLAWTIME_DIR/.notify-target" ]; then
        NOTIFY_TARGET=$(cat "$CLAWTIME_DIR/.notify-target")
        GATEWAY_TOKEN=$(grep "^GATEWAY_TOKEN=" "$CLAWTIME_ENV" 2>/dev/null | cut -d= -f2)
        
        if [ -n "$GATEWAY_TOKEN" ] && [ -n "$NOTIFY_TARGET" ]; then
            MESSAGE="🔗 ClawTime URL changed!

New URL: ${TUNNEL_URL}
Setup: ${SETUP_URL}

Register your passkey again to continue."
            
            curl -s -X POST "http://localhost:4380/api/message" \
                -H "Authorization: Bearer $GATEWAY_TOKEN" \
                -H "Content-Type: application/json" \
                -d "{\"channel\":\"telegram\",\"target\":\"${NOTIFY_TARGET}\",\"message\":\"$MESSAGE\"}" > /dev/null 2>&1 || true
            
            log "Notification sent"
        fi
    fi
    
    echo ""
    echo "============================================"
    echo "  ClawTime Setup URL (URL changed!)"
    echo "============================================"
    echo "$SETUP_URL"
    echo "============================================"
    echo ""
else
    log "URL unchanged: $TUNNEL_URL"
fi

# Keep tunnel running
wait $TUNNEL_PID
