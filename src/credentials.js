// ═══════════════════════════════════════════════════════════════════════════════
// § 6. CREDENTIAL PERSISTENCE (WebAuthn passkeys stored as JSON)
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import { CREDENTIALS_FILE } from './config.js';

export function loadCredentials() {
  try {
    const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveCredentials(creds) {
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
