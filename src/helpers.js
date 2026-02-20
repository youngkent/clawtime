// ═══════════════════════════════════════════════════════════════════════════════
// § 7. UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

import { SESSION_TTL } from "./config.js";
import { sessions, challenges, deleteSession } from "./state.js";

export function getRpID(req) {
  const host = req.headers["host"] || "localhost";
  return host.split(":")[0];
}

export function getExpectedOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["host"] || "localhost";
  return `${proto}://${host}`;
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (now - sess.createdAt > SESSION_TTL) deleteSession(token);
  }
}

export function cleanExpiredChallenges() {
  const now = Date.now();
  for (const [id, ch] of challenges) {
    if (now - ch.createdAt > 5 * 60 * 1000) challenges.delete(id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 8. STATIC FILE SERVING
// ═══════════════════════════════════════════════════════════════════════════════
export const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
};

/**
 * Compare IPs — for IPv6, compare only the /64 prefix (first 4 groups)
 * since privacy extensions randomize the interface identifier
 */
export function ipMatches(sessIp, connIp) {
  if (sessIp === connIp) return true;

  // Normalize localhost variants
  const localhosts = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"];
  const sessLocal = localhosts.some((l) => sessIp?.includes(l));
  const connLocal = localhosts.some((l) => connIp?.includes(l));
  if (sessLocal && connLocal) return true;

  // IPv6 prefix matching (first 4 segments)
  if (sessIp?.includes(":") && connIp?.includes(":")) {
    const sessPrefix = sessIp.split(":").slice(0, 4).join(":");
    const connPrefix = connIp.split(":").slice(0, 4).join(":");
    return sessPrefix === connPrefix;
  }
  return false;
}

/**
 * Validate safe filename — prevents path traversal attacks
 * Only allows alphanumeric, dash, and underscore
 */
export function isSafeFilename(name) {
  if (!name || typeof name !== "string") return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
