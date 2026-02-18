// ═══════════════════════════════════════════════════════════════════════════════
// § 2. CONFIGURATION (all from environment variables)
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = process.env.CLAWTIME_DATA_DIR || path.join(os.homedir(), '.clawtime');

const PORT = parseInt(process.env.PORT || '3000', 10);
const GW_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const GW_TOKEN = process.env.GATEWAY_TOKEN || '';
const SESSION_KEY = process.env.SESSION_KEY || 'agent:main:main';
const BOT_NAME = process.env.BOT_NAME || 'ClawTime';
const BOT_EMOJI = process.env.BOT_EMOJI || '🦞';
const BOT_TAGLINE = process.env.BOT_TAGLINE || 'Your AI assistant. Type a message to start chatting.';
const ENABLE_AVATAR = (process.env.ENABLE_AVATAR || 'true').toLowerCase() === 'true';
const ENABLE_INJECT = (process.env.ENABLE_INJECT || 'true').toLowerCase() === 'true';
const THEME_ACCENT = process.env.THEME_ACCENT || 'f97316';
const SESSION_TTL = parseInt(process.env.SESSION_TTL_HOURS || '24', 10) * 60 * 60 * 1000;
const ENABLE_STT = (process.env.ENABLE_STT || 'false').toLowerCase() === 'true';
const ENABLE_TASKS = (process.env.ENABLE_TASKS || 'true').toLowerCase() === 'true';
const TASKS_FILE = process.env.TASKS_FILE || path.join(DATA_DIR, 'tasks.json');
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // Tunnel URL for gateway Origin header
const ENABLE_VOICE = (process.env.ENABLE_VOICE || 'true').toLowerCase() === 'true';
const WHISPER_BIN = process.env.WHISPER_BIN || '/usr/local/bin/whisper-transcribe';

const RP_NAME = BOT_NAME;
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');

// Ensure data directory exists with full structure
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'avatars'), { recursive: true });

// Initialize default .env if it doesn't exist
const envPath = path.join(DATA_DIR, '.env');
if (!fs.existsSync(envPath)) {
  const crypto = await import('crypto');
  const defaultToken = crypto.randomBytes(16).toString('hex');
  const defaultEnv = `# ClawTime Configuration
# Generated on first run - customize as needed

# Setup token for first passkey registration (one-time use)
# Visit: http://localhost:3000/?setup=${defaultToken}
SETUP_TOKEN=${defaultToken}

# WebAuthn configuration
# For localhost testing:
RPID=localhost
ORIGIN=http://localhost:3000

# For production, update to your domain:
# RPID=your-domain.com
# ORIGIN=https://your-domain.com
`;
  fs.writeFileSync(envPath, defaultEnv, { mode: 0o600 });
  console.log('[ClawTime] Created default config at:', envPath);
  console.log('[ClawTime] Setup token:', defaultToken);
  console.log('[ClawTime] Visit: http://localhost:3000/?setup=' + defaultToken);
}

// Initialize default config.json if it doesn't exist
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({ selectedAvatar: 'lobster' }, null, 2));
}
// DECISION: Media files are stored in /tmp so they auto-clean on reboot.
// The media route exists so the bot can reference uploaded images back to the user
// via URLs in its responses (e.g., "here's the image you sent: [Image: /media/...]").
const MEDIA_DIR = '/tmp/clawtime-media';
const TTS_DIR = '/tmp/clawtime-audio';
// Generic TTS command with placeholders: {{TEXT}} and {{OUTPUT}}
// Examples:
//   edge-tts: edge-tts --text "{{TEXT}}" --write-media "{{OUTPUT}}" --voice en-US-ChristopherNeural
//   say (macOS): say -o "{{OUTPUT}}" --data-format=LEF32@22050 "{{TEXT}}" && ffmpeg -i "{{OUTPUT}}" -y "{{OUTPUT}}.mp3" && mv "{{OUTPUT}}.mp3" "{{OUTPUT}}"
//   piper: echo "{{TEXT}}" | piper --model en_US-lessac-medium --output_file "{{OUTPUT}}"
const TTS_COMMAND = process.env.TTS_COMMAND || 'edge-tts --text "{{TEXT}}" --write-media "{{OUTPUT}}" --voice en-US-ChristopherNeural';

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(TTS_DIR, { recursive: true });

// ── Public config for frontend (no secrets) ──
const publicConfig = {
  botName: BOT_NAME,
  botEmoji: BOT_EMOJI,
  botTagline: BOT_TAGLINE,
  enableAvatar: ENABLE_AVATAR,
  enableTasks: ENABLE_TASKS,
  enableVoice: ENABLE_VOICE,
  themeAccent: THEME_ACCENT,
  enableTTS: false,
  enableSTT: ENABLE_STT,
};

export {
  ROOT_DIR,
  PUBLIC_DIR,
  DATA_DIR,
  PORT,
  GW_URL,
  GW_TOKEN,
  SESSION_KEY,
  BOT_NAME,
  BOT_EMOJI,
  BOT_TAGLINE,
  ENABLE_AVATAR,
  ENABLE_INJECT,
  THEME_ACCENT,
  SESSION_TTL,
  ENABLE_STT,
  ENABLE_TASKS,
  TASKS_FILE,
  ENABLE_VOICE,
  WHISPER_BIN,
  PUBLIC_URL,
  RP_NAME,
  CREDENTIALS_FILE,
  MEDIA_DIR,
  TTS_DIR,
  TTS_COMMAND,
  publicConfig,
};
