// ═══════════════════════════════════════════════════════════════════════════════
// § Message Store — Persistent local message history for webchat
//
// Simple append-only JSON file store. Only messages sent/received through
// the webchat interface are stored here, so history is clean (no heartbeats,
// no Telegram messages, no system events).
//
// Uses buffered async writes to avoid blocking the event loop during streaming.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './config.js';

const STORE_PATH = path.join(DATA_DIR, 'messages.json');
const WRITE_DEBOUNCE_MS = 200; // Batch writes within this window
const WRITE_MAX_DELAY_MS = 1000; // Force write after this delay even if still receiving

// In-memory state
let messages = null; // Lazy loaded
let writeTimer = null;
let writeForceTimer = null;
let pendingWrite = false;

/**
 * Ensure messages are loaded into memory.
 */
function ensureLoaded() {
  if (messages === null) {
    messages = loadMessagesSync();
  }
  return messages;
}

/**
 * Load all messages from the store file (sync, only used on first access).
 * Returns an empty array if the file doesn't exist or is corrupt.
 */
function loadMessagesSync() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[store] Failed to load messages:', err.message);
    return [];
  }
}

/**
 * Schedule an async write. Debounces rapid calls but ensures writes happen
 * within WRITE_MAX_DELAY_MS even under sustained load.
 */
function schedulePersist(immediate = false) {
  pendingWrite = true;
  
  // Clear existing debounce timer
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  
  if (immediate) {
    // Immediate write (for final messages, user messages, etc.)
    doPersist();
    return;
  }
  
  // Start max delay timer if not already running
  if (!writeForceTimer) {
    writeForceTimer = setTimeout(() => {
      writeForceTimer = null;
      if (pendingWrite) doPersist();
    }, WRITE_MAX_DELAY_MS);
  }
  
  // Debounce timer - resets on each call
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (pendingWrite) doPersist();
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Perform the actual async write.
 */
function doPersist() {
  if (!pendingWrite || messages === null) return;
  pendingWrite = false;
  
  // Clear timers
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (writeForceTimer) {
    clearTimeout(writeForceTimer);
    writeForceTimer = null;
  }
  
  // Async write - don't block
  const data = JSON.stringify(messages, null, 2);
  fs.writeFile(STORE_PATH, data, 'utf8', (err) => {
    if (err) {
      console.error('[store] Failed to persist messages:', err.message);
    }
  });
}

/**
 * Force immediate sync write (for shutdown).
 */
export function flushSync() {
  if (pendingWrite && messages !== null) {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
      pendingWrite = false;
    } catch (err) {
      console.error('[store] Failed to flush messages:', err.message);
    }
  }
}

/**
 * Load all messages (returns in-memory copy).
 */
export function loadMessages() {
  return ensureLoaded();
}

/**
 * Clean up incomplete messages on startup.
 * Only removes streaming flags — does NOT delete messages.
 */
export function cleanupIncompleteMessages() {
  const msgs = ensureLoaded();
  let cleaned = 0;
  
  for (const m of msgs) {
    if (m.streaming) {
      delete m.streaming;
      delete m.runId;
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[store] Cleaned ${cleaned} streaming flags on startup`);
    schedulePersist(true); // Immediate write for cleanup
  }
}

/**
 * Save a message to the store (append-only).
 * @param {{ role: 'user'|'bot', text: string, images?: string[], widget?: object, timestamp?: string }} msg
 * @returns {object} The saved message with id and timestamp
 */
export function saveMessage(msg) {
  console.log(`[store] saveMessage: role=${msg.role}, textLen=${msg.text?.length || 0}, widget=${!!msg.widget}`);
  const msgs = ensureLoaded();
  const entry = {
    id: crypto.randomUUID(),
    role: msg.role,
    text: msg.text || '',
    timestamp: msg.timestamp || new Date().toISOString(),
  };
  if (msg.images && msg.images.length > 0) {
    entry.images = msg.images;
  }
  if (msg.widget) {
    entry.widget = msg.widget;
  }
  msgs.push(entry);
  schedulePersist(true); // Immediate for user messages
  return entry;
}

/**
 * Get the most recent messages from the store.
 * @param {number} [limit=200] Maximum number of messages to return
 * @returns {object[]} Array of message objects
 */
export function getMessages(limit = 200) {
  const msgs = ensureLoaded();
  if (msgs.length <= limit) return msgs;
  return msgs.slice(-limit);
}

/**
 * Save a widget response - updates the widget message with the response data.
 * @param {string} widgetId - The widget ID
 * @param {{ value: any, action: string }} response - The response data
 */
export function saveWidgetResponse(widgetId, response) {
  const msgs = ensureLoaded();
  // Find the widget message (search from end since recent is most likely)
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].widget && msgs[i].widget.id === widgetId) {
      msgs[i].widget.response = response;
      schedulePersist(true); // Immediate for widget responses
      return true;
    }
  }
  return false;
}

/**
 * Save or update a bot message by messageId (not runId).
 * Simple: find by id, update text. No complex prefix detection needed
 * since websocket now properly tracks message boundaries.
 * 
 * @param {string} messageId - The unique message ID
 * @param {{ text: string, images?: string[], final?: boolean }} data
 */
export function saveOrUpdateByMessageId(messageId, data) {
  const msgs = ensureLoaded();
  const idx = msgs.findIndex(m => m.id === messageId);
  
  console.log(`[store] saveOrUpdateByMessageId: id=${messageId?.slice(0,8)}, exists=${idx !== -1}, final=${data.final}, textLen=${data.text?.length || 0}`);
  
  const newText = data.text || '';
  
  if (idx === -1) {
    // New message
    const entry = {
      id: messageId,
      role: 'bot',
      text: newText,
      lastBlockText: newText, // Track current block for accumulation
      timestamp: new Date().toISOString(),
      streaming: !data.final,
    };
    if (data.images && data.images.length > 0) {
      entry.images = data.images;
    }
    msgs.push(entry);
    schedulePersist(data.final);
    return { text: entry.text, images: entry.images };
  } else {
    // Update existing message
    const existingText = msgs[idx].text || '';
    const lastBlockText = msgs[idx].lastBlockText || existingText;
    
    // Check if this is a continuation of current block or a new block
    const isContinuation = newText.startsWith(lastBlockText) || lastBlockText.startsWith(newText);
    
    if (isContinuation) {
      // Same block — update with longer text
      const longerText = newText.length > lastBlockText.length ? newText : lastBlockText;
      // Replace just the last block portion
      const baseText = existingText.slice(0, existingText.length - lastBlockText.length);
      msgs[idx].text = baseText + longerText;
      msgs[idx].lastBlockText = longerText;
    } else {
      // New block — append with separator
      console.log(`[store] New text block detected, appending`);
      const separator = existingText ? '\n\n' : '';
      msgs[idx].text = existingText + separator + newText;
      msgs[idx].lastBlockText = newText;
    }
    
    if (data.images && data.images.length > 0) {
      msgs[idx].images = [...(msgs[idx].images || []), ...data.images];
    }
    if (data.final) {
      delete msgs[idx].streaming;
      delete msgs[idx].lastBlockText;
    }
    schedulePersist(data.final);
    return { text: msgs[idx].text, images: msgs[idx].images };
  }
}
