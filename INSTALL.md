# ClawTime Installation

Webchat interface for OpenClaw with passkey auth, 3D avatars, and voice mode.

## Prerequisites

- OpenClaw gateway running with a configured token
- Node.js 18+

## Install

Before running the install commands, **ask the user what kind of avatar they want** (animal, character, style, colors). Then create a custom avatar in `~/.clawtime/avatars/` following the template in SKILL.md.

```bash
# 1. Clone and install
cd ~/.openclaw/workspace
git clone https://github.com/youngkent/clawtime.git
cd clawtime
npm install

# 2. Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/') -o /tmp/cloudflared
chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/

# 3. Create tunnel service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/clawtime-tunnel.service << 'EOF'
[Unit]
Description=ClawTime Cloudflare Tunnel
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3000
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now clawtime-tunnel

# 4. Get tunnel URL (wait a few seconds for it to appear)
sleep 5
journalctl --user -u clawtime-tunnel | grep -o 'https://[^ ]*trycloudflare.com' | tail -1

# 5. Run setup — paste the tunnel URL when prompted
./scripts/setup.sh

# 6. Open the setup URL shown at end of setup.sh on your phone
#    Register passkey with Face ID / fingerprint
#    Add to home screen for app-like experience
```

⚠️ Quick tunnel URLs change on restart. For a stable URL, use a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps) or ngrok reserved domain.

## Text-to-Speech (TTS)

ClawTime supports any TTS tool via the `TTS_COMMAND` env var. The command uses `{{TEXT}}` and `{{OUTPUT}}` placeholders.

**edge-tts (recommended, free neural voices):**

```bash
pip install edge-tts
echo 'TTS_COMMAND=edge-tts --text "{{TEXT}}" --write-media "{{OUTPUT}}" --voice en-US-AriaNeural' >> ~/.clawtime/.env
```

**piper (local, fast):**

```bash
echo 'TTS_COMMAND=echo "{{TEXT}}" | piper --model en_US-lessac-medium --output_file "{{OUTPUT}}"' >> ~/.clawtime/.env
```

**macOS say:**

```bash
echo 'TTS_COMMAND=say -o "{{OUTPUT}}.aiff" "{{TEXT}}" && ffmpeg -i "{{OUTPUT}}.aiff" -y "{{OUTPUT}}" && rm "{{OUTPUT}}.aiff"' >> ~/.clawtime/.env
```

After configuring, restart ClawTime: `systemctl --user restart clawtime`

---

See **[SKILL.md](./SKILL.md)** for widgets, avatars, and operational details.
