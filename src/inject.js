// ═══════════════════════════════════════════════════════════════════════════════
// § 12. INJECT & REVERIFY ENDPOINTS (localhost only)
//
// These endpoints allow the local bot/agent to:
//   • /api/inject  — Push a message to the active client (bot-initiated messages)
//   • /api/reverify — Request the client to re-authenticate for sensitive ops
// Both are restricted to localhost to prevent external abuse.
// ═══════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { getActiveClientWs } from './state.js';
import { auditLog } from './security.js';

export function setupInjectRoutes(server) {
  const origHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    // ── Trigger reverify from bot ──
    if (req.method === 'POST' && req.url === '/api/reverify') {
      const ip = req.socket.remoteAddress;
      if (!ip?.includes('127.0.0.1') && !ip?.includes('::1')) {
        res.writeHead(403); res.end('localhost only'); return;
      }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { requestId, reason } = JSON.parse(body);
          const activeClientWs = getActiveClientWs();
          if (!requestId || !activeClientWs || activeClientWs.readyState !== 1) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'no client or requestId' })); return;
          }
          const sendFn = activeClientWs._secureSend || ((d) => activeClientWs.send(d));
          sendFn(JSON.stringify({ type: 'reverify_request', requestId, reason: reason || 'Sensitive operation requested' }));
          auditLog('reverify_request', { requestId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) { res.writeHead(400); res.end(e.message); }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/inject') {
      const ip = req.socket.remoteAddress;
      if (!ip?.includes('127.0.0.1') && !ip?.includes('::1')) {
        res.writeHead(403); res.end('localhost only'); return;
      }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body);
          const activeClientWs = getActiveClientWs();
          if (!text || !activeClientWs || activeClientWs.readyState !== 1) {
            res.writeHead(400); res.end('no client or text'); return;
          }
          const sendFn = activeClientWs._secureSend || ((d) => activeClientWs.send(d));
          sendFn(JSON.stringify({
            type: 'chat', state: 'final',
            runId: 'inject-' + crypto.randomUUID().slice(0, 8),
            text, error: ''
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e) { res.writeHead(400); res.end(e.message); }
      });
      return;
    }
    origHandler(req, res);
  });
}
