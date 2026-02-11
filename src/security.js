// ═══════════════════════════════════════════════════════════════════════════════
// § 5. SECURITY — Rate Limiting, Headers, Audit Logging
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';

const rateLimitMap = new Map(); // ip → { count, resetAt }
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // max attempts per window

export function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Garbage-collect expired rate limit entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 60000);

// ── Security Headers ──
export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; connect-src 'self' wss: ws:; media-src 'self' blob:; img-src 'self' data: blob: https: http:;");
}

// ── Audit Logging ──
const AUDIT_LOG = '/tmp/clawtime-audit.log';
export function auditLog(event, details = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
  fs.appendFileSync(AUDIT_LOG, entry + '\n');
}
