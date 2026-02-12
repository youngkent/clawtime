# ClawTime Installation Guide

First-time setup for ClawTime — webchat interface for OpenClaw with passkey auth, 3D avatars, and voice mode.

After installation, see **[SKILL.md](./SKILL.md)** for operational details (widgets, voice mode, task panel, avatar creation).

---

## 1. Clone & Install

```bash
cd ~/.openclaw/workspace
git clone https://github.com/youngkent/clawtime.git
cd clawtime
npm install
```

First run creates `~/.clawtime/` with default config.

## 2. Whisper STT Setup (Required for Voice Mode)

ClawTime uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for server-side speech-to-text.

**Check if already installed:**
```bash
which whisper-transcribe && echo "✅ Whisper ready" || echo "❌ Need to install"
```

**If not installed:**
```bash
# Clone and build whisper.cpp
cd /tmp
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
make

# Download a model (base.en is fast and good for English)
bash ./models/download-ggml-model.sh base.en

# Create wrapper script
sudo tee /usr/local/bin/whisper-transcribe << 'EOF'
#!/bin/bash
/tmp/whisper.cpp/main -m /tmp/whisper.cpp/models/ggml-base.en.bin -f "$1" --no-timestamps -otxt 2>/dev/null
cat "${1}.txt"
rm -f "${1}.txt"
EOF
sudo chmod +x /usr/local/bin/whisper-transcribe

# Test it works
echo "Test" | whisper-transcribe /dev/stdin 2>/dev/null && echo "✅ Working"
```

**For multi-language support**, use `base` model instead of `base.en`.

**Fallback:** If Whisper is unavailable, ClawTime falls back to browser-based SpeechRecognition API.

## 3. Ask User About Their Agent

Before configuring, ask the user:

> "What would you like your AI assistant to look like? Describe the avatar, personality, and any color preferences."

Based on their response:
- **Choose a name** — the agent's display name
- **Pick an emoji** — represents the agent (e.g., 🤖, 🦊, 🔥, 🦉)

Theme color is auto-generated from the avatar's `AVATAR_META`.

## 4. Configure (REQUIRED)

**⚠️ You MUST set the gateway token or ClawTime will fail with "device identity required" error.**

**Step 1:** Get the gateway token:
```bash
# Option A: Check existing config
grep -o '"token":"[^"]*"' ~/.openclaw/openclaw.json | head -1

# Option B: Generate new token if needed
openssl rand -hex 24
```

**Step 2:** Create `~/.clawtime/.env` with the token:
```bash
cat > ~/.clawtime/.env << 'EOF'
GATEWAY_TOKEN=<paste_token_here>
BOT_NAME=AgentName
BOT_EMOJI=🤖
EOF
```

**Step 3:** Verify before continuing:
```bash
grep GATEWAY_TOKEN ~/.clawtime/.env
```

## 5. Create Custom Avatar (Recommended)

Create a custom 3D avatar for the user's agent. See **[SKILL.md → Avatar Creation](./SKILL.md#avatar-creation)** for the full template and design tips.

Quick steps:
1. Create avatar file at `~/.clawtime/avatars/<name>.js`
2. Set as default in `~/.clawtime/config.json`: `{"selectedAvatar": "<name>"}`

## 6. Start Services

**⚠️ Complete steps 4-5 BEFORE starting services.**

```bash
# Create and start ClawTime server
cat > ~/.config/systemd/user/clawtime.service << 'EOF'
[Unit]
Description=ClawTime Server
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.openclaw/workspace/clawtime
EnvironmentFile=%h/.clawtime/.env
ExecStart=/usr/bin/node server.js
KillSignal=SIGTERM
TimeoutStopSec=120
Restart=always
EOF

systemctl --user daemon-reload
systemctl --user enable --now clawtime
```

## 7. Set Up Tunnel

```bash
chmod +x scripts/tunnel.sh
cp scripts/clawtime-tunnel.service ~/.config/systemd/user/
sed -i "s|%h|$HOME|g" ~/.config/systemd/user/clawtime-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now clawtime-tunnel

# Get your URL and setup token
journalctl --user -u clawtime-tunnel | grep "Setup URL"
```

⚠️ **Note:** Free Cloudflare tunnels assign random URLs that change on restart. For stable URLs, consider [ngrok Pro](https://ngrok.com) ($8/mo) or Cloudflare Tunnel with a custom domain.

## 8. Share Setup Link with User

> "Your ClawTime is ready! 🎉
>
> **Setup link:** `https://YOUR-URL.trycloudflare.com?setup=YOUR_TOKEN`
>
> **To save as an app on your phone:**
>
> **iPhone/iPad:**
> 1. Open the link in Safari
> 2. Tap Share → "Add to Home Screen"
>
> **Android:**
> 1. Open the link in Chrome
> 2. Tap menu → "Add to Home screen"

## 9. Install the Skill

So you don't forget ClawTime's features (widgets, voice mode, etc.), install the skill:

```bash
ln -s ~/.openclaw/workspace/clawtime ~/.openclaw/workspace/openclaw-fork/skills/clawtime
```

This adds ClawTime to your `<available_skills>`. Next session, you'll auto-discover the operational docs in **[SKILL.md](./SKILL.md)**.

---

## Voice Mode

- Tap avatar to start voice conversation
- **STT:** Server-side Whisper (falls back to browser if unavailable)
- **TTS:** edge-tts (no API key needed)
- **Barge-in:** Speak while bot is talking to interrupt

### Voice Mode Features

| Feature | Description |
|---------|-------------|
| Whisper STT | Server-side transcription, multi-language support |
| Barge-in | Speak to interrupt bot's TTS response |
| Noise filtering | VAD threshold 0.07 RMS |
| 2s silence | Waits 2 seconds after you stop speaking |
| Noise transcripts | Filters out `(sniffing)`, `[MUSIC]`, etc. |
| Visual states | 🎤 Recording → ⏳ Transcribing → Bot thinking → Bot speaking |

Configure voice in `~/.clawtime/.env`:
```
TTS_VOICE=en-US-AndrewNeural
```

---

## Troubleshooting

### "device identity required" error

**Cause:** Missing or invalid `GATEWAY_TOKEN`

```bash
TOKEN=$(grep -o '"token":"[^"]*"' ~/.openclaw/openclaw.json | cut -d'"' -f4 | head -1)
echo "GATEWAY_TOKEN=$TOKEN" >> ~/.clawtime/.env
systemctl --user restart clawtime
```

### Avatar not showing

**Cause:** Custom avatar not set as default

```bash
echo '{"selectedAvatar":"myavatar"}' > ~/.clawtime/config.json
systemctl --user restart clawtime
```

### Connection keeps dropping

**Cause:** Tunnel URL changed (free Cloudflare tier)

```bash
journalctl --user -u clawtime-tunnel | grep trycloudflare | tail -1
```

Re-register passkey at the new URL.

---

## Next Steps

Read **[SKILL.md](./SKILL.md)** to learn:
- Widget syntax (buttons, forms, datepicker, etc.)
- Task panel usage
- Avatar creation details
