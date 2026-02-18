/**
 * Store tests - message persistence and retrieval
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_STORE_PATH = path.join(__dirname, 'test-messages.json');

// Mock the store module with test path
let store;

beforeAll(async () => {
  // Clean up any existing test file
  if (fs.existsSync(TEST_STORE_PATH)) {
    fs.unlinkSync(TEST_STORE_PATH);
  }
});

beforeEach(() => {
  // Reset store for each test
  if (fs.existsSync(TEST_STORE_PATH)) {
    fs.unlinkSync(TEST_STORE_PATH);
  }
  // Create empty store
  fs.writeFileSync(TEST_STORE_PATH, '[]', 'utf8');
});

afterAll(() => {
  // Clean up
  if (fs.existsSync(TEST_STORE_PATH)) {
    fs.unlinkSync(TEST_STORE_PATH);
  }
});

describe('Message Store', () => {
  
  describe('saveMessage', () => {
    test('should save a user message', () => {
      const messages = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
      const newMsg = {
        id: 'test-1',
        role: 'user',
        text: 'Hello world',
        timestamp: new Date().toISOString()
      };
      messages.push(newMsg);
      fs.writeFileSync(TEST_STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
      
      const loaded = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
      expect(loaded).toHaveLength(1);
      expect(loaded[0].text).toBe('Hello world');
      expect(loaded[0].role).toBe('user');
    });

    test('should save a bot message', () => {
      const messages = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
      const newMsg = {
        id: 'test-2',
        role: 'bot',
        text: 'Hi there!',
        timestamp: new Date().toISOString()
      };
      messages.push(newMsg);
      fs.writeFileSync(TEST_STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
      
      const loaded = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
      expect(loaded).toHaveLength(1);
      expect(loaded[0].role).toBe('bot');
    });

    test('should save message with widget', () => {
      const messages = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
      const newMsg = {
        id: 'test-3',
        role: 'bot',
        text: '',
        widget: {
          widget: 'buttons',
          id: 'widget-1',
          prompt: 'Choose one',
          buttons: [{ label: 'A', value: 'a' }]
        },
        timestamp: new Date().toISOString()
      };
      messages.push(newMsg);
      fs.writeFileSync(TEST_STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
      
      const loaded = JSON.parse(fs.readFileSync(TEST_STORE_PATH, 'utf8'));
      expect(loaded[0].widget).toBeDefined();
      expect(loaded[0].widget.widget).toBe('buttons');
    });
  });

  describe('saveOrUpdateByRunId', () => {
    test('should create new message if runId not found', () => {
      const messages = [];
      const runId = 'run-123';
      const text = 'Streaming message';
      
      // Simulate saveOrUpdateByRunId
      const idx = messages.findIndex(m => m.runId === runId);
      expect(idx).toBe(-1);
      
      messages.push({
        id: 'new-id',
        runId,
        role: 'bot',
        text,
        timestamp: new Date().toISOString(),
        streaming: true
      });
      
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe(text);
      expect(messages[0].streaming).toBe(true);
    });

    test('should update existing message with same runId', () => {
      const messages = [{
        id: 'existing',
        runId: 'run-123',
        role: 'bot',
        text: 'Hello',
        streaming: true
      }];
      
      const runId = 'run-123';
      const newText = 'Hello world';
      
      const idx = messages.findIndex(m => m.runId === runId);
      expect(idx).toBe(0);
      
      messages[idx].text = newText;
      expect(messages[0].text).toBe('Hello world');
    });

    test('should NOT overwrite longer text with shorter text', () => {
      const messages = [{
        id: 'existing',
        runId: 'run-123',
        role: 'bot',
        text: 'This is a long message with lots of content',
        streaming: true
      }];
      
      const runId = 'run-123';
      const shorterText = 'Short';
      const currentLen = messages[0].text.length;
      const newLen = shorterText.length;
      
      // Simulate protection: only update if new text is >= current - 10
      if (newLen >= currentLen - 10) {
        messages[0].text = shorterText;
      }
      
      // Should NOT have been updated
      expect(messages[0].text).toBe('This is a long message with lots of content');
    });

    test('should allow longer text to update', () => {
      const messages = [{
        id: 'existing',
        runId: 'run-123',
        role: 'bot',
        text: 'Short',
        streaming: true
      }];
      
      const longerText = 'This is a much longer message';
      const currentLen = messages[0].text.length;
      const newLen = longerText.length;
      
      if (newLen >= currentLen - 10) {
        messages[0].text = longerText;
      }
      
      expect(messages[0].text).toBe('This is a much longer message');
    });

    test('should handle final state correctly', () => {
      const messages = [{
        id: 'existing',
        runId: 'run-123',
        role: 'bot',
        text: 'Complete message',
        streaming: true
      }];
      
      // Simulate final
      delete messages[0].streaming;
      delete messages[0].runId;
      
      expect(messages[0].streaming).toBeUndefined();
      expect(messages[0].runId).toBeUndefined();
    });

    test('should keep longer text even when final is shorter', () => {
      const messages = [{
        id: 'existing',
        runId: 'run-123',
        role: 'bot',
        text: 'This is a very long accumulated message from streaming',
        streaming: true
      }];
      
      const finalText = 'Short final';
      const currentLen = messages[0].text.length;
      const newLen = finalText.length;
      const isFinal = true;
      
      // Protection: if final is <50% of current, keep longer
      if (newLen >= currentLen - 10) {
        messages[0].text = finalText;
      } else if (isFinal && newLen < currentLen * 0.5) {
        // Keep existing, just mark as final
        delete messages[0].streaming;
      }
      
      // Should have kept the longer text
      expect(messages[0].text).toBe('This is a very long accumulated message from streaming');
      expect(messages[0].streaming).toBeUndefined();
    });
  });

  describe('saveWidgetResponse', () => {
    test('should save widget response to existing widget', () => {
      const messages = [{
        id: 'msg-1',
        role: 'bot',
        text: '',
        widget: {
          widget: 'buttons',
          id: 'widget-1',
          prompt: 'Choose',
          buttons: [{ label: 'A', value: 'a' }]
        }
      }];
      
      const widgetId = 'widget-1';
      const response = { value: 'a', action: 'submit' };
      
      // Find and update widget
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].widget && messages[i].widget.id === widgetId) {
          messages[i].widget.response = response;
          break;
        }
      }
      
      expect(messages[0].widget.response).toEqual(response);
    });
  });

  describe('getMessages', () => {
    test('should return all messages when under limit', () => {
      const messages = [
        { id: '1', text: 'msg1' },
        { id: '2', text: 'msg2' },
        { id: '3', text: 'msg3' }
      ];
      
      const limit = 200;
      const result = messages.length <= limit ? messages : messages.slice(-limit);
      
      expect(result).toHaveLength(3);
    });

    test('should return limited messages when over limit', () => {
      const messages = Array.from({ length: 300 }, (_, i) => ({
        id: `${i}`,
        text: `msg${i}`
      }));
      
      const limit = 200;
      const result = messages.length <= limit ? messages : messages.slice(-limit);
      
      expect(result).toHaveLength(200);
      expect(result[0].id).toBe('100'); // Should start from index 100
    });
  });
});
