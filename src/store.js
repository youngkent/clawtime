// ═══════════════════════════════════════════════════════════════════════════════
// § Message Store — Persistent local message history for webchat
//
// Simple append-only JSON file store. Only messages sent/received through
// the webchat interface are stored here, so history is clean (no heartbeats,
// no Telegram messages, no system events).
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './config.js';

const STORE_PATH = path.join(DATA_DIR, 'messages.json');

/**
 * Load all messages from the store file.
 * Returns an empty array if the file doesn't exist or is corrupt.
 */
export function loadMessages() {
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
 * Save a message to the store (append-only).
 * @param {{ role: 'user'|'bot', text: string, images?: string[], widget?: object, timestamp?: string }} msg
 * @returns {object} The saved message with id and timestamp
 */
export function saveMessage(msg) {
  console.log(`[store] saveMessage: role=${msg.role}, textLen=${msg.text?.length || 0}, widget=${!!msg.widget}`);
  const messages = loadMessages();
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
  messages.push(entry);
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] Failed to save message:', err.message);
  }
  return entry;
}

/**
 * Get the most recent messages from the store.
 * @param {number} [limit=200] Maximum number of messages to return
 * @returns {object[]} Array of message objects
 */
export function getMessages(limit = 200) {
  const messages = loadMessages();
  if (messages.length <= limit) return messages;
  return messages.slice(-limit);
}

/**
 * Save a widget response - updates the widget message with the response data.
 * @param {string} widgetId - The widget ID
 * @param {{ value: any, action: string }} response - The response data
 */
export function saveWidgetResponse(widgetId, response) {
  const messages = loadMessages();
  // Find the widget message (search from end since recent is most likely)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].widget && messages[i].widget.id === widgetId) {
      messages[i].widget.response = response;
      try {
        fs.writeFileSync(STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
      } catch (err) {
        console.error('[store] Failed to save widget response:', err.message);
      }
      return true;
    }
  }
  return false;
}

/**
 * Save or update a bot message by runId.
 * - If no message with this runId exists, create one
 * - If one exists, update its text/images
 * This allows saving streaming deltas so messages survive restarts.
 * 
 * @param {string} runId - The gateway runId
 * @param {{ text: string, images?: string[], final?: boolean }} data
 */
export function saveOrUpdateByRunId(runId, data) {
  const messages = loadMessages();
  const idx = messages.findIndex(m => m.runId === runId);
  
  console.log(`[store] saveOrUpdateByRunId: runId=${runId?.slice(0,8)}, exists=${idx !== -1}, final=${data.final}, textLen=${data.text?.length || 0}`);
  
  if (idx === -1) {
    // Create new message
    const entry = {
      id: crypto.randomUUID(),
      runId,
      role: 'bot',
      text: data.text || '',
      timestamp: new Date().toISOString(),
      streaming: !data.final,
    };
    if (data.images && data.images.length > 0) {
      entry.images = data.images;
    }
    messages.push(entry);
  } else {
    // Update existing message - but NEVER let shorter text overwrite longer
    const currentLen = (messages[idx].text || '').length;
    const newLen = (data.text || '').length;
    
    if (newLen >= currentLen - 10) {
      // New text is >= current (cumulative delta) — update
      messages[idx].text = data.text || '';
    } else if (data.final && newLen < currentLen * 0.5) {
      // Final is much shorter — keep existing text, just mark as final
      console.warn(`[store] Final shorter than accumulated (${newLen} vs ${currentLen}), keeping longer text`);
    } else if (data.final) {
      // Final is similar length — use it
      messages[idx].text = data.text || '';
    } else {
      console.warn(`[store] Ignoring shorter delta: ${newLen} vs ${currentLen} for runId ${runId?.slice(0,8)}`);
    }
    
    if (data.images && data.images.length > 0) {
      messages[idx].images = data.images;
    }
    if (data.final) {
      delete messages[idx].streaming;
      delete messages[idx].runId; // No longer needed after final
    }
  }
  
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(messages, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] Failed to save message:', err.message);
  }
}
