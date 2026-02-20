// ═══════════════════════════════════════════════════════════════════════════════
// § 11. WEBSOCKET SERVER — Real-Time Communication
//
// Connection lifecycle:
//   1. Client connects, sends { type: 'auth', token } with session token
//   2. Server validates session, generates ECDH keypair, sends auth_ok + pubkey
//   3. Client generates its ECDH keypair, sends { type: 'e2e_key', clientPublicKey }
//   4. Both sides derive AES-256-GCM key via HKDF(ECDH shared secret)
//   5. All subsequent messages are encrypted with AES-256-GCM
//   6. Server opens a SHARED gateway WebSocket to relay chat messages
//
// ARCHITECTURE: Single shared gateway connection serves all clients (chatroom mode)
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

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import {
  GW_URL,
  GW_TOKEN,
  SESSION_KEY,
  PORT,
  PUBLIC_DIR,
  DATA_DIR,
  MEDIA_DIR,
  PUBLIC_URL,
} from "./config.js";
import { cleanExpiredSessions, ipMatches } from "./helpers.js";
import { auditLog } from "./security.js";
import { sessions, setActiveClientWs } from "./state.js";
import { saveMessage, getMessages, saveOrUpdateByMessageId, saveWidgetResponse } from "./store.js";
import { transcribeAudio } from "./stt.js";
import { generateAndSendTTS } from "./tts.js";

export function setupWebSocket(server, options = {}) {
  const wss = new WebSocketServer({ server });
  const gwUrl = options.gwUrl || GW_URL;

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED STATE — All connections share these (single chatroom mode)
  // ═══════════════════════════════════════════════════════════════════════════
  const sharedClients = new Set();
  let sharedGwWs = null;
  let sharedGwConnected = false;
  let sharedAvatarState = "idle";
  const sharedRunIds = new Set();
  const RUNID_FILE = path.join(DATA_DIR, "pending-runids.json");
  let lastGatewayMessageTime = Date.now(); // Track for reconnect sync
  // Message tracking - don't rely on runId
  let currentBotMessageId = null; // Current streaming message
  let expectingNewMessage = true; // Next delta starts a new message
  const messageTextSent = new Map(); // Track accumulated text sent per messageId (for delta computation)

  function persistRunIds() {
    const data = {};
    for (const runId of sharedRunIds) {
      data[runId] = Date.now();
    }
    try {
      fs.writeFileSync(RUNID_FILE, JSON.stringify(data), "utf8");
    } catch (e) {
      console.error("[shared] Failed to persist runIds:", e.message);
    }
  }

  function loadPersistedRunIds() {
    try {
      if (fs.existsSync(RUNID_FILE)) {
        const data = JSON.parse(fs.readFileSync(RUNID_FILE, "utf8"));
        const now = Date.now();
        for (const [runId, timestamp] of Object.entries(data)) {
          // Only load runIds less than 2 minutes old
          if (now - timestamp < 120000) {
            sharedRunIds.add(runId);
          }
        }
      }
    } catch (e) {
      console.error("[shared] Failed to load runIds:", e.message);
    }
  }

  // Load any persisted runIds from previous session
  loadPersistedRunIds();
  const sharedPendingSends = new Set();
  const deltaTextByRun = new Map(); // Track accumulated delta text per runId (for TTS)
  let sharedAwaitingResponse = 0; // Count of messages awaiting first delta

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of sharedClients) {
      if (client.readyState === 1 && client._secureSend) {
        client._secureSend(data);
      }
    }
  }

  function broadcastExcept(msg, excludeWs) {
    const data = JSON.stringify(msg);
    for (const client of sharedClients) {
      if (client !== excludeWs && client.readyState === 1 && client._secureSend) {
        client._secureSend(data);
      }
    }
  }

  function sharedTrackRunId(runId) {
    sharedRunIds.add(runId);
    persistRunIds();
  }

  function sharedUntrackRunId(runId) {
    sharedRunIds.delete(runId);
    persistRunIds();
  }

  function sharedIsTracked(runId) {
    return sharedRunIds.has(runId);
  }

  // ── Streaming TTS for voice mode clients ──
  function handleTTSForClients(runId, state, text) {
    for (const client of sharedClients) {
      if (!client._voiceMode || client._ttsSuppressedRuns?.has(runId)) continue;

      if (state === "delta" && text) {
        const full = text;
        deltaTextByRun.set(runId, full);

        const spokenKey = runId + "_spoken";
        let spokenLen = deltaTextByRun.get(spokenKey) || 0;
        let newText = full.slice(spokenLen);

        // Extract complete sentences
        let sentenceMatch;
        while ((sentenceMatch = newText.match(/^([\s\S]*?[.!?:])(?:\s|\n|$)/))) {
          const sentence = sentenceMatch[1].trim();
          spokenLen += sentenceMatch[0].length;
          deltaTextByRun.set(spokenKey, spokenLen);
          newText = full.slice(spokenLen);
          if (sentence.length > 2) {
            generateAndSendTTS(sentence, client._visitorId, client, runId);
          }
        }
        // Handle bullet points / newline-separated chunks
        let lineMatch;
        while ((lineMatch = newText.match(/^([^\n]+)\n/))) {
          const line = lineMatch[1].trim();
          spokenLen += lineMatch[0].length;
          deltaTextByRun.set(spokenKey, spokenLen);
          newText = full.slice(spokenLen);
          if (line.length > 2) {
            generateAndSendTTS(line, client._visitorId, client, runId);
          }
        }
      }

      if (state === "final") {
        const accumulated = deltaTextByRun.get(runId) || "";
        const full = accumulated.length >= (text || "").length ? accumulated : text || accumulated;
        const spokenKey = runId + "_spoken";
        const spokenLen = deltaTextByRun.get(spokenKey) || 0;
        const remaining = full.slice(spokenLen).trim();
        if (remaining.length > 2) {
          generateAndSendTTS(remaining, client._visitorId, client, runId);
        }
      }
    }

    if (state === "final") {
      deltaTextByRun.delete(runId);
      deltaTextByRun.delete(runId + "_spoken");
      for (const client of sharedClients) {
        client._ttsSuppressedRuns?.delete(runId);
      }
    }
  }

  // ── Widget extraction from text ──
  function extractAndSendWidgets(text, runId) {
    const widgetMatches = text.match(/\[\[WIDGET:([\s\S]*?)\]\]/g);
    const parsedWidgets = [];

    if (widgetMatches) {
      for (const match of widgetMatches) {
        try {
          const jsonStr = match.replace(/^\[\[WIDGET:/, "").replace(/\]\]$/, "");
          const widgetData = JSON.parse(jsonStr);
          const widgetType = widgetData.widget || widgetData.type;

          if (widgetType && widgetData.id) {
            // Track sent widgets per runId to avoid duplicates
            const widgetKey = `${runId}:${widgetData.id}`;
            if (!sharedSentWidgetIds.has(widgetKey)) {
              sharedSentWidgetIds.add(widgetKey);
              broadcast({ type: "widget", widget: widgetType, ...widgetData });
              parsedWidgets.push(widgetData);
              saveMessage({ role: "bot", text: "", widget: widgetData });
            }
          }
        } catch (e) {
          console.error("Failed to parse widget:", e.message);
        }
      }
    }
    return parsedWidgets;
  }
  const sharedSentWidgetIds = new Set();

  function connectSharedGateway() {
    if (
      sharedGwWs &&
      (sharedGwWs.readyState === WebSocket.OPEN || sharedGwWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const wsOpts = PUBLIC_URL ? { headers: { Origin: PUBLIC_URL } } : {};
    sharedGwWs = new WebSocket(gwUrl, wsOpts);

    sharedGwWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "event" && msg.event === "connect.challenge") {
          sharedGwWs.send(
            JSON.stringify({
              type: "req",
              id: crypto.randomUUID(),
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "webchat-ui",
                  displayName: "ClawTime",
                  version: "1.0.0",
                  platform: "web",
                  mode: "webchat",
                },
                caps: [],
                role: "operator",
                scopes: ["operator.write", "operator.read"],
                auth: { token: GW_TOKEN },
              },
            }),
          );
          return;
        }

        if (msg.type === "res" && msg.ok && msg.payload?.type === "hello-ok") {
          sharedGwConnected = true;
          broadcast({ type: "connected", avatarState: sharedAvatarState });

          // On reconnect, notify clients to refresh their local history
          // (local store is source of truth, gateway history requires admin scope)
          broadcast({ type: "history_sync" });

          // Send any pending messages that were queued while gateway was connecting
          for (const client of sharedClients) {
            if (client._pendingMessages?.length > 0) {
              for (const pm of client._pendingMessages) {
                sharedSendToGateway(pm.text, pm.attachments);
              }
              client._pendingMessages = [];
            }
          }
          return;
        }

        if (msg.type === "res" && msg.ok && sharedPendingSends.has(msg.id)) {
          sharedPendingSends.delete(msg.id);
          if (msg.payload?.runId) sharedTrackRunId(msg.payload.runId);
          return;
        }

        if (msg.type === "res" && !msg.ok) {
          console.error("[shared] Gateway error:", JSON.stringify(msg.error));
          broadcast({ type: "error", data: msg.error?.message || "Gateway error" });
          return;
        }

        if (msg.type === "event" && msg.event === "chat") {
          const payload = msg.payload;
          if (payload?.sessionKey !== SESSION_KEY) return;
          if (!sharedIsTracked(payload.runId)) return;

          // Update last message time for reconnect sync
          lastGatewayMessageTime = Date.now();

          const state = payload.state;
          const contentBlocks = payload.message?.content || [];
          const text = contentBlocks
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join("\n\n");
          const images = contentBlocks
            .filter((b) => b.type === "image" && b.source?.data)
            .map(
              (b) => "data:" + (b.source.media_type || "image/jpeg") + ";base64," + b.source.data,
            );

          // Skip internal signals
          const trimmed = (text || "").trim();
          if (trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK") return;

          // Extract widgets
          const cleanText = text.replace(/\[\[WIDGET:[\s\S]*?\]\]/g, "").trim();
          extractAndSendWidgets(text, payload.runId);

          // Assign messageId based on message flow (not runId)
          // New message starts after: user sends, or previous final received
          let messageId;
          if (expectingNewMessage || !currentBotMessageId) {
            messageId = crypto.randomUUID();
            currentBotMessageId = messageId;
            expectingNewMessage = false;
          } else {
            messageId = currentBotMessageId;
          }

          // After final, next delta starts new message
          if (state === "final") {
            expectingNewMessage = true;
          }

          // Save to store using messageId (returns accumulated text for persistence)
          // Only update store if there's actual content (skip tool_use-only events)
          let accumulatedText = messageTextSent.get(messageId) || ""; // Preserve previous state
          if (cleanText || images.length > 0) {
            const result = saveOrUpdateByMessageId(messageId, {
              text: cleanText,
              images: images.length > 0 ? images : undefined,
              final: state === "final",
            });
            if (result) {
              accumulatedText = result.text;
            }
          }

          // Skip if no content change (e.g., tool_use event with no text)
          const lastSent = messageTextSent.get(messageId) || "";
          if (!cleanText && !images.length && accumulatedText === lastSent && state !== "final") {
            return; // Nothing new to send
          }

          // ═══════════════════════════════════════════════════════════════════════
          // API CONTRACT: Server sends DELTA text (new portion only)
          // Client MUST accumulate deltas per messageId to build full message.
          // On 'final', client should finalize the message (remove streaming state).
          // ═══════════════════════════════════════════════════════════════════════

          // Compute delta: difference between what we've sent and current accumulated
          let deltaText = "";

          if (accumulatedText.length > lastSent.length && accumulatedText.startsWith(lastSent)) {
            // Normal case: accumulated grew, send new portion
            deltaText = accumulatedText.slice(lastSent.length);
          } else if (accumulatedText.length > lastSent.length) {
            // Store appended new block — accumulated doesn't start with lastSent
            // Send the full accumulated (client will re-render, but no data loss)
            deltaText = accumulatedText;
            console.log(
              `[ws] Block append detected, sending full accumulated (${accumulatedText.length} chars)`,
            );
          }
          // Note: if accumulated <= lastSent, nothing new to send (handled by early return above)

          // Update tracking only when we have actual content
          if (accumulatedText) {
            messageTextSent.set(messageId, accumulatedText);
          }

          // Clean up tracking on final
          if (state === "final") {
            messageTextSent.delete(messageId);
          }

          // Only broadcast if there's new content
          if (deltaText || images.length > 0 || state === "final") {
            broadcast({
              type: "chat",
              state,
              messageId,
              text: deltaText,
              images: images.length > 0 ? images : undefined,
            });
          }

          // Avatar state machine (server is source of truth)
          if (state === "delta") {
            // First delta → talking (streaming response)
            if (sharedAvatarState === "thinking") {
              sharedAwaitingResponse = Math.max(0, sharedAwaitingResponse - 1);
              sharedAvatarState = "talking";
              broadcast({ type: "avatar_state", state: "talking" });
            }
            // Check for tool use → working
            if (contentBlocks.some((b) => b.type === "tool_use")) {
              sharedAvatarState = "working";
              broadcast({ type: "avatar_state", state: "working" });
            }
            // Check for code blocks → coding
            else if (/```/.test(cleanText) && sharedAvatarState !== "coding") {
              sharedAvatarState = "coding";
              broadcast({ type: "avatar_state", state: "coding" });
            }
          } else if (state === "final") {
            sharedUntrackRunId(payload.runId);

            // Only show emotional state if no new messages awaiting response
            if (sharedAwaitingResponse === 0 && sharedRunIds.size === 0) {
              // Determine emotional state based on content
              let emotionalState = "happy";
              if (/```/.test(cleanText) || /\bcode\b|\bfunction\b/i.test(cleanText)) {
                emotionalState = "coding";
              } else if (/🎉|✅|done|complete|success|fixed/i.test(cleanText)) {
                emotionalState = "celebrating";
              } else if (/error|fail|broken|can't|sorry/i.test(cleanText)) {
                emotionalState = "frustrated";
              }
              sharedAvatarState = emotionalState;
              broadcast({ type: "avatar_state", state: emotionalState });

              // Schedule idle after delay (only if still no activity)
              setTimeout(() => {
                if (sharedRunIds.size === 0 && sharedAwaitingResponse === 0) {
                  sharedAvatarState = "idle";
                  broadcast({ type: "avatar_state", state: "idle" });
                }
              }, 3000);
            }
            // If there are pending sends, stay in thinking (already set)
          }

          // TTS for voice mode
          handleTTSForClients(payload.runId, state, cleanText);
        }

        if (msg.type === "event" && msg.event === "tick") return;
      } catch (e) {
        console.error("[shared] Parse error:", e.message);
      }
    });

    sharedGwWs.on("close", () => {
      sharedGwConnected = false;
      broadcast({ type: "disconnected" });
      setTimeout(() => {
        if (sharedClients.size > 0) connectSharedGateway();
      }, 3000);
    });

    sharedGwWs.on("error", (err) => console.error("[shared] Gateway error:", err.message));
  }

  function sharedSendToGateway(text, attachments) {
    if (!sharedGwWs || sharedGwWs.readyState !== WebSocket.OPEN) return false;
    const reqId = crypto.randomUUID();
    const req = {
      type: "req",
      id: reqId,
      method: "chat.send",
      params: { sessionKey: SESSION_KEY, message: text, idempotencyKey: crypto.randomUUID() },
    };
    if (attachments?.length > 0) req.params.attachments = attachments;
    sharedPendingSends.add(reqId);
    sharedGwWs.send(JSON.stringify(req));
    // Next bot response should be a new message
    expectingNewMessage = true;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PER-CONNECTION HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  wss.on("connection", (clientWs, req) => {
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;

    // ── Origin validation ──
    const origin = req.headers["origin"] || "";
    const host = req.headers["host"] || "";
    const validOrigins = [
      "https://" + host,
      "http://" + host,
      "http://localhost:" + PORT,
      "http://127.0.0.1:" + PORT,
    ];
    if (origin && !validOrigins.some((v) => origin.startsWith(v))) {
      auditLog("ws_origin_rejected", { ip: clientIp, origin });
      clientWs.close(4003, "Invalid origin");
      return;
    }

    let authenticated = false;
    const visitorId = crypto.randomUUID().slice(0, 8);

    // Per-client state (attached to clientWs for shared gateway access)
    clientWs._visitorId = visitorId;
    clientWs._voiceMode = false;
    clientWs._ttsSuppressedRuns = new Set();
    clientWs._pendingMessages = [];

    // ── Server-side connection health (ping stale clients) ──
    let lastPong = Date.now();
    const PING_INTERVAL = 45000;
    const PING_TIMEOUT = 15000;

    const pingInterval = setInterval(() => {
      if (clientWs.readyState !== 1) {
        clearInterval(pingInterval);
        return;
      }
      if (Date.now() - lastPong > PING_INTERVAL + PING_TIMEOUT + 5000) {
        clientWs.close(4000, "Connection stale");
        clearInterval(pingInterval);
        return;
      }
      try {
        clientWs.ping();
      } catch (e) {
        clearInterval(pingInterval);
      }
    }, PING_INTERVAL);

    clientWs.on("pong", () => {
      lastPong = Date.now();
    });

    // ── E2E Encryption State ──
    let e2eKey = null;
    let e2eReady = false;
    let e2ePendingOutbound = [];

    function e2eEncrypt(plaintext) {
      if (!e2eKey) return plaintext;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", e2eKey, iv);
      const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return JSON.stringify({
        _e2e: true,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: enc.toString("base64"),
      });
    }

    function e2eDecrypt(raw) {
      try {
        const msg = JSON.parse(raw);
        if (!msg._e2e || !e2eKey) return raw;
        const iv = Buffer.from(msg.iv, "base64");
        const tag = Buffer.from(msg.tag, "base64");
        const data = Buffer.from(msg.data, "base64");
        const decipher = crypto.createDecipheriv("aes-256-gcm", e2eKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      } catch {
        return raw;
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
    clientWs._secureSend = secureSend;

    clientWs.on("message", async (raw) => {
      try {
        const rawStr = e2eReady ? e2eDecrypt(raw.toString()) : raw.toString();
        const msg = JSON.parse(rawStr);

        // ── Authentication ──
        if (msg.type === "auth") {
          cleanExpiredSessions();
          const sess = sessions.get(msg.token);
          if (msg.token && sess && ipMatches(sess.ip, clientIp)) {
            authenticated = true;
            setActiveClientWs(clientWs);
            sharedClients.add(clientWs);
            auditLog("ws_auth", { ip: clientIp, visitorId });

            const serverECDH = crypto.createECDH("prime256v1");
            serverECDH.generateKeys();
            clientWs.send(
              JSON.stringify({
                type: "auth_ok",
                serverPublicKey: serverECDH.getPublicKey("base64"),
              }),
            );
            clientWs._serverECDH = serverECDH;

            connectSharedGateway();

            // Send pending messages once gateway connects
            if (sharedGwConnected) {
              for (const pm of clientWs._pendingMessages) {
                sharedSendToGateway(pm.text, pm.attachments);
              }
              clientWs._pendingMessages = [];
            }
          } else {
            auditLog("ws_auth_fail", { ip: clientIp, visitorId });
            clientWs.send(JSON.stringify({ type: "auth_fail" }));
            clientWs.close(4001, "Unauthorized");
          }
          return;
        }

        // ── E2E Key Exchange ──
        if (msg.type === "e2e_key" && msg.clientPublicKey && clientWs._serverECDH) {
          try {
            const clientPubBuf = Buffer.from(msg.clientPublicKey, "base64");
            const sharedSecret = clientWs._serverECDH.computeSecret(clientPubBuf);
            e2eKey = Buffer.from(
              crypto.hkdfSync("sha256", sharedSecret, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
            );
            e2eReady = true;
            delete clientWs._serverECDH;
            auditLog("e2e_established", { visitorId });
            secureSend(JSON.stringify({ type: "e2e_ready" }));

            // Send connected status if gateway is already connected
            if (sharedGwConnected) {
              secureSend(JSON.stringify({ type: "connected", avatarState: sharedAvatarState }));
            }

            // Send current avatar state if there are pending operations
            if (sharedRunIds.size > 0) {
              secureSend(JSON.stringify({ type: "avatar_state", state: sharedAvatarState }));
            }

            for (const pending of e2ePendingOutbound) {
              secureSend(pending);
            }
            e2ePendingOutbound = [];
          } catch (err) {
            console.error(`[${visitorId}] E2E failed:`, err.message);
            clientWs.send(JSON.stringify({ type: "e2e_error", error: "Key exchange failed" }));
          }
          return;
        }

        if (!authenticated) {
          clientWs.send(JSON.stringify({ type: "auth_required" }));
          return;
        }

        // ── Send Message ──
        if (msg.type === "send" && msg.text) {
          saveMessage({ role: "user", text: msg.text });
          broadcastExcept({ type: "user_message", text: msg.text }, clientWs);

          // Set avatar to thinking when user sends a message
          sharedAvatarState = "thinking";
          sharedAwaitingResponse++;
          broadcast({ type: "avatar_state", state: "thinking" });

          if (sharedGwConnected) {
            sharedSendToGateway(msg.text);
          } else {
            clientWs._pendingMessages.push({ text: msg.text });
          }
        }

        // ── Get History ──
        if (msg.type === "get_history") {
          const messages = getMessages(200);
          secureSend(JSON.stringify({ type: "history", messages }));
        }

        // ── Image Upload ──
        if (msg.type === "image" && msg.data) {
          try {
            const base64data = msg.data;
            const caption = msg.caption || "";
            const imgId = crypto.randomBytes(8).toString("hex");
            const imgFile = path.join(MEDIA_DIR, `img-${imgId}.jpg`);
            fs.writeFileSync(imgFile, Buffer.from(base64data, "base64"));

            const attachments = [
              {
                type: "image",
                mimeType: "image/jpeg",
                fileName: `photo-${imgId}.jpg`,
                content: base64data,
              },
            ];
            const mediaUrl = `/media/img-${imgId}.jpg`;
            const msgText = caption
              ? `${caption}\n[Image: ${mediaUrl}]`
              : `Image attached\n[Image: ${mediaUrl}]`;

            saveMessage({ role: "user", text: msgText, images: [mediaUrl] });

            if (sharedGwConnected) {
              sharedSendToGateway(msgText, attachments);
            } else {
              clientWs._pendingMessages.push({ text: msgText, attachments });
            }
            secureSend(JSON.stringify({ type: "image_sent" }));
          } catch (err) {
            console.error(`[${visitorId}] Image error:`, err.message);
            secureSend(JSON.stringify({ type: "image_error", error: "Failed to process image" }));
          }
        }

        // ── Multi-attachment Upload ──
        if (msg.type === "attachments" && msg.attachments && Array.isArray(msg.attachments)) {
          try {
            const caption = msg.caption || "";
            const attachments = [];
            const mediaUrls = [];
            const imageUrls = [];

            for (const att of msg.attachments) {
              const attId = crypto.randomBytes(8).toString("hex");
              const ext = (att.name || "").split(".").pop() || "bin";
              const fileName = `att-${attId}.${ext}`;
              const filePath = path.join(MEDIA_DIR, fileName);
              fs.writeFileSync(filePath, Buffer.from(att.data, "base64"));

              const mediaUrl = `/media/${fileName}`;
              mediaUrls.push(`[${att.name || "Attachment"}: ${mediaUrl}]`);
              if (att.type?.startsWith("image/")) imageUrls.push(mediaUrl);

              attachments.push({
                type: att.type?.startsWith("image/") ? "image" : "file",
                mimeType: att.type || "application/octet-stream",
                fileName: att.name || fileName,
                content: att.data,
              });
            }

            const msgText = caption
              ? `${caption}\n${mediaUrls.join("\n")}`
              : `${msg.attachments.length} attachment(s)\n${mediaUrls.join("\n")}`;
            saveMessage({
              role: "user",
              text: msgText,
              images: imageUrls.length > 0 ? imageUrls : undefined,
            });

            if (sharedGwConnected) {
              sharedSendToGateway(msgText, attachments);
            } else {
              clientWs._pendingMessages.push({ text: msgText, attachments });
            }
            secureSend(JSON.stringify({ type: "attachments_sent", count: msg.attachments.length }));
          } catch (err) {
            console.error(`[${visitorId}] Attachments error:`, err.message);
            secureSend(
              JSON.stringify({ type: "attachments_error", error: "Failed to process attachments" }),
            );
          }
        }

        // ── Encrypted Resource Fetch ──
        if (msg.type === "fetch_resource" && msg.url) {
          try {
            const urlPath = msg.url.split("?")[0];
            let resolved;
            if (urlPath.startsWith("/media/")) {
              resolved = path.resolve(path.join(MEDIA_DIR, path.basename(urlPath)));
              if (!resolved.startsWith(path.resolve(MEDIA_DIR))) {
                secureSend(
                  JSON.stringify({ type: "resource_error", url: msg.url, error: "Forbidden" }),
                );
                return;
              }
            } else if (urlPath.startsWith("/custom/")) {
              const filename = path.basename(urlPath);
              if (!filename.match(/^[\w.-]+$/) || filename.startsWith(".")) {
                secureSend(
                  JSON.stringify({ type: "resource_error", url: msg.url, error: "Forbidden" }),
                );
                return;
              }
              resolved = path.resolve(path.join(DATA_DIR, filename));
              if (!resolved.startsWith(path.resolve(DATA_DIR))) {
                secureSend(
                  JSON.stringify({ type: "resource_error", url: msg.url, error: "Forbidden" }),
                );
                return;
              }
            } else {
              resolved = path.resolve(path.join(PUBLIC_DIR, urlPath));
              if (!resolved.startsWith(PUBLIC_DIR)) {
                secureSend(
                  JSON.stringify({ type: "resource_error", url: msg.url, error: "Forbidden" }),
                );
                return;
              }
            }
            if (!fs.existsSync(resolved)) {
              secureSend(
                JSON.stringify({ type: "resource_error", url: msg.url, error: "Not found" }),
              );
            } else {
              const data = fs.readFileSync(resolved).toString("base64");
              const ext = path.extname(resolved).toLowerCase();
              const mimeTypes = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
                ".mp3": "audio/mpeg",
                ".webm": "audio/webm",
              };
              secureSend(
                JSON.stringify({
                  type: "resource_data",
                  url: msg.url,
                  data,
                  mimeType: mimeTypes[ext] || "application/octet-stream",
                }),
              );
            }
          } catch (err) {
            secureSend(
              JSON.stringify({ type: "resource_error", url: msg.url, error: err.message }),
            );
          }
          return;
        }

        // ── Barge-in (TTS interruption) ──
        if (msg.type === "barge_in" && msg.runId) {
          clientWs._ttsSuppressedRuns.add(msg.runId);
          return;
        }

        // ── Heartbeat ──
        if (msg.type === "ping") {
          secureSend(JSON.stringify({ type: "pong" }));
          return;
        }

        // ── Voice Mode Toggle ──
        if (msg.type === "voice_mode") {
          clientWs._voiceMode = !!msg.enabled;
          return;
        }

        // ── Avatar State Sync ──
        if (msg.type === "avatar_state" && msg.state) {
          sharedAvatarState = msg.state;
          broadcastExcept({ type: "avatar_state", state: msg.state }, clientWs);
          return;
        }

        // ── Widget Response ──
        if (msg.type === "widget_response") {
          const { id, widget, value, action } = msg;
          saveWidgetResponse(id, { value, action });
          const widgetResponse = `[WIDGET_RESPONSE:${JSON.stringify({ id, widget, value, action })}]`;
          if (sharedGwConnected) {
            sharedSendToGateway(widgetResponse);
          }
          return;
        }

        // ── Reverify Result ──
        if (msg.type === "reverify_result") {
          const resultText = msg.verified
            ? `[REVERIFY:OK:${msg.requestId || ""}]`
            : `[REVERIFY:FAIL:${msg.requestId || ""}]`;
          if (sharedGwConnected) {
            sharedSendToGateway(resultText);
          }
          return;
        }

        // ── Audio (STT) ──
        if (msg.type === "audio" && msg.data) {
          try {
            const audioBuffer = Buffer.from(msg.data, "base64");
            const transcription = await transcribeAudio(audioBuffer);

            const trimmed = (transcription || "").trim();
            const isNoise = /^\(.*\)$/.test(trimmed) || /^\[.*\]$/.test(trimmed);
            const isBlank = !transcription || isNoise || trimmed.length < 2;

            secureSend(
              JSON.stringify({ type: "transcription", text: isBlank ? "" : transcription }),
            );

            if (!isBlank) {
              saveMessage({ role: "user", text: transcription });
              if (sharedGwConnected) {
                sharedSendToGateway(transcription);
              }
            }
          } catch (err) {
            console.error(`[${visitorId}] STT error:`, err.message);
            secureSend(JSON.stringify({ type: "stt_error", error: "Failed to transcribe audio" }));
          }
        }
      } catch (e) {
        console.error(`[${visitorId}] Client message error:`, e.message);
      }
    });

    clientWs.on("close", () => {
      sharedClients.delete(clientWs);
      clearInterval(pingInterval);
      auditLog("ws_close", { visitorId });
    });
  });

  return wss;
}
