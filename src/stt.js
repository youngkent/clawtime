// ═══════════════════════════════════════════════════════════════════════════════
// § 9. SPEECH-TO-TEXT (STT) via whisper-transcribe (whisper.cpp)
//
// This is the server-side fallback for browsers without SpeechRecognition API.
// The client records audio via MediaRecorder and sends it as base64 over WS.
// ═══════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MEDIA_DIR } from './config.js';

const execFileAsync = promisify(execFile);

export async function transcribeAudio(audioBuffer) {
  const id = crypto.randomBytes(8).toString('hex');
  const tmpFile = path.join(MEDIA_DIR, `stt-${id}.webm`);
  fs.writeFileSync(tmpFile, audioBuffer);
  try {
    const { stdout } = await execFileAsync('whisper-transcribe', [tmpFile], { timeout: 30000 });
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Periodic cleanup of old temp files (>30 min) to prevent disk fill
setInterval(() => {
  for (const dir of [MEDIA_DIR]) {
    try {
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const f of files) {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 30 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      }
    } catch {}
  }
}, 5 * 60 * 1000);
