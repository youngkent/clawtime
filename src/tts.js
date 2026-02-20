// ═══════════════════════════════════════════════════════════════════════════════
// § 3. TTS (Text-to-Speech) — Server-Side via edge-tts
//
// DECISION: TTS runs server-side (not browser speechSynthesis) because:
//   • Browser TTS voices are inconsistent across platforms (robotic on many)
//   • edge-tts provides high-quality neural voices for free
//   • Audio is sent as base64 over the encrypted WebSocket — no extra HTTP fetch
//
// DECISION: Sequential queue per visitor (not parallel) because parallel
// generation caused sentences to arrive out-of-order, making speech incoherent.
// Each visitor gets their own FIFO queue processed one sentence at a time.
//
// DECISION: Sentence-by-sentence streaming — as LLM deltas arrive, we detect
// sentence boundaries (periods, exclamation marks, question marks, colons
// followed by whitespace, or newlines for bullet points). Each complete sentence
// is immediately queued for TTS generation, so the user hears speech while the
// bot is still generating text. Remaining unspoken text is flushed on 'final'.
// ═══════════════════════════════════════════════════════════════════════════════

import { exec } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TTS_DIR, TTS_COMMAND } from "./config.js";

const execAsync = promisify(exec);

export function cleanTextForTTS(text) {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_~>]/g, "")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/\s+/g, " ")
    .trim();
}

const ttsQueues = new Map(); // visitorId → { queue: Array, processing: boolean }

export function generateAndSendTTS(text, visitorId, clientWs, runId) {
  const clean = cleanTextForTTS(text).slice(0, 4000);
  if (!clean || clean.length < 3) return;

  if (!ttsQueues.has(visitorId)) {
    ttsQueues.set(visitorId, { queue: [], processing: false });
  }
  const q = ttsQueues.get(visitorId);
  q.queue.push({ clean, visitorId, clientWs, runId });
  processTTSQueue(visitorId);
}

async function processTTSQueue(visitorId) {
  const q = ttsQueues.get(visitorId);
  if (!q || q.processing || q.queue.length === 0) return;
  q.processing = true;

  while (q.queue.length > 0) {
    const { clean, clientWs, runId } = q.queue.shift();
    try {
      const ttsId = crypto.randomBytes(8).toString("hex");
      const ttsFile = `tts-${ttsId}.mp3`;
      const ttsPath = path.join(TTS_DIR, ttsFile);
      // Build command from template with secure shell escaping
      // Use POSIX single-quote method: wrap in single quotes, escape embedded single quotes as '\''
      const escapedText = clean.replace(/'/g, "'\\''");
      // Replace "{{TEXT}}" or '{{TEXT}}' or {{TEXT}} with properly quoted text
      const cmd = TTS_COMMAND.replace(/"?\{\{TEXT\}\}"?/g, "'" + escapedText + "'").replace(
        /\{\{OUTPUT\}\}/g,
        ttsPath,
      );
      await execAsync(cmd);
      if (clientWs.readyState === 1) {
        const audioBuffer = fs.readFileSync(ttsPath);
        const audioData = audioBuffer.toString("base64");
        const sendFn = clientWs._secureSend || ((d) => clientWs.send(d));
        sendFn(JSON.stringify({ type: "tts_audio", audioData, runId: runId || null }));
      }
      setTimeout(() => {
        try {
          fs.unlinkSync(ttsPath);
        } catch {
          /* ignore */
        }
      }, 30000);
    } catch (err) {
      console.error(`[${visitorId}] TTS error:`, err.message);
    }
  }

  q.processing = false;
}
