/**
 * Minimal E2E test - debug message flow
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Ports
const MOCK_GW_PORT = 19400;
const CLAWTIME_PORT = 19401;
const TEST_DATA_DIR = "/tmp/clawtime-minimal-" + Date.now();

// Setup env BEFORE imports
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, "avatars"), { recursive: true });
fs.writeFileSync(path.join(TEST_DATA_DIR, "credentials.json"), "[]");
fs.writeFileSync(path.join(TEST_DATA_DIR, "messages.json"), "[]");
fs.writeFileSync(path.join(TEST_DATA_DIR, "sessions.json"), "{}");
fs.writeFileSync(path.join(TEST_DATA_DIR, "pending-runids.json"), "{}");
fs.writeFileSync(path.join(TEST_DATA_DIR, "config.json"), '{"selectedAvatar":"lobster"}');
fs.writeFileSync(
  path.join(TEST_DATA_DIR, ".env"),
  `RPID=localhost\nORIGIN=http://localhost:${CLAWTIME_PORT}`,
);

process.env.PORT = String(CLAWTIME_PORT);
process.env.CLAWTIME_DATA_DIR = TEST_DATA_DIR;
process.env.GATEWAY_URL = `ws://127.0.0.1:${MOCK_GW_PORT}`;
process.env.GATEWAY_TOKEN = "test-token";
process.env.SESSION_KEY = "agent:main:main";
process.env.BOT_NAME = "Test";
process.env.BOT_EMOJI = "🤖";

describe("Minimal E2E", () => {
  let mockGwServer, mockGwWss, clawTimeServer, sessions;
  let lastGwMessage = null;
  let gwClients = new Set();

  beforeAll(async () => {
    // 1. Start mock gateway
    mockGwServer = http.createServer();
    mockGwWss = new WebSocketServer({ server: mockGwServer });

    mockGwWss.on("connection", (ws) => {
      console.log("[MockGW] Client connected");
      gwClients.add(ws);
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge" }));

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        console.log("[MockGW] Received:", msg.method || msg.type);

        if (msg.method === "connect") {
          ws.send(
            JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { type: "hello-ok" } }),
          );
        }

        if (msg.method === "chat.send") {
          lastGwMessage = msg.params;
          const runId = crypto.randomUUID();
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { runId } }));

          // Send mock response after small delay
          setTimeout(() => {
            console.log("[MockGW] Sending chat response for runId:", runId.slice(0, 8));
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  sessionKey: "agent:main:main",
                  runId,
                  state: "final",
                  message: { content: [{ type: "text", text: "Mock response!" }] },
                },
              }),
            );
          }, 50);
        }
      });

      ws.on("close", () => gwClients.delete(ws));
    });

    await new Promise((r) => mockGwServer.listen(MOCK_GW_PORT, "127.0.0.1", r));
    console.log("[Test] MockGW on", MOCK_GW_PORT);

    // 2. Import and start ClawTime
    const stateModule = await import(path.join(PROJECT_ROOT, "src/state.js"));
    sessions = stateModule.sessions;

    const routesModule = await import(path.join(PROJECT_ROOT, "src/routes.js"));
    const websocketModule = await import(path.join(PROJECT_ROOT, "src/websocket.js"));

    clawTimeServer = http.createServer(routesModule.handleRequest);
    websocketModule.setupWebSocket(clawTimeServer);

    await new Promise((r) => clawTimeServer.listen(CLAWTIME_PORT, "127.0.0.1", r));
    console.log("[Test] ClawTime on", CLAWTIME_PORT);

    // Wait for gateway connection
    await new Promise((r) => setTimeout(r, 1000));
  }, 15000);

  afterAll(async () => {
    clawTimeServer?.close();
    mockGwWss?.close();
    mockGwServer?.close();
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {}
  }, 5000);

  test("should complete full message round-trip", async () => {
    // Create session
    const token = crypto.randomBytes(16).toString("hex");
    sessions.set(token, { created: Date.now(), userId: "test", ip: "127.0.0.1" });

    // Connect client
    const client = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`, {
      headers: { Origin: `http://127.0.0.1:${CLAWTIME_PORT}` },
    });

    const messages = [];
    let e2eKey = null;
    let clientECDH = null;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);

      client.on("open", () => {
        console.log("[Client] Connected, sending auth");
        client.send(JSON.stringify({ type: "auth", token }));
      });

      client.on("message", (raw) => {
        let msgStr = raw.toString();

        // Decrypt if needed
        try {
          const parsed = JSON.parse(msgStr);
          if (parsed._e2e && e2eKey) {
            const iv = Buffer.from(parsed.iv, "base64");
            const tag = Buffer.from(parsed.tag, "base64");
            const data = Buffer.from(parsed.data, "base64");
            const decipher = crypto.createDecipheriv("aes-256-gcm", e2eKey, iv);
            decipher.setAuthTag(tag);
            msgStr = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
          }
        } catch (e) {}

        const msg = JSON.parse(msgStr);
        console.log("[Client] Received:", msg.type);
        messages.push(msg);

        if (msg.type === "auth_ok") {
          clientECDH = crypto.createECDH("prime256v1");
          clientECDH.generateKeys();
          const serverPubBuf = Buffer.from(msg.serverPublicKey, "base64");
          const sharedSecret = clientECDH.computeSecret(serverPubBuf);
          e2eKey = Buffer.from(
            crypto.hkdfSync("sha256", sharedSecret, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
          );
          client.send(
            JSON.stringify({ type: "e2e_key", clientPublicKey: clientECDH.getPublicKey("base64") }),
          );
        }

        if (msg.type === "e2e_ready") {
          clearTimeout(timeout);
          resolve();
        }
      });

      client.on("error", reject);
    });

    console.log("[Client] E2E ready, sending message");

    // Helper to encrypt
    function encrypt(plaintext) {
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

    // Send message
    const sendMsg = JSON.stringify({ type: "send", text: "Hello from test!" });
    client.send(encrypt(sendMsg));

    // Wait for response
    const chatResponse = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log(
          "[Client] Messages received so far:",
          messages.map((m) => m.type),
        );
        reject(new Error("Timeout waiting for chat response"));
      }, 5000);

      const checkInterval = setInterval(() => {
        const chatMsg = messages.find((m) => m.type === "chat");
        if (chatMsg) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(chatMsg);
        }
      }, 100);
    });

    console.log("[Client] Got chat response:", chatResponse.text);
    expect(chatResponse.text).toBe("Mock response!");

    client.close();
  }, 15000);

  test("should save message even when client disconnects mid-response", async () => {
    // Create session
    const token = crypto.randomBytes(16).toString("hex");
    sessions.set(token, { created: Date.now(), userId: "test", ip: "127.0.0.1" });

    const client = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`, {
      headers: { Origin: `http://127.0.0.1:${CLAWTIME_PORT}` },
    });

    let e2eKey = null;
    let clientECDH = null;

    // Connect and auth
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);

      client.on("open", () => {
        client.send(JSON.stringify({ type: "auth", token }));
      });

      client.on("message", (raw) => {
        let msgStr = raw.toString();
        try {
          const parsed = JSON.parse(msgStr);
          if (parsed._e2e && e2eKey) {
            const iv = Buffer.from(parsed.iv, "base64");
            const tag = Buffer.from(parsed.tag, "base64");
            const data = Buffer.from(parsed.data, "base64");
            const decipher = crypto.createDecipheriv("aes-256-gcm", e2eKey, iv);
            decipher.setAuthTag(tag);
            msgStr = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
          }
        } catch {}

        const msg = JSON.parse(msgStr);

        if (msg.type === "auth_ok") {
          clientECDH = crypto.createECDH("prime256v1");
          clientECDH.generateKeys();
          const serverPubBuf = Buffer.from(msg.serverPublicKey, "base64");
          const sharedSecret = clientECDH.computeSecret(serverPubBuf);
          e2eKey = Buffer.from(
            crypto.hkdfSync("sha256", sharedSecret, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
          );
          client.send(
            JSON.stringify({ type: "e2e_key", clientPublicKey: clientECDH.getPublicKey("base64") }),
          );
        }

        if (msg.type === "e2e_ready") {
          clearTimeout(timeout);
          resolve();
        }
      });

      client.on("error", reject);
    });

    // Wait for gateway connection
    await new Promise((r) => setTimeout(r, 500));

    // Encrypt helper
    function encrypt(plaintext) {
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

    // Send message
    const testMessage = "Message before disconnect " + Date.now();
    client.send(encrypt(JSON.stringify({ type: "send", text: testMessage })));

    // Wait for gateway to receive and start responding
    await new Promise((r) => setTimeout(r, 200));

    // Disconnect client BEFORE response arrives
    client.close();

    // Wait for response to be processed and saved
    await new Promise((r) => setTimeout(r, 500));

    // Check that both user message and bot response are saved
    const storeModule = await import(path.join(PROJECT_ROOT, "src/store.js"));
    const messages = storeModule.getMessages(50);

    const userMsg = messages.find((m) => m.text === testMessage);
    expect(userMsg).toBeDefined();
    expect(userMsg.role).toBe("user");

    // Bot response should also be saved (even though client disconnected)
    const botMsg = messages.find((m) => m.role === "bot" && m.text === "Mock response!");
    expect(botMsg).toBeDefined();
  }, 15000);

  test("should pull missed messages on reconnect via history", async () => {
    // Use unique message text to find in existing history
    const uniqueMsg = "Reconnect test " + Date.now();

    // --- Client 1: Send message, get response, disconnect ---
    const token1 = crypto.randomBytes(16).toString("hex");
    sessions.set(token1, { created: Date.now(), userId: "test1", ip: "127.0.0.1" });

    const client1 = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`, {
      headers: { Origin: `http://127.0.0.1:${CLAWTIME_PORT}` },
    });

    let e2eKey1 = null;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Client1 connect timeout")), 5000);
      client1.on("open", () => client1.send(JSON.stringify({ type: "auth", token: token1 })));
      client1.on("message", (raw) => {
        let msgStr = raw.toString();
        try {
          const parsed = JSON.parse(msgStr);
          if (parsed._e2e && e2eKey1) {
            const decipher = crypto.createDecipheriv(
              "aes-256-gcm",
              e2eKey1,
              Buffer.from(parsed.iv, "base64"),
            );
            decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
            msgStr = Buffer.concat([
              decipher.update(Buffer.from(parsed.data, "base64")),
              decipher.final(),
            ]).toString("utf8");
          }
        } catch {}
        const msg = JSON.parse(msgStr);
        if (msg.type === "auth_ok") {
          const ecdh = crypto.createECDH("prime256v1");
          ecdh.generateKeys();
          const shared = ecdh.computeSecret(Buffer.from(msg.serverPublicKey, "base64"));
          e2eKey1 = Buffer.from(
            crypto.hkdfSync("sha256", shared, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
          );
          client1.send(
            JSON.stringify({ type: "e2e_key", clientPublicKey: ecdh.getPublicKey("base64") }),
          );
        }
        if (msg.type === "e2e_ready") {
          clearTimeout(timeout);
          resolve();
        }
      });
      client1.on("error", reject);
    });

    // Wait for gateway to be ready
    await new Promise((r) => setTimeout(r, 300));

    function encrypt1(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", e2eKey1, iv);
      const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return JSON.stringify({
        _e2e: true,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: enc.toString("base64"),
      });
    }

    // Send message
    client1.send(encrypt1(JSON.stringify({ type: "send", text: uniqueMsg })));
    await new Promise((r) => setTimeout(r, 400)); // Wait for response to be saved

    // Disconnect client1
    client1.close();
    await new Promise((r) => setTimeout(r, 100));

    // --- Client 2: Reconnects and requests history ---
    const token2 = crypto.randomBytes(16).toString("hex");
    sessions.set(token2, { created: Date.now(), userId: "test2", ip: "127.0.0.1" });

    const client2 = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`, {
      headers: { Origin: `http://127.0.0.1:${CLAWTIME_PORT}` },
    });

    let e2eKey2 = null;
    const client2Messages = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Client2 connect timeout")), 5000);
      client2.on("open", () => client2.send(JSON.stringify({ type: "auth", token: token2 })));
      client2.on("message", (raw) => {
        let msgStr = raw.toString();
        try {
          const parsed = JSON.parse(msgStr);
          if (parsed._e2e && e2eKey2) {
            const decipher = crypto.createDecipheriv(
              "aes-256-gcm",
              e2eKey2,
              Buffer.from(parsed.iv, "base64"),
            );
            decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
            msgStr = Buffer.concat([
              decipher.update(Buffer.from(parsed.data, "base64")),
              decipher.final(),
            ]).toString("utf8");
          }
        } catch {}
        const msg = JSON.parse(msgStr);
        client2Messages.push(msg);

        if (msg.type === "auth_ok") {
          const ecdh = crypto.createECDH("prime256v1");
          ecdh.generateKeys();
          const shared = ecdh.computeSecret(Buffer.from(msg.serverPublicKey, "base64"));
          e2eKey2 = Buffer.from(
            crypto.hkdfSync("sha256", shared, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
          );
          client2.send(
            JSON.stringify({ type: "e2e_key", clientPublicKey: ecdh.getPublicKey("base64") }),
          );
        }
        if (msg.type === "e2e_ready") {
          clearTimeout(timeout);
          resolve();
        }
      });
      client2.on("error", reject);
    });

    function encrypt2(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", e2eKey2, iv);
      const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return JSON.stringify({
        _e2e: true,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: enc.toString("base64"),
      });
    }

    // Request history
    client2.send(encrypt2(JSON.stringify({ type: "get_history" })));

    // Wait for history response
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("History timeout")), 3000);
      const check = setInterval(() => {
        const historyMsg = client2Messages.find((m) => m.type === "history");
        if (historyMsg) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
    });

    const historyMsg = client2Messages.find((m) => m.type === "history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.length).toBeGreaterThanOrEqual(2);

    // Find our specific message
    const userMsg = historyMsg.messages.find((m) => m.text === uniqueMsg);
    expect(userMsg).toBeDefined();
    expect(userMsg.role).toBe("user");

    // Should have bot response too
    const botResponses = historyMsg.messages.filter((m) => m.role === "bot");
    expect(botResponses.length).toBeGreaterThan(0);

    client2.close();
  }, 15000);
});
