/**
 * Streaming Delta Test - verifies message handling across tool calls
 * 
 * Uses mocked gateway and bypasses auth for simplicity.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';

// Simple mock server that simulates ClawTime's message handling logic
describe('Streaming Delta Handling', () => {
  let server, wss;
  const PORT = 19600;
  
  // Simulated ClawTime state
  let currentBotMessageId = null;
  let expectingNewMessage = true;
  let lastSentText = '';
  let lastBlockText = '';
  let accumulatedText = '';

  // Reset state between tests
  function resetState() {
    currentBotMessageId = null;
    expectingNewMessage = true;
    lastSentText = '';
    lastBlockText = '';
    accumulatedText = '';
  }

  // Simulate the message processing logic from websocket.js + store.js
  function processGatewayMessage(payload) {
    const { state, message } = payload;
    const text = message?.content?.find(b => b.type === 'text')?.text || '';
    
    // Assign messageId based on message flow
    let messageId;
    if (expectingNewMessage || !currentBotMessageId) {
      messageId = crypto.randomUUID();
      currentBotMessageId = messageId;
      expectingNewMessage = false;
      lastSentText = '';
      lastBlockText = '';
      accumulatedText = '';
    } else {
      messageId = currentBotMessageId;
    }
    
    // Store logic: accumulate across blocks
    const isContinuation = text.startsWith(lastBlockText) || lastBlockText.startsWith(text);
    
    if (accumulatedText === '') {
      // First text
      accumulatedText = text;
      lastBlockText = text;
    } else if (isContinuation) {
      // Same block - update with longer
      const longerText = text.length > lastBlockText.length ? text : lastBlockText;
      const baseText = accumulatedText.slice(0, accumulatedText.length - lastBlockText.length);
      accumulatedText = baseText + longerText;
      lastBlockText = longerText;
    } else {
      // New block - append
      const separator = accumulatedText ? '\n\n' : '';
      accumulatedText = accumulatedText + separator + text;
      lastBlockText = text;
    }
    
    // Compute delta
    let deltaText = '';
    if (accumulatedText.startsWith(lastSentText)) {
      deltaText = accumulatedText.slice(lastSentText.length);
    } else {
      deltaText = accumulatedText;
    }
    lastSentText = accumulatedText;
    
    if (state === 'final') {
      expectingNewMessage = true;
      lastSentText = '';
    }
    
    return { messageId, deltaText, accumulatedText, state };
  }

  // Simulate user sending message
  function simulateUserMessage() {
    expectingNewMessage = true;
  }

  beforeAll(() => {
    server = http.createServer();
    wss = new WebSocketServer({ server });
    server.listen(PORT);
  });

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('single block: deltas are incremental with consistent messageId', () => {
    resetState();
    
    // Simulate cumulative streaming
    const r1 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Hello' }] } });
    const r2 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Hello world' }] } });
    const r3 = processGatewayMessage({ state: 'final', message: { content: [{ type: 'text', text: 'Hello world!' }] } });
    
    // Same messageId
    expect(r1.messageId).toBe(r2.messageId);
    expect(r2.messageId).toBe(r3.messageId);
    
    // Deltas are incremental
    expect(r1.deltaText).toBe('Hello');
    expect(r2.deltaText).toBe(' world');
    expect(r3.deltaText).toBe('!');
    
    // Accumulated text is correct
    expect(r3.accumulatedText).toBe('Hello world!');
  });

  test('multiple blocks (tool call): text accumulates with same messageId', () => {
    resetState();
    
    // Block 1: before tool call
    const r1 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Part one' }] } });
    const r2 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Part one.' }] } });
    
    // Block 2: after tool call (gateway resets cumulative)
    const r3 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Part two' }] } });
    const r4 = processGatewayMessage({ state: 'final', message: { content: [{ type: 'text', text: 'Part two.' }] } });
    
    // Same messageId throughout
    expect(r1.messageId).toBe(r2.messageId);
    expect(r2.messageId).toBe(r3.messageId);
    expect(r3.messageId).toBe(r4.messageId);
    
    // Block 2 delta includes separator + new text
    expect(r3.deltaText).toBe('\n\nPart two');
    
    // Final accumulated has both parts
    expect(r4.accumulatedText).toBe('Part one.\n\nPart two.');
  });

  test('new user message gets new messageId', () => {
    resetState();
    
    // First response
    const r1 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Response one' }] } });
    const r2 = processGatewayMessage({ state: 'final', message: { content: [{ type: 'text', text: 'Response one' }] } });
    
    // User sends new message
    simulateUserMessage();
    
    // Second response
    const r3 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Response two' }] } });
    const r4 = processGatewayMessage({ state: 'final', message: { content: [{ type: 'text', text: 'Response two' }] } });
    
    // Different messageIds for different responses
    expect(r1.messageId).toBe(r2.messageId);
    expect(r3.messageId).toBe(r4.messageId);
    expect(r1.messageId).not.toBe(r3.messageId);
  });

  test('after final, next delta starts new message', () => {
    resetState();
    
    // First message
    const r1 = processGatewayMessage({ state: 'final', message: { content: [{ type: 'text', text: 'Done' }] } });
    
    // Next delta (new message without explicit user message)
    const r2 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'New' }] } });
    
    expect(r1.messageId).not.toBe(r2.messageId);
  });

  test('three blocks accumulate correctly', () => {
    resetState();
    
    // Block 1
    processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'First' }] } });
    
    // Block 2 (reset)
    processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Second' }] } });
    
    // Block 3 (reset again)
    const r = processGatewayMessage({ state: 'final', message: { content: [{ type: 'text', text: 'Third' }] } });
    
    expect(r.accumulatedText).toBe('First\n\nSecond\n\nThird');
  });

  test('empty text blocks are handled', () => {
    resetState();
    
    const r1 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: '' }] } });
    const r2 = processGatewayMessage({ state: 'delta', message: { content: [{ type: 'text', text: 'Hello' }] } });
    
    expect(r1.messageId).toBe(r2.messageId);
    expect(r2.accumulatedText).toBe('Hello');
  });
});
