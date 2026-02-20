/**
 * Reconnection E2E tests - verify WebSocket auth and E2E encryption
 */

import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test ports - use high random to avoid conflicts
const BASE_PORT = 19800 + Math.floor(Math.random() * 100);
const MOCK_GW_PORT = BASE_PORT;
const CLAWTIME_PORT = BASE_PORT + 1;
const TEST_DATA_DIR = "/tmp/clawtime-test-" + Date.now();

// Setup test data dir
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, "avatars"), { recursive: true });
fs.writeFileSync(path.join(TEST_DATA_DIR, "credentials.json"), "[]");
fs.writeFileSync(path.join(TEST_DATA_DIR, "messages.json"), "[]");
fs.writeFileSync(path.join(TEST_DATA_DIR, "sessions.json"), "{}");
fs.writeFileSync(path.join(TEST_DATA_DIR, "pending-runids.json"), "{}");
fs.writeFileSync(path.join(TEST_DATA_DIR, "config.json"), '{"selectedAvatar":"lobster"}');

// Set env before any imports
process.env.PORT = String(CLAWTIME_PORT);
process.env.CLAWTIME_DATA_DIR = TEST_DATA_DIR;
process.env.GATEWAY_URL = `ws://127.0.0.1:${MOCK_GW_PORT}`;
process.env.GATEWAY_TOKEN = "test-token";
process.env.SESSION_KEY = "agent:main:main";
process.env.BOT_NAME = "Test";
process.env.BOT_EMOJI = "🤖";
process.env.RPID = "localhost";
process.env.ORIGIN = `http://localhost:${CLAWTIME_PORT}`;

describe("WebSocket Auth & E2E", () => {
  let mockGwServer, mockGwWss, clawTimeServer;

  beforeAll(async () => {
    // Start minimal mock gateway (just accepts connections)
    mockGwServer = http.createServer();
    mockGwWss = new WebSocketServer({ server: mockGwServer });

    mockGwWss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === "connect") {
            ws.send(
              JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { type: "hello-ok" } }),
            );
          }
          if (msg.method === "chat.send") {
            const runId = crypto.randomUUID().slice(0, 8);
            ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: { runId } }));
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "event",
                    event: "chat",
                    payload: {
                      sessionKey: "agent:main:main",
                      runId,
                      state: "final",
                      message: { content: [{ type: "text", text: "OK" }] },
                    },
                  }),
                );
              }
            }, 50);
          }
        } catch {}
      });
    });

    await new Promise((r) => mockGwServer.listen(MOCK_GW_PORT, "127.0.0.1", r));

    // Start ClawTime
    const { startServer } = await import("../server.js");
    clawTimeServer = await startServer();

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    if (clawTimeServer) clawTimeServer.close();
    if (mockGwServer) mockGwServer.close();
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {}
  });

  async function createAuthToken() {
    const { createSession } = await import("../src/state.js");
    const token = crypto.randomBytes(16).toString("hex");
    createSession(token, { visitorId: "v-" + Date.now(), createdAt: Date.now(), ip: "127.0.0.1" });
    return token;
  }

  test("WebSocket connects", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
      setTimeout(() => rej(new Error("timeout")), 2000);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("auth with valid token returns auth_ok", async () => {
    const token = await createAuthToken();
    const ws = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`);
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ type: "auth", token }));

    const msg = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 2000);
      ws.on("message", (raw) => {
        clearTimeout(t);
        res(JSON.parse(raw.toString()));
      });
    });

    expect(msg.type).toBe("auth_ok");
    expect(msg.serverPublicKey).toBeDefined();
    ws.close();
  });

  test("auth with invalid token returns auth_fail", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`);
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ type: "auth", token: "invalid" }));

    const msg = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 2000);
      ws.on("message", (raw) => {
        clearTimeout(t);
        res(JSON.parse(raw.toString()));
      });
    });

    expect(msg.type).toBe("auth_fail");
    ws.close();
  });

  test("E2E handshake completes successfully", async () => {
    const token = await createAuthToken();
    const ws = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`);
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ type: "auth", token }));

    // Get auth_ok with server public key
    const authOk = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("auth timeout")), 2000);
      ws.on("message", function h(raw) {
        const m = JSON.parse(raw.toString());
        if (m.type === "auth_ok") {
          clearTimeout(t);
          ws.off("message", h);
          res(m);
        }
      });
    });

    // Complete E2E with P-256 ECDH
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const serverPub = Buffer.from(authOk.serverPublicKey, "base64");
    const secret = ecdh.computeSecret(serverPub);
    const e2eKey = Buffer.from(
      crypto.hkdfSync("sha256", secret, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
    );

    // Decrypt helper
    const decrypt = (raw) => {
      const p = JSON.parse(raw.toString());
      if (!p._e2e) return p;
      const d = crypto.createDecipheriv("aes-256-gcm", e2eKey, Buffer.from(p.iv, "base64"));
      d.setAuthTag(Buffer.from(p.tag, "base64"));
      return JSON.parse(
        Buffer.concat([d.update(Buffer.from(p.data, "base64")), d.final()]).toString(),
      );
    };

    // Set up handler BEFORE sending e2e_key (e2e_ready is encrypted)
    const readyPromise = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("e2e timeout")), 2000);
      ws.on("message", function h(raw) {
        try {
          const m = decrypt(raw);
          if (m.type === "e2e_ready") {
            clearTimeout(t);
            ws.off("message", h);
            res(m);
          }
        } catch {}
      });
    });

    ws.send(JSON.stringify({ type: "e2e_key", clientPublicKey: ecdh.getPublicKey("base64") }));
    const ready = await readyPromise;

    expect(ready.type).toBe("e2e_ready");
    expect(e2eKey.length).toBe(32);
    ws.close();
  });

  test("encrypted message can be sent after E2E", async () => {
    const token = await createAuthToken();
    const ws = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`);
    await new Promise((r) => ws.on("open", r));

    ws.send(JSON.stringify({ type: "auth", token }));

    // Get auth_ok
    const authOk = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 2000);
      ws.on("message", function h(raw) {
        const m = JSON.parse(raw.toString());
        if (m.type === "auth_ok") {
          clearTimeout(t);
          ws.off("message", h);
          res(m);
        }
      });
    });

    // E2E handshake
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const secret = ecdh.computeSecret(Buffer.from(authOk.serverPublicKey, "base64"));
    const e2eKey = Buffer.from(
      crypto.hkdfSync("sha256", secret, "clawtime-e2e-salt", "clawtime-e2e-key", 32),
    );

    // Decrypt helper
    const decrypt = (raw) => {
      const p = JSON.parse(raw.toString());
      if (!p._e2e) return p;
      const d = crypto.createDecipheriv("aes-256-gcm", e2eKey, Buffer.from(p.iv, "base64"));
      d.setAuthTag(Buffer.from(p.tag, "base64"));
      return JSON.parse(
        Buffer.concat([d.update(Buffer.from(p.data, "base64")), d.final()]).toString(),
      );
    };

    // Set up handler BEFORE sending e2e_key (e2e_ready is encrypted)
    const readyPromise = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 3000);
      ws.on("message", function h(raw) {
        try {
          const m = decrypt(raw);
          if (m.type === "e2e_ready" || m.type === "connected") {
            clearTimeout(t);
            ws.off("message", h);
            res(m);
          }
        } catch {}
      });
    });

    ws.send(JSON.stringify({ type: "e2e_key", clientPublicKey: ecdh.getPublicKey("base64") }));
    await readyPromise;

    // Send encrypted message
    const encrypt = (obj) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", e2eKey, iv);
      const enc = Buffer.concat([cipher.update(JSON.stringify(obj)), cipher.final()]);
      return JSON.stringify({
        _e2e: true,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: enc.toString("base64"),
      });
    };

    ws.send(encrypt({ type: "send", text: "Hello" }));

    // Should get avatar_state back (encrypted)
    const response = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("response timeout")), 3000);
      ws.on("message", function h(raw) {
        try {
          const dec = decrypt(raw);
          if (dec.type === "avatar_state") {
            clearTimeout(t);
            ws.off("message", h);
            res(dec);
          }
        } catch {}
      });
    });

    expect(response.type).toBe("avatar_state");
    expect(response.state).toBe("thinking");
    ws.close();
  }, 10000);
});
