---
name: clawtime
description: Set up and operate ClawTime — webchat interface for OpenClaw with passkey auth, 3D avatars, and voice mode.
---

# ClawTime Skill

## Setup Guide

### 1. Install

```bash
cd ~/.openclaw/workspace
git clone https://github.com/youngkent/clawtime.git
cd clawtime
npm install
```

First run creates `~/.clawtime/` with default config.

### 1b. Whisper STT Setup (Required for Voice Mode)

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

**For multi-language support**, use `base` model instead of `base.en`:
```bash
bash ./models/download-ggml-model.sh base
# Update the wrapper script to use ggml-base.bin
```

**Custom binary path:** Set `WHISPER_BIN` in `~/.clawtime/.env` if installed elsewhere.

**Fallback:** If Whisper is not available or fails, ClawTime falls back to browser-based SpeechRecognition API (less accurate, English only on most browsers).

### 2. Ask User About Their Agent

Before configuring, ask the user:

> "What would you like your AI assistant to look like? Describe the avatar, personality, and any color preferences."

Based on their response:
- **Choose a name** — the agent's display name
- **Pick an emoji** — represents the agent (e.g., 🤖, 🦊, 🔥, 🦉)

**Note:** Theme color is auto-generated from the avatar. When you create a custom avatar, set the `color` in the AVATAR_META and it will automatically apply to the entire UI.

### 3. Configure (REQUIRED)

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
# Must show a valid token (not empty, not "your_openclaw_gateway_token")
grep GATEWAY_TOKEN ~/.clawtime/.env
```

If the token is missing or invalid, ClawTime cannot connect to the OpenClaw gateway.

### 4. Create Custom 3D Avatar (Recommended)

ClawTime uses **Three.js voxel avatars** — 3D characters built from simple shapes that animate based on state (idle, thinking, talking, etc.). Study `public/avatars/lobster.js` as the reference implementation.

**Step 1:** Create the avatar file at `~/.clawtime/avatars/<name>.js`:

```javascript
/* AVATAR_META {"name":"MyAgent","emoji":"🤖","description":"Custom 3D avatar","color":"4f46e5"} */
(function() {
  'use strict';
  
  var scene, camera, renderer, character;
  var head, leftEye, rightEye, mouth;
  var clock = new THREE.Clock();
  var currentState = 'idle';
  var isInitialized = false;

  // ─── Required: Initialize the 3D scene ───
  window.initAvatarScene = function() {
    if (isInitialized) return;
    
    var container = document.getElementById('avatarCanvas');
    if (!container) return;
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1318);
    
    var w = container.clientWidth, h = container.clientHeight;
    camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    
    // Lighting
    scene.add(new THREE.AmbientLight(0x606080, 1.5));
    var light = new THREE.DirectionalLight(0xffffff, 2.0);
    light.position.set(4, 10, 6);
    scene.add(light);
    
    // Build your character here
    character = new THREE.Group();
    buildCharacter();
    scene.add(character);
    
    isInitialized = true;
    animate();
  };
  
  function buildCharacter() {
    // Body (main color from AVATAR_META)
    var bodyMat = new THREE.MeshLambertMaterial({ color: 0x4f46e5 });
    var body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2, 1), bodyMat);
    body.position.y = 0;
    character.add(body);
    
    // Head
    var headMat = new THREE.MeshLambertMaterial({ color: 0x4f46e5 });
    head = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1), headMat);
    head.position.y = 1.8;
    character.add(head);
    
    // Eyes (white with black pupils)
    var eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    var pupilMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    
    leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.15), eyeMat);
    leftEye.position.set(-0.25, 1.9, 0.5);
    character.add(leftEye);
    
    rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.15), eyeMat);
    rightEye.position.set(0.25, 1.9, 0.5);
    character.add(rightEye);
    
    // Mouth
    mouth = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.1), pupilMat);
    mouth.position.set(0, 1.5, 0.5);
    character.add(mouth);
  }
  
  function animate() {
    requestAnimationFrame(animate);
    var t = clock.getElapsedTime();
    
    // Idle breathing animation
    if (character) {
      character.position.y = Math.sin(t * 2) * 0.05;
    }
    
    // State-specific animations
    if (currentState === 'thinking') {
      head.rotation.z = Math.sin(t * 3) * 0.1;
    } else if (currentState === 'talking') {
      mouth.scale.y = 1 + Math.sin(t * 15) * 0.5;
    } else {
      head.rotation.z = 0;
      mouth.scale.y = 1;
    }
    
    renderer.render(scene, camera);
  }
  
  // ─── Required: Handle state changes ───
  window.setAvatarState = function(state) {
    currentState = state;
    // Add visual feedback per state (colors, animations, etc.)
  };
  
  // ─── Required: Handle connection state ───
  window.setConnectionState = function(state) {
    // state: 'online', 'connecting', 'offline'
    // Update visual indicator (glow, color, etc.)
  };
  
  // ─── Required: Handle resize ───
  window.adjustAvatarCamera = function() {
    if (!renderer) return;
    var container = document.getElementById('avatarCanvas');
    var w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
})();
```

**Step 2:** Set as default avatar — create/update `~/.clawtime/config.json`:

```json
{
  "selectedAvatar": "<name>"
}
```

Where `<name>` matches the filename without `.js` (e.g., `"selectedAvatar": "myagent"` for `myagent.js`).

**Avatar design tips:**
- Study `public/avatars/lobster.js` for a full-featured example with all states
- Use voxel style (boxes, spheres) — matches ClawTime aesthetic
- Implement all states: `idle`, `thinking`, `working`, `talking`, `listening`, `happy`, `error`, `sleeping`
- Add connection status indicator (ring/glow that changes color)
- Test on both desktop and mobile layouts
- Keep polygon count reasonable for mobile performance

### 5. Start Services

**⚠️ Complete steps 3-4 BEFORE starting services. The server reads `.env` only at startup.**

```bash
# Verify config is ready
cat ~/.clawtime/.env  # Must show GATEWAY_TOKEN, BOT_NAME
cat ~/.clawtime/config.json  # Must show selectedAvatar (if custom avatar created)

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

# If you change .env later, restart to apply:
# systemctl --user restart clawtime
```

### 6. Set Up Tunnel

```bash
chmod +x scripts/tunnel.sh
cp scripts/clawtime-tunnel.service ~/.config/systemd/user/
sed -i "s|%h|$HOME|g" ~/.config/systemd/user/clawtime-tunnel.service
systemctl --user daemon-reload
systemctl --user enable --now clawtime-tunnel

# Get your URL and setup token
journalctl --user -u clawtime-tunnel | grep "Setup URL"
```

⚠️ **Note:** Free Cloudflare tunnels assign random URLs that change on restart. Passkeys must be re-registered when this happens.

**Tell the user:** "The free tunnel gives you a random URL that changes when the server restarts. If you'd like a permanent URL (no re-setup needed), paid options like [ngrok Pro](https://ngrok.com) ($8/mo) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) with a custom domain offer stable URLs."

### 7. Share Setup Link with User

Once setup is complete, send the user the one-time setup link:

> "Your ClawTime is ready! 🎉
>
> **Setup link:** `https://YOUR-URL.trycloudflare.com?setup=YOUR_TOKEN`
>
> **To save as an app on your phone:**
>
> **iPhone/iPad:**
> 1. Open the link in Safari
> 2. Tap the Share button (square with arrow)
> 3. Scroll down and tap "Add to Home Screen"
> 4. Tap "Add"
>
> **Android:**
> 1. Open the link in Chrome
> 2. Tap the three-dot menu
> 3. Tap "Add to Home screen"
> 4. Tap "Add"
>
> After registering your passkey, you can access ClawTime anytime from your home screen — just like a regular app!"

## Operations

```bash
# Status & logs
systemctl --user status clawtime
journalctl --user -u clawtime -f

# Restart after config changes  
systemctl --user restart clawtime

# Get current tunnel URL
journalctl --user -u clawtime-tunnel | grep trycloudflare | tail -1
```

## Voice Mode

- Tap avatar to start voice conversation
- **STT:** Server-side Whisper by default (more accurate, supports multiple languages)
- **TTS:** edge-tts (no API key needed)
- **Barge-in:** Speak while bot is talking to interrupt
- **Visual feedback:** Shows "🎤 Recording..." → "⏳ Transcribing..." in chat
- **Silence detection:** Waits 2 seconds of silence before sending audio
- Configure voice: `TTS_VOICE=en-US-AndrewNeural` in `~/.clawtime/.env`

### Voice Mode Features
| Feature | Description |
|---------|-------------|
| Whisper STT | Server-side transcription (default). Falls back to browser if unavailable. |
| Barge-in | Speak to interrupt bot's TTS response |
| Noise filtering | VAD threshold 0.07 RMS — balances responsiveness and noise rejection |
| 2s silence | Waits 2 seconds after you stop speaking before sending |
| Noise transcripts | Filters out `(sniffing)`, `[MUSIC]`, etc. from Whisper output |
| Visual states | 🎤 Recording → ⏳ Transcribing → Bot thinking → Bot speaking |
| Auto-resync | Voice mode state re-syncs after WebSocket reconnection |

## Key Files

| Path | Purpose |
|------|---------|
| `~/.clawtime/.env` | Secrets & config |
| `~/.clawtime/config.json` | Avatar selection, preferences |
| `~/.clawtime/credentials.json` | Passkey data |
| `~/.clawtime/avatars/` | Custom avatars |

## Troubleshooting

### "device identity required" error
**Cause:** Missing or invalid `GATEWAY_TOKEN` in `~/.clawtime/.env`

**Fix:**
```bash
# 1. Get token from OpenClaw config
TOKEN=$(grep -o '"token":"[^"]*"' ~/.openclaw/openclaw.json | cut -d'"' -f4 | head -1)

# 2. Set it in ClawTime config
echo "GATEWAY_TOKEN=$TOKEN" >> ~/.clawtime/.env

# 3. Restart
systemctl --user restart clawtime
```

### Avatar not showing / wrong avatar
**Cause:** Custom avatar created but not set as default

**Fix:**
```bash
# Set your avatar as default (replace "myavatar" with your filename without .js)
echo '{"selectedAvatar":"myavatar"}' > ~/.clawtime/config.json
systemctl --user restart clawtime
```

### Connection keeps dropping
**Cause:** Tunnel URL changed (free Cloudflare tier)

**Fix:** Check new URL and re-register passkey:
```bash
journalctl --user -u clawtime-tunnel | grep trycloudflare | tail -1
```
