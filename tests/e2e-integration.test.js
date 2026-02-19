/**
 * E2E Integration Tests with Mock Gateway WebSocket
 * 
 * Tests the complete flow:
 *   1. Mock gateway WebSocket server simulates OpenClaw gateway
 *   2. ClawTime server connects to mock gateway
 *   3. Test clients connect to ClawTime via WebSocket
 *   4. Full message round-trip testing
 * 
 * IMPORTANT: Environment must be set up BEFORE importing ClawTime modules.
 */

import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'http';
import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════════════════
// Test Configuration - SET BEFORE ANY CLAWTIME IMPORTS
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_GW_PORT = 19100 + Math.floor(Math.random() * 100);
const CLAWTIME_PORT = 19200 + Math.floor(Math.random() * 100);
const TEST_SESSION_KEY = 'agent:main:main';
const TEST_GW_TOKEN = 'test-gateway-token';
const TEST_DATA_DIR = '/tmp/clawtime-test-' + Date.now();

// Create test data directory BEFORE setting env vars
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(TEST_DATA_DIR, 'avatars'), { recursive: true });
fs.writeFileSync(path.join(TEST_DATA_DIR, 'credentials.json'), '[]');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'messages.json'), '[]');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), '{}');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'pending-runids.json'), '{}');
fs.writeFileSync(path.join(TEST_DATA_DIR, 'config.json'), '{"selectedAvatar":"lobster"}');
fs.writeFileSync(path.join(TEST_DATA_DIR, '.env'), `RPID=localhost\nORIGIN=http://localhost:${CLAWTIME_PORT}`);

// SET ENV VARS - these MUST be set before config.js is loaded
process.env.PORT = String(CLAWTIME_PORT);
process.env.CLAWTIME_DATA_DIR = TEST_DATA_DIR;
process.env.GATEWAY_URL = `ws://127.0.0.1:${MOCK_GW_PORT}`;
process.env.GATEWAY_TOKEN = TEST_GW_TOKEN;
process.env.SESSION_KEY = TEST_SESSION_KEY;
process.env.BOT_NAME = 'TestBot';
process.env.BOT_EMOJI = '🤖';

// ═══════════════════════════════════════════════════════════════════════════════
// Mock Gateway Server
// ═══════════════════════════════════════════════════════════════════════════════

class MockGateway {
  constructor() {
    this.wss = null;
    this.server = null;
    this.clients = new Set();
    this.chatEventHandlers = [];
    this.lastReceivedMessage = null;
    this.trackedRunIds = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        
        // Send connect challenge
        ws.send(JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { challenge: crypto.randomBytes(16).toString('hex') }
        }));

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            this._handleMessage(ws, msg);
          } catch (e) {
            console.error('[MockGW] Parse error:', e.message);
          }
        });

        ws.on('close', () => {
          this.clients.delete(ws);
        });
      });

      this.server.on('error', reject);
      this.server.listen(MOCK_GW_PORT, '127.0.0.1', () => {
        console.log(`[MockGW] Listening on ${MOCK_GW_PORT}`);
        resolve();
      });
    });
  }

  _handleMessage(ws, msg) {
    // Handle connect request
    if (msg.type === 'req' && msg.method === 'connect') {
      ws.send(JSON.stringify({
        type: 'res',
        id: msg.id,
        ok: true,
        payload: { type: 'hello-ok' }
      }));
      return;
    }

    // Handle chat.send
    if (msg.type === 'req' && msg.method === 'chat.send') {
      const runId = crypto.randomUUID();
      this.trackedRunIds.add(runId);
      this.lastReceivedMessage = {
        text: msg.params?.message,
        attachments: msg.params?.attachments,
        sessionKey: msg.params?.sessionKey,
        runId
      };
      
      ws.send(JSON.stringify({
        type: 'res',
        id: msg.id,
        ok: true,
        payload: { runId }
      }));

      // Notify handlers
      for (const handler of this.chatEventHandlers) {
        handler(this.lastReceivedMessage);
      }
      return;
    }
  }

  sendChatEvent(payload) {
    const event = {
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: TEST_SESSION_KEY,
        ...payload
      }
    };
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  onChatReceived(handler) {
    this.chatEventHandlers.push(handler);
  }
  
  clearHandlers() {
    this.chatEventHandlers = [];
  }

  stop() {
    return new Promise((resolve) => {
      for (const ws of this.clients) {
        ws.close();
      }
      this.clients.clear();
      if (this.wss) {
        this.wss.close(() => {
          if (this.server) {
            this.server.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Client
// ═══════════════════════════════════════════════════════════════════════════════

class TestClient {
  constructor() {
    this.ws = null;
    this.receivedMessages = [];
    this.sessionToken = null;
    this.e2eReady = false;
    this.handlers = new Map();
    this.clientECDH = null;
    this.e2eKey = null;
  }

  async connect(sessionToken) {
    this.sessionToken = sessionToken;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${CLAWTIME_PORT}`, {
        headers: { 'Origin': `http://127.0.0.1:${CLAWTIME_PORT}` }
      });

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 5000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      });

      this.ws.on('message', (raw) => {
        this._handleMessage(raw, resolve, reject);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _handleMessage(raw, connectResolve, connectReject) {
    try {
      let msgStr = raw.toString();
      
      if (this.e2eReady && this.e2eKey) {
        const parsed = JSON.parse(msgStr);
        if (parsed._e2e) {
          msgStr = this._decrypt(parsed);
        }
      }
      
      const msg = JSON.parse(msgStr);
      this.receivedMessages.push(msg);

      if (msg.type === 'auth_ok' && msg.serverPublicKey) {
        this.clientECDH = crypto.createECDH('prime256v1');
        this.clientECDH.generateKeys();
        
        const serverPubBuf = Buffer.from(msg.serverPublicKey, 'base64');
        const sharedSecret = this.clientECDH.computeSecret(serverPubBuf);
        this.e2eKey = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, 'clawtime-e2e-salt', 'clawtime-e2e-key', 32));
        
        this.ws.send(JSON.stringify({
          type: 'e2e_key',
          clientPublicKey: this.clientECDH.getPublicKey('base64')
        }));
        return;
      }

      if (msg.type === 'e2e_ready') {
        this.e2eReady = true;
        if (connectResolve) connectResolve();
        return;
      }

      if (msg.type === 'auth_fail') {
        if (connectReject) connectReject(new Error('Auth failed'));
        return;
      }

      const handler = this.handlers.get(msg.type);
      if (handler) handler(msg);
    } catch (e) {
      console.error('[TestClient] Parse error:', e.message);
    }
  }

  _decrypt(msg) {
    const iv = Buffer.from(msg.iv, 'base64');
    const tag = Buffer.from(msg.tag, 'base64');
    const data = Buffer.from(msg.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.e2eKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  _encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.e2eKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      _e2e: true,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: enc.toString('base64')
    });
  }

  send(msg) {
    const data = JSON.stringify(msg);
    if (this.e2eReady && this.e2eKey) {
      this.ws.send(this._encrypt(data));
    } else {
      this.ws.send(data);
    }
  }

  on(type, handler) {
    this.handlers.set(type, handler);
  }

  waitFor(type, timeout = 5000) {
    // Check if already received
    const existing = this.receivedMessages.find(m => m.type === type);
    if (existing) return Promise.resolve(existing);
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeout);

      this.on(type, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E Integration Tests', () => {
  let mockGateway;
  let clawTimeServer;
  let sessions;

  beforeAll(async () => {
    // Start mock gateway FIRST
    mockGateway = new MockGateway();
    await mockGateway.start();
    
    // Small delay to ensure gateway is fully ready
    await new Promise(r => setTimeout(r, 100));

    // NOW import ClawTime modules (after env vars are set)
    const stateModule = await import(path.join(PROJECT_ROOT, 'src/state.js'));
    sessions = stateModule.sessions;
    
    const routesModule = await import(path.join(PROJECT_ROOT, 'src/routes.js'));
    const websocketModule = await import(path.join(PROJECT_ROOT, 'src/websocket.js'));
    
    // Start ClawTime server
    clawTimeServer = http.createServer(routesModule.handleRequest);
    websocketModule.setupWebSocket(clawTimeServer);
    
    await new Promise((resolve, reject) => {
      clawTimeServer.on('error', reject);
      clawTimeServer.listen(CLAWTIME_PORT, '127.0.0.1', resolve);
    });
    
    console.log(`[Test] ClawTime on ${CLAWTIME_PORT}, MockGW on ${MOCK_GW_PORT}`);
    
    // Wait for gateway connection to establish
    await new Promise(r => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    if (clawTimeServer) {
      await new Promise(resolve => clawTimeServer.close(resolve));
    }
    if (mockGateway) {
      await mockGateway.stop();
    }
    
    // Cleanup test data
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }, 10000);

  beforeEach(() => {
    mockGateway?.clearHandlers();
  });

  function createSession() {
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, {
      created: Date.now(),
      userId: 'test-user',
      ip: '127.0.0.1'
    });
    return token;
  }

  describe('Connection Flow', () => {
    test('should authenticate and establish E2E encryption', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      
      expect(client.e2eReady).toBe(true);
      expect(client.e2eKey).toBeDefined();
      expect(client.receivedMessages.some(m => m.type === 'auth_ok')).toBe(true);
      expect(client.receivedMessages.some(m => m.type === 'e2e_ready')).toBe(true);
      
      client.close();
    });

    test('should reject invalid session token', async () => {
      const client = new TestClient();
      
      await expect(client.connect('invalid-token')).rejects.toThrow('Auth failed');
      
      client.close();
    });

    test('should receive connected status when gateway is ready', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      
      // Wait for connected message
      await new Promise(r => setTimeout(r, 300));
      
      const connectedMsg = client.receivedMessages.find(m => m.type === 'connected');
      expect(connectedMsg).toBeDefined();
      expect(connectedMsg.avatarState).toBeDefined();
      
      client.close();
    });
  });

  describe('Message Flow', () => {
    test('should send message to gateway and receive response', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      // Set up handler for gateway message receipt
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Hello gateway!') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'Hello gateway!' });
      
      const received = await messageReceived;
      expect(received.text).toBe('Hello gateway!');
      expect(received.runId).toBeDefined();
      
      // Gateway sends response
      const chatPromise = client.waitFor('chat', 3000);
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: {
          content: [{ type: 'text', text: 'Hello from the agent!' }]
        }
      });
      
      const chatMsg = await chatPromise;
      expect(chatMsg.type).toBe('chat');
      expect(chatMsg.text).toBe('Hello from the agent!');
      expect(chatMsg.state).toBe('final');
      
      client.close();
    }, 10000);

    test('should handle streaming delta messages', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Stream test') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'Stream test' });
      const received = await messageReceived;
      
      const chats = [];
      client.on('chat', msg => chats.push(msg));
      
      // Send deltas
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'delta',
        message: { content: [{ type: 'text', text: 'Part 1' }] }
      });
      
      await new Promise(r => setTimeout(r, 100));
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'delta',
        message: { content: [{ type: 'text', text: 'Part 1 Part 2' }] }
      });
      
      await new Promise(r => setTimeout(r, 100));
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'Part 1 Part 2 Final' }] }
      });
      
      await new Promise(r => setTimeout(r, 300));
      
      expect(chats.length).toBeGreaterThanOrEqual(2);
      expect(chats.some(d => d.state === 'delta')).toBe(true);
      expect(chats.some(d => d.state === 'final')).toBe(true);
      
      client.close();
    }, 10000);

    test('should skip NO_REPLY messages', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'No reply test') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'No reply test' });
      const received = await messageReceived;
      
      const chats = [];
      client.on('chat', msg => chats.push(msg));
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'NO_REPLY' }] }
      });
      
      await new Promise(r => setTimeout(r, 300));
      
      expect(chats.length).toBe(0);
      
      client.close();
    });

    test('should skip HEARTBEAT_OK messages', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Heartbeat test') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'Heartbeat test' });
      const received = await messageReceived;
      
      const chats = [];
      client.on('chat', msg => chats.push(msg));
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'HEARTBEAT_OK' }] }
      });
      
      await new Promise(r => setTimeout(r, 300));
      
      expect(chats.length).toBe(0);
      
      client.close();
    });
  });

  describe('Avatar State Sync', () => {
    test('should sync avatar state across clients', async () => {
      const token1 = createSession();
      const token2 = createSession();
      const client1 = new TestClient();
      const client2 = new TestClient();
      
      await client1.connect(token1);
      await client2.connect(token2);
      await new Promise(r => setTimeout(r, 500));
      
      const avatarPromise = client2.waitFor('avatar_state', 2000);
      
      client1.send({ type: 'avatar_state', state: 'happy' });
      
      const avatarMsg = await avatarPromise;
      expect(avatarMsg.state).toBe('happy');
      
      client1.close();
      client2.close();
    });

    test('should set avatar to working on tool_use', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Tool test') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'Tool test' });
      const received = await messageReceived;
      
      const avatarPromise = client.waitFor('avatar_state', 2000);
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'delta',
        message: {
          content: [
            { type: 'tool_use', name: 'exec' },
            { type: 'text', text: 'Running command...' }
          ]
        }
      });
      
      const avatarMsg = await avatarPromise;
      expect(avatarMsg.state).toBe('working');
      
      client.close();
    });

    test('should reset avatar to idle on final', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Final test') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'Final test' });
      const received = await messageReceived;
      
      // First set to working
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'delta',
        message: {
          content: [
            { type: 'tool_use', name: 'exec' },
            { type: 'text', text: 'Working...' }
          ]
        }
      });
      
      await new Promise(r => setTimeout(r, 150));
      
      // Clear previous messages so we can detect new ones
      const avatarStates = [];
      client.on('avatar_state', msg => avatarStates.push(msg.state));
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'Done!' }] }
      });
      
      await new Promise(r => setTimeout(r, 300));
      
      expect(avatarStates).toContain('idle');
      
      client.close();
    });
  });

  describe('Widget Handling', () => {
    test('should extract and broadcast widgets', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Widget test') resolve(msg);
        });
      });

      client.send({ type: 'send', text: 'Widget test' });
      const received = await messageReceived;
      
      const widgetPromise = client.waitFor('widget', 2000);
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: {
          content: [{
            type: 'text',
            text: 'Choose: [[WIDGET:{"widget":"buttons","id":"btn1","options":["A","B","C"]}]]'
          }]
        }
      });
      
      const widgetMsg = await widgetPromise;
      expect(widgetMsg.widget).toBe('buttons');
      expect(widgetMsg.id).toBe('btn1');
      expect(widgetMsg.options).toEqual(['A', 'B', 'C']);
      
      client.close();
    });

    test('should send widget response to gateway', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 500));
      
      const widgetResponseReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text && msg.text.includes('WIDGET_RESPONSE')) resolve(msg);
        });
      });
      
      client.send({
        type: 'widget_response',
        id: 'btn1',
        widget: 'buttons',
        value: 'A',
        action: 'submit'
      });
      
      const received = await widgetResponseReceived;
      expect(received.text).toContain('WIDGET_RESPONSE');
      expect(received.text).toContain('btn1');
      expect(received.text).toContain('"value":"A"');
      
      client.close();
    });
  });

  describe('History', () => {
    test('should return message history', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const historyPromise = client.waitFor('history', 2000);
      
      client.send({ type: 'get_history' });
      
      const historyMsg = await historyPromise;
      expect(historyMsg.type).toBe('history');
      expect(Array.isArray(historyMsg.messages)).toBe(true);
      
      client.close();
    });
  });

  describe('Multi-Client', () => {
    test('should broadcast user messages to other clients', async () => {
      const token1 = createSession();
      const token2 = createSession();
      const client1 = new TestClient();
      const client2 = new TestClient();
      
      await client1.connect(token1);
      await client2.connect(token2);
      await new Promise(r => setTimeout(r, 500));
      
      const userMsgPromise = client2.waitFor('user_message', 2000);
      
      client1.send({ type: 'send', text: 'Hello from client 1' });
      
      const userMsg = await userMsgPromise;
      expect(userMsg.text).toBe('Hello from client 1');
      
      client1.close();
      client2.close();
    });

    test('should broadcast agent responses to all clients', async () => {
      const token1 = createSession();
      const token2 = createSession();
      const client1 = new TestClient();
      const client2 = new TestClient();
      
      await client1.connect(token1);
      await client2.connect(token2);
      await new Promise(r => setTimeout(r, 500));
      
      const messageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.text === 'Broadcast test') resolve(msg);
        });
      });

      client1.send({ type: 'send', text: 'Broadcast test' });
      const received = await messageReceived;
      
      const chat1Promise = client1.waitFor('chat', 2000);
      const chat2Promise = client2.waitFor('chat', 2000);
      
      mockGateway.sendChatEvent({
        runId: received.runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'Response for all!' }] }
      });
      
      const [chat1, chat2] = await Promise.all([chat1Promise, chat2Promise]);
      expect(chat1.text).toBe('Response for all!');
      expect(chat2.text).toBe('Response for all!');
      
      client1.close();
      client2.close();
    });
  });

  describe('Ping/Pong', () => {
    test('should respond to ping with pong', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const pongPromise = client.waitFor('pong', 2000);
      
      client.send({ type: 'ping' });
      
      const pong = await pongPromise;
      expect(pong.type).toBe('pong');
      
      client.close();
    });
  });

  describe('Images', () => {
    test('should handle image upload', async () => {
      const token = createSession();
      const client = new TestClient();
      
      await client.connect(token);
      await new Promise(r => setTimeout(r, 200));
      
      const imageReceived = new Promise(resolve => {
        mockGateway.onChatReceived(msg => {
          if (msg.attachments && msg.attachments.length > 0) resolve(msg);
        });
      });

      const imageSentPromise = client.waitFor('image_sent', 2000);
      
      // Send a tiny 1x1 PNG
      const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      client.send({ type: 'image', data: tinyPng, caption: 'Test image' });
      
      const [received, imageSent] = await Promise.all([imageReceived, imageSentPromise]);
      
      expect(imageSent.type).toBe('image_sent');
      expect(received.attachments).toHaveLength(1);
      expect(received.attachments[0].type).toBe('image');
      
      client.close();
    });
  });
});
