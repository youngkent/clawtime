# ClawTime Installation

Webchat interface for OpenClaw with passkey auth, 3D avatars, and voice mode.

## Quick Start

```bash
cd ~/.openclaw/workspace
git clone https://github.com/youngkent/clawtime.git
cd clawtime
npm install
./scripts/setup.sh
```

The setup script prompts for bot name/emoji, configures gateway token, and starts ClawTime.

### Local secrets policy

- Keep secrets in local env files only: `~/.clawtime/.env` or `./.env`
- Never commit credentials to git
- `.env*` is gitignored (except `.env.example`)

## Remote Access

ClawTime requires a stable HTTPS URL for WebAuthn passkeys.

**Cloudflare Tunnel (recommended, free):**
```bash
# Quick tunnel (URL changes on restart)
cloudflared tunnel --url http://localhost:3000

# Named tunnel (stable URL, requires setup)
cloudflared tunnel create clawtime
cloudflared tunnel route dns clawtime your-subdomain.yourdomain.com
cloudflared tunnel run clawtime
```

**ngrok (alternative):**
```bash
ngrok http 3000 --domain=your-subdomain.ngrok-free.dev
```

After setting up tunnel:
```bash
# Update ClawTime config
sed -i 's|^PUBLIC_URL=.*|PUBLIC_URL=https://YOUR-TUNNEL-URL|' ~/.clawtime/.env

# Add tunnel URL to gateway allowed origins
openclaw config set gateway.controlUi.allowedOrigins '["https://YOUR-TUNNEL-URL"]'

# Restart services
systemctl --user restart clawtime openclaw-gateway
```

## Voice Mode

**Browser STT (default)** — real-time transcription preview, no setup required.
- Works on Chrome, Edge (limited iOS Safari support)
- Config: `var callUseWhisper = false;` in `app.js`

**Server-side Whisper (optional)** — better accuracy, works on all browsers.
```bash
# Install whisper.cpp
cd /tmp && git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp && make
bash ./models/download-ggml-model.sh base.en

# Create transcribe script
sudo tee /usr/local/bin/whisper-transcribe << 'EOF'
#!/bin/bash
/tmp/whisper.cpp/main -m /tmp/whisper.cpp/models/ggml-base.en.bin -f "$1" --no-timestamps -otxt 2>/dev/null
cat "${1}.txt" && rm -f "${1}.txt"
EOF
sudo chmod +x /usr/local/bin/whisper-transcribe
```
Enable with: `var callUseWhisper = true;` in `app.js`

## Troubleshooting

**Connection refused:** Check gateway token matches in `~/.clawtime/.env` and gateway config.

**Origin rejected:** Add your tunnel URL to `gateway.controlUi.allowedOrigins`.

**WebSocket scope error:** Ensure ClawTime sends `role: 'operator'` and `scopes: ['operator.write', 'operator.read']` in connection params (see `src/websocket.js`).

---

See **[SKILL.md](./SKILL.md)** for widgets, avatars, and operational details.
