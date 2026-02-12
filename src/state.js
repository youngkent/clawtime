// ═══════════════════════════════════════════════════════════════════════════════
// § 4. IN-MEMORY STATE (with session persistence)
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = process.env.CLAWTIME_DATA || path.join(os.homedir(), '.clawtime');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Load persisted sessions on startup
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const map = new Map();
      for (const [token, session] of Object.entries(data)) {
        map.set(token, session);
      }
      console.log(`[State] Loaded ${map.size} sessions from disk`);
      return map;
    }
  } catch (e) {
    console.error('[State] Failed to load sessions:', e.message);
  }
  return new Map();
}

// Save sessions to disk
function saveSessions(sessions) {
  try {
    const obj = Object.fromEntries(sessions);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[State] Failed to save sessions:', e.message);
  }
}

const sessions = loadSessions();  // token → { createdAt }
const challenges = new Map();     // challengeId → { challenge, type, createdAt }
const inviteTokens = new Map();   // inviteToken → { createdAt, expiresAt, label }

// Wrap session mutations to auto-persist
export function createSession(token, data) {
  sessions.set(token, data);
  saveSessions(sessions);
}

export function deleteSession(token) {
  sessions.delete(token);
  saveSessions(sessions);
}

// DECISION: Setup token is a one-time bootstrap credential for registering the
// FIRST passkey. After a successful registration, it's consumed (set to '') so
// it can never be reused. This prevents an attacker who intercepts the setup URL
// from registering after the legitimate admin already has.
let SETUP_TOKEN = process.env.SETUP_TOKEN || '';

let activeClientWs = null;        // Track the active webchat client for injection

export function getSetupToken() { return SETUP_TOKEN; }
export function consumeSetupToken() {
  SETUP_TOKEN = '';
  // Also remove from .env so it stays consumed after restart
  const envPath = path.join(DATA_DIR, '.env');
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const updated = content
        .split('\n')
        .filter(line => !line.match(/^\s*SETUP_TOKEN\s*=/))
        .join('\n');
      fs.writeFileSync(envPath, updated);
      console.log('[ClawTime] Setup token consumed and removed from .env');
    }
  } catch (err) {
    console.error('[ClawTime] Failed to remove setup token from .env:', err.message);
  }
}

export function getActiveClientWs() { return activeClientWs; }
export function setActiveClientWs(ws) { activeClientWs = ws; }

export { sessions, challenges, inviteTokens };
