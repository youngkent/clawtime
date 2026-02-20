// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  ClawTime Server                                                          ║
// ║                                                                           ║
// ║  A secure WebSocket chat bridge between a web client and an OpenClaw      ║
// ║  gateway agent. Features:                                                 ║
// ║    • WebAuthn passkey authentication (no passwords)                       ║
// ║    • End-to-end encryption (ECDH P-256 + AES-256-GCM)                    ║
// ║    • Server-side TTS via edge-tts with streaming sentence detection       ║
// ║    • Push-to-talk with browser SpeechRecognition + Whisper fallback       ║
// ║    • 3D avatar with emotional states                                      ║
// ║    • Image upload with gateway attachment forwarding                      ║
// ║                                                                           ║
// ║  Module structure:                                                        ║
// ║    src/config.js      — Environment variables, paths, public config       ║
// ║    src/state.js       — In-memory state (sessions, challenges, tokens)    ║
// ║    src/security.js    — Rate limiting, security headers, audit logging    ║
// ║    src/credentials.js — WebAuthn passkey persistence (JSON)               ║
// ║    src/helpers.js     — Utility functions, MIME types                     ║
// ║    src/tts.js         — Text-to-speech via edge-tts                       ║
// ║    src/stt.js         — Speech-to-text via whisper-transcribe             ║
// ║    src/routes.js      — HTTP REST API route handlers                      ║
// ║    src/websocket.js   — WebSocket server, E2E encryption, gateway relay   ║
// ║    src/inject.js      — Localhost-only inject & reverify endpoints        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

import fs from "fs";
import http from "http";
import path from "path";
import { PORT, BOT_NAME, BOT_EMOJI, GW_URL, ENABLE_INJECT, DATA_DIR } from "./src/config.js";
import { loadCredentials } from "./src/credentials.js";
import { setupInjectRoutes } from "./src/inject.js";
import { handleRequest } from "./src/routes.js";
import { cleanupIncompleteMessages, flushSync } from "./src/store.js";
import { setupWebSocket } from "./src/websocket.js";

// ═══════════════════════════════════════════════════════════════════════════════
// § 13. SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

let server = null;

export function startServer(options = {}) {
  const port = options.port || PORT;

  // Clean up any incomplete messages from previous crashes/restarts
  cleanupIncompleteMessages();

  server = http.createServer(handleRequest);
  setupWebSocket(server, options);

  if (ENABLE_INJECT) {
    setupInjectRoutes(server);
  }

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      const creds = loadCredentials();
      console.log(
        `ClawTime running on :${port} | ${BOT_NAME} ${BOT_EMOJI} | ${creds.length} passkey(s) | gw=${options.gwUrl || GW_URL}`,
      );
      resolve(server);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 14. GRACEFUL SHUTDOWN — Wait for pending responses
// ═══════════════════════════════════════════════════════════════════════════════

const RUNID_FILE = path.join(DATA_DIR, "pending-runids.json");
const SHUTDOWN_TIMEOUT = 30000; // Max 30 seconds to wait

function getPendingCount() {
  try {
    if (!fs.existsSync(RUNID_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(RUNID_FILE, "utf8"));
    const now = Date.now();
    let valid = 0;
    for (const [runId, timestamp] of Object.entries(data)) {
      // Only count runIds less than 2 minutes old
      if (now - timestamp < 120000) valid++;
    }
    return valid;
  } catch (e) {
    return 0;
  }
}

// Clean up stale runIds on startup
function cleanupStaleRunIds() {
  try {
    if (!fs.existsSync(RUNID_FILE)) return;
    const data = JSON.parse(fs.readFileSync(RUNID_FILE, "utf8"));
    const now = Date.now();
    const valid = {};
    for (const [runId, timestamp] of Object.entries(data)) {
      // Keep runIds less than 2 minutes old
      if (now - timestamp < 120000) {
        valid[runId] = timestamp;
      }
    }
    fs.writeFileSync(RUNID_FILE, JSON.stringify(valid), "utf8");
    const removed = Object.keys(data).length - Object.keys(valid).length;
    if (removed > 0) {
      console.log(`[Startup] Cleaned ${removed} stale runId(s)`);
    }
  } catch (e) {
    // Ignore
  }
}

cleanupStaleRunIds();

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Shutdown] Received ${signal}, waiting for pending responses...`);
  console.log("[Shutdown] Server still accepting connections to receive responses");

  const startTime = Date.now();
  let pending = getPendingCount();

  // Keep server running to receive final responses
  while (pending > 0 && Date.now() - startTime < SHUTDOWN_TIMEOUT) {
    console.log(`[Shutdown] ${pending} pending response(s), waiting...`);
    await new Promise((r) => setTimeout(r, 2000));
    pending = getPendingCount();
  }

  if (pending > 0) {
    console.log(
      `[Shutdown] Timeout after ${SHUTDOWN_TIMEOUT / 1000}s, ${pending} response(s) may be lost`,
    );
  } else {
    console.log("[Shutdown] All responses saved, exiting cleanly");
  }

  // Flush any pending store writes
  console.log("[Shutdown] Flushing message store...");
  flushSync();

  // Now close everything
  server.close(() => {
    console.log("[Shutdown] Server closed");
    process.exit(0);
  });

  // Force exit after additional 5 seconds if server.close hangs
  setTimeout(() => {
    console.log("[Shutdown] Force exit");
    process.exit(0);
  }, 5000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Auto-start when run directly (not imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  startServer();
}
