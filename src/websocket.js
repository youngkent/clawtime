// ═══════════════════════════════════════════════════════════════════════════════
// § 11. WEBSOCKET SERVER — Real-Time Communication
//
// Connection lifecycle:
//   1. Client connects, sends { type: 'auth', token } with session token
//   2. Server validates session, generates ECDH keypair, sends auth_ok + pubkey
//   3. Client generates its ECDH keypair, sends { type: 'e2e_key', clientPublicKey }
//   4. Both sides derive AES-256-GCM key via HKDF(ECDH shared secret)
//   5. All subsequent messages are encrypted with AES-256-GCM
//   6. Server opens a gateway WebSocket to relay chat messages
//
// DECISION: E2E Encryption (ECDH + AES-256-GCM)
//   Even though we use TLS, E2E encryption protects against:
//   • TLS-terminating reverse proxies (ngrok, Cloudflare) seeing plaintext
//   • Server memory dumps / logging accidentally capturing messages
//   The ECDH key exchange happens per-connection (ephemeral keys), providing
//   forward secrecy. HKDF derives the final AES key from the shared secret
//   with a fixed salt/info pair so both sides deterministically arrive at
//   the same key.
// ═══════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GW_URL, GW_TOKEN, SESSION_KEY, PORT,
  PUBLIC_DIR, DATA_DIR, MEDIA_DIR,
} from './config.js';
import { sessions, setActiveClientWs } from './state.js';
import { auditLog } from './security.js';
import { cleanExpiredSessions, ipMatches } from './helpers.js';
import { generateAndSendTTS } from './tts.js';
import { transcribeAudio } from './stt.js';
import { saveMessage, getMessages, saveOrUpdateByRunId } from './store.js';

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (clientWs, req) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    // ── Origin validation ──
    const origin = req.headers['origin'] || '';
    const host = req.headers['host'] || '';
    const validOrigins = ['https://' + host, 'http://' + host, 'http://localhost:' + PORT, 'http://127.0.0.1:' + PORT];
    if (origin && !validOrigins.some(v => origin.startsWith(v))) {
      auditLog('ws_origin_rejected', { ip: clientIp, origin });
      clientWs.close(4003, 'Invalid origin');
      return;
    }

    console.log(`Client connected from ${clientIp}`);
    let gwWs = null;
    let connected = false;
    let voiceMode = false;
    const deltaTextByRun = new Map(); // Track accumulated delta text per runId
    const ttsSuppressedRuns = new Set(); // Runs where TTS was interrupted by barge-in
    let authenticated = false;
    let pendingMessages = [];
    const visitorId = crypto.randomUUID().slice(0, 8);
    // Track runIds we initiated — persisted to survive restarts
    const RUNID_FILE = path.join(DATA_DIR, 'pending-runids.json');
    const RUNID_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
    
    // Load persisted runIds (filter out expired ones)
    function loadRunIds() {
      try {
        if (!fs.existsSync(RUNID_FILE)) return new Map();
        const data = JSON.parse(fs.readFileSync(RUNID_FILE, 'utf8'));
        const now = Date.now();
        const valid = new Map();
        for (const [runId, timestamp] of Object.entries(data)) {
          if (now - timestamp < RUNID_EXPIRY_MS) {
            valid.set(runId, timestamp);
          }
        }
        return valid;
      } catch (e) {
        return new Map();
      }
    }
    
    // Save runIds to disk
    function saveRunIds(runIds) {
      try {
        const obj = Object.fromEntries(runIds);
        fs.writeFileSync(RUNID_FILE, JSON.stringify(obj), 'utf8');
      } catch (e) {
        console.error('Failed to save runIds:', e.message);
      }
    }
    
    // Load existing runIds from disk (survives restart)
    const webchatRunIds = loadRunIds();
    console.log(`[${visitorId}] Loaded ${webchatRunIds.size} pending runIds from disk`);
    
    // Add a runId (with timestamp for expiry)
    function trackRunId(runId) {
      webchatRunIds.set(runId, Date.now());
      saveRunIds(webchatRunIds);
    }
    
    // Remove a runId after final response received
    function untrackRunId(runId) {
      webchatRunIds.delete(runId);
      saveRunIds(webchatRunIds);
    }
    
    // Check if runId is tracked
    function isTrackedRunId(runId) {
      return webchatRunIds.has(runId);
    }

    // ── Server-side connection health (ping stale clients) ──
    let lastPong = Date.now();
    const PING_INTERVAL = 45000; // 45 seconds
    const PING_TIMEOUT = 15000;  // 15 seconds to respond
    
    const pingInterval = setInterval(() => {
      if (clientWs.readyState !== 1) { // WebSocket.OPEN = 1
        clearInterval(pingInterval);
        return;
      }
      
      // Check if last pong was too long ago (missed previous ping)
      if (Date.now() - lastPong > PING_INTERVAL + PING_TIMEOUT + 5000) {
        console.log(`[${visitorId}] Client stale (no pong), closing`);
        clientWs.close(4000, 'Connection stale');
        clearInterval(pingInterval);
        return;
      }
      
      // Send ping using WebSocket protocol-level ping (more reliable)
      try {
        clientWs.ping();
      } catch (e) {
        console.log(`[${visitorId}] Ping failed:`, e.message);
        clearInterval(pingInterval);
      }
    }, PING_INTERVAL);
    
    clientWs.on('pong', () => {
      lastPong = Date.now();
    });

    // ── E2E Encryption State ──
    let e2eKey = null; // AES-256-GCM key (Buffer) derived from ECDH
    let e2eReady = false;
    let e2ePendingOutbound = []; // messages queued before key exchange completes

    function e2eEncrypt(plaintext) {
      if (!e2eKey) return plaintext;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', e2eKey, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return JSON.stringify({
        _e2e: true,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: enc.toString('base64'),
      });
    }

    function e2eDecrypt(raw) {
      try {
        const msg = JSON.parse(raw);
        if (!msg._e2e || !e2eKey) return raw;
        const iv = Buffer.from(msg.iv, 'base64');
        const tag = Buffer.from(msg.tag, 'base64');
        const data = Buffer.from(msg.data, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', e2eKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        return raw; // not encrypted or decrypt failed — pass through
      }
    }

    function secureSend(data) {
      if (clientWs.readyState !== 1) return;
      if (e2eReady && e2eKey) {
        clientWs.send(e2eEncrypt(data));
      } else {
        clientWs.send(data);
      }
    }
    // Attach secureSend to clientWs so helper functions (TTS) can use it
    clientWs._secureSend = secureSend;

    function connectToGateway() {
      gwWs = new WebSocket(GW_URL);

      gwWs.on('open', () => {
        console.log(`[${visitorId}] Connected to gateway`);
      });

      gwWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const connectReq = {
              type: 'req',
              id: crypto.randomUUID(),
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: 'webchat-ui',
                  displayName: `Visitor ${visitorId}`,
                  version: '1.0.0',
                  platform: 'web',
                  mode: 'webchat',
                },
                caps: [],
                auth: { token: GW_TOKEN },
              },
            };
            gwWs.send(JSON.stringify(connectReq));
            return;
          }

          if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
            connected = true;
            console.log(`[${visitorId}] Gateway connected`);
            secureSend(JSON.stringify({ type: 'connected' }));

            for (const pm of pendingMessages) {
              sendToGateway(pm.text, pm.attachments);
            }
            pendingMessages = [];
            return;
          }

          if (msg.type === 'res' && !msg.ok) {
            console.error(`[${visitorId}] Gateway error:`, JSON.stringify(msg.error));
            secureSend(JSON.stringify({ type: 'error', data: msg.error?.message || 'Connection failed' }));
            return;
          }

          // Track runIds from our chat.send requests
          if (msg.type === 'res' && msg.ok && pendingChatSends.has(msg.id)) {
            pendingChatSends.delete(msg.id);
            const runId = msg.payload?.runId;
            if (runId) {
              trackRunId(runId); // Persist to disk
              console.log(`[${visitorId}] Tracking runId: ${runId}`);
            }
          }

          // (History is now served from local store, not gateway)

          if (msg.type === 'event' && msg.event === 'chat') {
            const payload = msg.payload;
            if (payload?.sessionKey !== SESSION_KEY) return;
            
            // ONLY accept responses to messages WE sent (tracked by runId)
            if (!isTrackedRunId(payload.runId)) {
              return; // Not our message — from Telegram or other channel
            }

            const state = payload.state;
            const contentBlocks = payload.message?.content || [];
            const allText = contentBlocks
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text)
              .join('\n\n');
            const text = allText;
            const errorMsg = payload.errorMessage || '';
            
            // Extract images from content blocks
            const images = contentBlocks
              .filter(b => b.type === 'image' && b.source?.data)
              .map(b => 'data:' + (b.source.media_type || 'image/jpeg') + ';base64,' + b.source.data);

            const isBot = payload.message?.role === 'assistant' || state === 'delta' || state === 'final' || state === 'error';
            if (!isBot) return;

            // Detect tool_use blocks and send avatar state update
            const hasToolUse = contentBlocks.some(b => b.type === 'tool_use');
            if (hasToolUse && state === 'delta') {
              secureSend(JSON.stringify({ type: 'avatar_state', state: 'working' }));
            }

            var trimmed = text.trim();
            if (trimmed === 'NO_REPLY' || trimmed === 'HEARTBEAT_OK') return;
            if (!text && !hasToolUse && state === 'delta') return;

            // Save bot responses to local history (both deltas and final)
            // This ensures messages survive server restarts mid-stream
            if (state === 'delta' || state === 'final') {
              if (trimmed || images.length > 0) {
                saveOrUpdateByRunId(payload.runId, {
                  text: trimmed,
                  images: images.length > 0 ? images : undefined,
                  final: state === 'final',
                });
              }
              if (state === 'final') {
                untrackRunId(payload.runId); // Done with this runId
              }
            }

            secureSend(JSON.stringify({
              type: 'chat',
              state,
              runId: payload.runId,
              text,
              error: errorMsg,
              images: images.length > 0 ? images : undefined,
            }));

            // ── Streaming TTS: sentence-by-sentence as LLM deltas arrive ──
            // How it works: each delta contains the FULL accumulated text so far.
            // We track how many characters have already been sent to TTS ('_spoken').
            // From the new portion, we extract complete sentences (ending in .!?:
            // followed by whitespace) and newline-terminated lines (bullet points).
            // Each extracted chunk is immediately queued for TTS generation.
            if (voiceMode && !ttsSuppressedRuns.has(payload.runId)) {
              if (state === 'delta' && text) {
                const full = text;
                deltaTextByRun.set(payload.runId, full);

                // Find sentences not yet spoken
                const spokenKey = payload.runId + '_spoken';
                let spokenLen = deltaTextByRun.get(spokenKey) || 0;
                let newText = full.slice(spokenLen);

                // Extract ALL complete sentences
                let sentenceMatch;
                while ((sentenceMatch = newText.match(/^([\s\S]*?[.!?:])(?:\s|\n|$)/))) {
                  const sentence = sentenceMatch[1].trim();
                  // Advance past the match including the trailing whitespace
                  const fullMatch = sentenceMatch[0];
                  spokenLen += fullMatch.length;
                  deltaTextByRun.set(spokenKey, spokenLen);
                  newText = full.slice(spokenLen);
                  if (sentence.length > 2) {
                    generateAndSendTTS(sentence, visitorId, clientWs, payload.runId);
                  }
                }
                // Also handle bullet points / list items / newline-separated chunks
                let lineMatch;
                while ((lineMatch = newText.match(/^([^\n]+)\n/))) {
                  const line = lineMatch[1].trim();
                  spokenLen += lineMatch[0].length;
                  deltaTextByRun.set(spokenKey, spokenLen);
                  newText = full.slice(spokenLen);
                  if (line.length > 2) {
                    generateAndSendTTS(line, visitorId, clientWs, payload.runId);
                  }
                }
              }

              if (state === 'final') {
                // Speak any remaining unspoken text — prefer accumulated delta text (more complete)
                const accumulated = deltaTextByRun.get(payload.runId) || '';
                const full = accumulated.length >= (text || '').length ? accumulated : (text || accumulated);
                const spokenKey = payload.runId + '_spoken';
                const spokenLen = deltaTextByRun.get(spokenKey) || 0;
                const remaining = full.slice(spokenLen).trim();
                if (remaining.length > 2) {
                  generateAndSendTTS(remaining, visitorId, clientWs, payload.runId);
                }
                deltaTextByRun.delete(payload.runId);
                deltaTextByRun.delete(spokenKey);
                ttsSuppressedRuns.delete(payload.runId);
              }
            }
            return;
          }

          if (msg.type === 'event' && msg.event === 'tick') return;

        } catch (e) {
          console.error(`[${visitorId}] Parse error:`, e.message);
        }
      });

      gwWs.on('close', (code, reason) => {
        // Gateway connection lost — client will see 'disconnected' status
        connected = false;
        secureSend(JSON.stringify({ type: 'disconnected' }));
      });

      gwWs.on('error', (err) => {
        console.error(`[${visitorId}] Gateway error:`, err.message);
      });
    }

    const pendingChatSends = new Set();

    function sendToGateway(text, attachments) {
      const idempotencyKey = crypto.randomUUID();
      const reqId = crypto.randomUUID();
      const req = {
        type: 'req',
        id: reqId,
        method: 'chat.send',
        params: {
          sessionKey: SESSION_KEY,
          message: text,
          idempotencyKey,
        },
      };
      if (attachments && attachments.length > 0) {
        req.params.attachments = attachments;
      }
      pendingChatSends.add(reqId);
      gwWs.send(JSON.stringify(req));
    }

    clientWs.on('message', async (raw) => {
      try {
        // Decrypt if E2E is active
        const rawStr = e2eReady ? e2eDecrypt(raw.toString()) : raw.toString();
        const msg = JSON.parse(rawStr);

        if (msg.type === 'auth') {
          cleanExpiredSessions();
          const sess = sessions.get(msg.token);
          console.log(`[${visitorId}] Auth check: token=${msg.token?.slice(0,8)}..., sessFound=${!!sess}`);
          if (msg.token && sess && ipMatches(sess.ip, clientIp)) {
            authenticated = true;
            setActiveClientWs(clientWs);
            auditLog('ws_auth', { ip: clientIp, visitorId });
            console.log(`[${visitorId}] Authenticated from ${clientIp}`);
            // Generate ECDH keypair and send public key with auth_ok
            const serverECDH = crypto.createECDH('prime256v1');
            serverECDH.generateKeys();
            const serverPubKey = serverECDH.getPublicKey('base64');
            clientWs.send(JSON.stringify({ type: 'auth_ok', serverPublicKey: serverPubKey }));
            // Store ECDH object for when client sends their key
            clientWs._serverECDH = serverECDH;
            connectToGateway();
          } else {
            auditLog('ws_auth_fail', { ip: clientIp, visitorId });
            clientWs.send(JSON.stringify({ type: 'auth_fail' }));
            clientWs.close(4001, 'Unauthorized');
          }
          return;
        }

        // E2E key exchange: client sends their public key
        if (msg.type === 'e2e_key' && msg.clientPublicKey && clientWs._serverECDH) {
          try {
            console.log(`[${visitorId}] E2E key exchange starting`);
            const clientPubBuf = Buffer.from(msg.clientPublicKey, 'base64');
            const sharedSecret = clientWs._serverECDH.computeSecret(clientPubBuf);
            // HKDF to derive AES-256 key
            e2eKey = crypto.hkdfSync('sha256', sharedSecret, 'clawtime-e2e-salt', 'clawtime-e2e-key', 32);
            e2eKey = Buffer.from(e2eKey);
            e2eReady = true;
            delete clientWs._serverECDH;
            auditLog('e2e_established', { visitorId });
            console.log(`[${visitorId}] E2E ready, sending e2e_ready`);
            secureSend(JSON.stringify({ type: 'e2e_ready' }));
            // Flush any pending outbound messages
            for (const pending of e2ePendingOutbound) {
              secureSend(pending);
            }
            e2ePendingOutbound = [];
          } catch (err) {
            console.error(`[${visitorId}] E2E key exchange failed:`, err.message);
            clientWs.send(JSON.stringify({ type: 'e2e_error', error: 'Key exchange failed' }));
          }
          return;
        }

        if (!authenticated) {
          clientWs.send(JSON.stringify({ type: 'auth_required' }));
          return;
        }

        if (msg.type === 'send' && msg.text) {
          console.log(`[${visitorId}] Received message: ${msg.text.slice(0, 50)}...`);
          // Save user message to local store
          saveMessage({ role: 'user', text: msg.text });
          if (connected && gwWs?.readyState === WebSocket.OPEN) {
            console.log(`[${visitorId}] Forwarding to gateway`);
            sendToGateway(msg.text);
          } else {
            console.log(`[${visitorId}] Gateway not ready, queuing message`);
            pendingMessages.push({ text: msg.text });
          }
        }

        if (msg.type === 'get_history') {
          // Serve history from local webchat-only store (no gateway needed)
          const messages = getMessages(200);
          secureSend(JSON.stringify({ type: 'history', messages }));
        }

        // ── Image upload: save to disk, forward to gateway with attachment + URL ──
        // DECISION: We include the image URL in the message text (e.g., [Image: /media/...])
        // so the bot can reference and echo the image back in its response. The base64
        // attachment gives the LLM vision access; the URL lets it link back in markdown.
        if (msg.type === 'image' && msg.data) {
          try {
            const base64data = msg.data;
            const caption = msg.caption || '';
            const imgId = crypto.randomBytes(8).toString('hex');
            const imgFile = path.join(MEDIA_DIR, `img-${imgId}.jpg`);
            fs.writeFileSync(imgFile, Buffer.from(base64data, 'base64'));

            const attachments = [{
              type: 'image',
              mimeType: 'image/jpeg',
              fileName: `photo-${imgId}.jpg`,
              content: base64data,
            }];

            const mediaUrl = `/media/img-${imgId}.jpg`;
            const msgText = caption ? `${caption}\n[Image: ${mediaUrl}]` : `Image attached\n[Image: ${mediaUrl}]`;

            // Save image message to local store
            saveMessage({ role: 'user', text: msgText, images: [mediaUrl] });

            if (connected && gwWs?.readyState === WebSocket.OPEN) {
              sendToGateway(msgText, attachments);
            } else {
              pendingMessages.push({ text: msgText, attachments });
            }

            secureSend(JSON.stringify({ type: 'image_sent' }));
          } catch (err) {
            console.error(`[${visitorId}] Image error:`, err.message);
            secureSend(JSON.stringify({ type: 'image_error', error: 'Failed to process image' }));
          }
        }

        // Encrypted resource fetch — client requests static files through E2E WS
        if (msg.type === 'fetch_resource' && msg.url) {
          try {
            const urlPath = msg.url.split('?')[0];
            // Resolve from public dir, media dir, or custom (data) dir
            let resolved;
            if (urlPath.startsWith('/media/')) {
              resolved = path.resolve(path.join(MEDIA_DIR, path.basename(urlPath)));
              if (!resolved.startsWith(path.resolve(MEDIA_DIR))) {
                secureSend(JSON.stringify({ type: 'resource_error', url: msg.url, error: 'Forbidden' }));
                return;
              }
            } else if (urlPath.startsWith('/custom/')) {
              const filename = path.basename(urlPath);
              if (!filename.match(/^[\w.-]+$/) || filename.startsWith('.')) {
                secureSend(JSON.stringify({ type: 'resource_error', url: msg.url, error: 'Forbidden' }));
                return;
              }
              resolved = path.resolve(path.join(DATA_DIR, filename));
              if (!resolved.startsWith(path.resolve(DATA_DIR))) {
                secureSend(JSON.stringify({ type: 'resource_error', url: msg.url, error: 'Forbidden' }));
                return;
              }
            } else {
              resolved = path.resolve(path.join(PUBLIC_DIR, urlPath));
              if (!resolved.startsWith(PUBLIC_DIR)) {
                secureSend(JSON.stringify({ type: 'resource_error', url: msg.url, error: 'Forbidden' }));
                return;
              }
            }
            if (!fs.existsSync(resolved)) {
              secureSend(JSON.stringify({ type: 'resource_error', url: msg.url, error: 'Not found' }));
            } else {
              const data = fs.readFileSync(resolved).toString('base64');
              const ext = path.extname(resolved).toLowerCase();
              const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.webm': 'audio/webm' };
              secureSend(JSON.stringify({ type: 'resource_data', url: msg.url, data, mimeType: mimeTypes[ext] || 'application/octet-stream' }));
            }
          } catch (err) {
            secureSend(JSON.stringify({ type: 'resource_error', url: msg.url, error: err.message }));
          }
          return;
        }

        // Barge-in: client interrupted TTS, suppress further TTS for this run
        if (msg.type === 'barge_in' && msg.runId) {
          ttsSuppressedRuns.add(msg.runId);
          deltaTextByRun.delete(msg.runId);
          deltaTextByRun.delete(msg.runId + '_spoken');
          return;
        }

        // Heartbeat ping/pong
        if (msg.type === 'ping') {
          secureSend(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Voice mode toggle
        if (msg.type === 'voice_mode') {
          voiceMode = !!msg.enabled;
          console.log(`[${visitorId}] Voice mode: ${voiceMode}`);
          return;
        }

        // Forward reverify result to gateway as a chat message
        if (msg.type === 'reverify_result') {
          const resultText = msg.verified
            ? '[REVERIFY:OK:' + (msg.requestId || '') + ']'
            : '[REVERIFY:FAIL:' + (msg.requestId || '') + ']';
          if (connected && gwWs?.readyState === WebSocket.OPEN) {
            sendToGateway(resultText);
          }
          return;
        }

        if (msg.type === 'audio' && msg.data) {
          try {
            const audioBuffer = Buffer.from(msg.data, 'base64');
            const transcription = await transcribeAudio(audioBuffer);

            // Filter out blank/empty/noise transcriptions from Whisper
            const trimmed = (transcription || '').trim();
            const isNoise = /^\(.*\)$/.test(trimmed) || /^\[.*\]$/.test(trimmed); // (sniffing), [MUSIC], etc.
            const isBlank = !transcription || isNoise || trimmed.length < 2;

            secureSend(JSON.stringify({
              type: 'transcription',
              text: isBlank ? '' : transcription,
            }));

            if (!isBlank) {
              // Save transcribed voice message to local store
              saveMessage({ role: 'user', text: transcription });
              if (connected && gwWs?.readyState === WebSocket.OPEN) {
                sendToGateway(transcription);
              }
            }
          } catch (err) {
            console.error(`[${visitorId}] STT error:`, err.message);
            secureSend(JSON.stringify({
              type: 'stt_error',
              error: 'Failed to transcribe audio',
            }));
          }
        }
      } catch (e) {
        console.error(`[${visitorId}] Client message error:`, e.message);
      }
    });

    clientWs.on('close', () => {
      console.log(`[${visitorId}] Client disconnected`);
      clearInterval(pingInterval);
      auditLog('ws_close', { visitorId });
      if (gwWs) gwWs.close();
    });
  });

  return wss;
}
