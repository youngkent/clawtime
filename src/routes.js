// ═══════════════════════════════════════════════════════════════════════════════
// § 10. HTTP SERVER — REST API Routes
//
// Route overview:
//   GET  /api/config         — Public UI configuration (no auth)
//   POST /api/invite         — Generate invite token (localhost only)
//   POST /auth/invite-check  — Validate an invite token
//   GET  /auth/status        — Check if any passkeys are registered
//   POST /auth/session       — Validate a session token
//   GET  /auth/passkeys      — List registered passkeys (authed)
//   DELETE /auth/passkeys    — Delete a passkey (authed, can't delete last)
//   POST /auth/register-options — Begin WebAuthn registration
//   POST /auth/register-verify  — Complete WebAuthn registration
//   POST /auth/login-options    — Begin WebAuthn authentication
//   POST /auth/login-verify     — Complete WebAuthn authentication
//   POST /auth/reverify         — Re-verify identity for sensitive ops
//   GET  /api/tasks          — Read task list (authed)
//   POST /api/tasks          — Write task list (authed)
//   GET  /media/*            — Serve uploaded media files
//   GET  /tts/*              — Serve TTS audio files
//   GET  /*                  — Static file serving
// ═══════════════════════════════════════════════════════════════════════════════

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  PUBLIC_DIR,
  DATA_DIR,
  MEDIA_DIR,
  TTS_DIR,
  BOT_NAME,
  RP_NAME,
  ENABLE_TASKS,
  TASKS_FILE,
  publicConfig,
} from "./config.js";
import { loadCredentials, saveCredentials } from "./credentials.js";
import {
  getRpID,
  getExpectedOrigin,
  parseBody,
  cleanExpiredSessions,
  cleanExpiredChallenges,
  MIME,
  ipMatches,
  isSafeFilename,
} from "./helpers.js";
import { checkRateLimit, setSecurityHeaders, auditLog } from "./security.js";
import {
  sessions,
  challenges,
  inviteTokens,
  getSetupToken,
  consumeSetupToken,
  createSession,
} from "./state.js";

// Customizable files that can be overridden in DATA_DIR
const CUSTOMIZABLE = ["/avatar.js", "/styles.css"];

function getSelectedAvatar(previewMode = false) {
  try {
    const configPath = path.join(DATA_DIR, "config.json");
    const data = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(data);
    // Preview avatar takes precedence if set
    if (config.previewAvatar) return config.previewAvatar;
    return config.selectedAvatar;
  } catch (e) {
    return null;
  }
}

function getAvatarFromQuery(url) {
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.searchParams.get("avatar");
  } catch (e) {
    return null;
  }
}

function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const fileName = urlPath === "/" ? "/index.html" : urlPath;

  const ext = path.extname(fileName);
  const mime = MIME[ext] || "application/octet-stream";

  const sendFile = (filePath) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const headers = { "Content-Type": mime };
      if ([".html", ".js", ".css"].includes(ext)) {
        headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        headers["Pragma"] = "no-cache";
        headers["Expires"] = "0";
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  };

  // Special handling for avatar.js - use query param or saved preference
  // Avatars are loaded only from ~/.clawtime/avatars/ (agent copies defaults during setup)
  if (fileName === "/avatar.js") {
    const queryAvatar = getAvatarFromQuery(req.url);
    const selectedAvatar = queryAvatar || getSelectedAvatar();

    // Validate avatar name to prevent path traversal
    if (!isSafeFilename(selectedAvatar)) {
      res.writeHead(400);
      res.end("Invalid avatar");
      return;
    }

    const avatarPath = path.join(DATA_DIR, "avatars", selectedAvatar + ".js");

    if (fs.existsSync(avatarPath)) {
      sendFile(avatarPath);
    } else {
      res.writeHead(404);
      res.end("Avatar not found: " + selectedAvatar);
    }
    return;
  }

  // Check for custom override in DATA_DIR first for other customizable files
  const isCustomizable = CUSTOMIZABLE.includes(fileName);
  const customPath = isCustomizable ? path.join(DATA_DIR, fileName) : null;
  const defaultPath = path.join(PUBLIC_DIR, fileName);

  const resolved = path.resolve(defaultPath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // Validate custom path is within DATA_DIR
  if (customPath) {
    const resolvedCustom = path.resolve(customPath);
    if (!resolvedCustom.startsWith(DATA_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  }

  // Try custom path first, fall back to default
  if (customPath && fileName !== "/avatar.js") {
    fs.access(customPath, fs.constants.R_OK, (err) => {
      sendFile(err ? defaultPath : customPath);
    });
  } else {
    sendFile(defaultPath);
  }
}

export async function handleRequest(req, res) {
  const urlPath = req.url.split("?")[0];

  const json = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  try {
    setSecurityHeaders(res);

    // ── Public config endpoint ──
    if (urlPath === "/api/config" && req.method === "GET") {
      return json(200, publicConfig);
    }

    // ── Avatar selection ──
    if (urlPath === "/api/avatar/select" && req.method === "POST") {
      const { avatar } = await parseBody(req);
      if (!isSafeFilename(avatar)) {
        return json(400, { error: "Invalid avatar name" });
      }
      // Save preference to config file
      const configPath = path.join(DATA_DIR, "config.json");
      let config = {};
      try {
        const data = fs.readFileSync(configPath, "utf8");
        config = JSON.parse(data);
      } catch (e) {
        /* no existing config */
      }
      config.selectedAvatar = avatar;
      config.previewAvatar = null; // Clear preview on select
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      auditLog("avatar_selected", { avatar });
      return json(200, { success: true, avatar });
    }

    // ── Avatar preview (temporary) ──
    if (urlPath.startsWith("/api/avatar/preview") && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const avatar = url.searchParams.get("avatar");
      if (!avatar || !isSafeFilename(avatar)) {
        return json(400, { error: "Invalid avatar name" });
      }
      // Set preview avatar temporarily
      const configPath = path.join(DATA_DIR, "config.json");
      let config = {};
      try {
        const data = fs.readFileSync(configPath, "utf8");
        config = JSON.parse(data);
      } catch (e) {
        /* no existing config */
      }
      config.previewAvatar = avatar;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return json(200, { success: true, preview: avatar });
    }

    // ── Delete custom avatar ──
    if (urlPath === "/api/avatar/delete" && req.method === "POST") {
      const { avatar } = await parseBody(req);
      if (!isSafeFilename(avatar)) {
        return json(400, { error: "Invalid avatar name" });
      }
      // Check if this is the currently selected avatar
      const configPath = path.join(DATA_DIR, "config.json");
      let config = {};
      try {
        const data = fs.readFileSync(configPath, "utf8");
        config = JSON.parse(data);
      } catch (e) {
        /* no config */
      }
      if (config.selectedAvatar === avatar) {
        return json(400, { error: "Cannot delete the currently selected avatar" });
      }
      // Delete avatar file from avatars directory
      const avatarPath = path.join(DATA_DIR, "avatars", avatar + ".js");
      try {
        if (fs.existsSync(avatarPath)) {
          fs.unlinkSync(avatarPath);
        }
      } catch (e) {
        // Ignore delete errors
      }
      auditLog("avatar_deleted", { avatar });
      return json(200, { success: true });
    }

    // ── List available avatars ──
    if (urlPath === "/api/avatar/list" && req.method === "GET") {
      // Parse metadata from avatar JS file comment block:
      // /* AVATAR_META {"name": "...", "emoji": "...", "description": "...", "color": "..."} */
      const parseAvatarMeta = (filePath) => {
        try {
          const content = fs.readFileSync(filePath, "utf8").slice(0, 500); // Only read first 500 chars
          const match = content.match(/\/\*\s*AVATAR_META\s*(\{[\s\S]*?\})\s*\*\//);
          if (match) {
            return JSON.parse(match[1]);
          }
        } catch (e) {
          /* ignore parse errors */
        }
        return null;
      };

      const defaultMeta = {
        name: "Avatar",
        emoji: "🎭",
        description: "Custom avatar",
        color: "8b5cf6",
      };
      const avatars = [];

      // Scan avatars from ~/.clawtime/avatars/ only
      // (templates/avatars/ contains examples that are copied on first run)
      const avatarsDir = path.join(DATA_DIR, "avatars");
      try {
        const files = fs.readdirSync(avatarsDir);
        files.forEach((file) => {
          if (file.endsWith(".js")) {
            const id = file.replace(".js", "");
            const filePath = path.join(avatarsDir, file);
            const meta = parseAvatarMeta(filePath) || { ...defaultMeta, name: id };
            avatars.push({ id, ...meta });
          }
        });
      } catch (e) {
        /* no avatars directory */
      }

      return json(200, { avatars });
    }

    // ── Get current avatar theme (no auth required, for login page) ──
    if (urlPath === "/api/avatar/current" && req.method === "GET") {
      // Parse metadata from the selected avatar file
      const parseAvatarMeta = (filePath) => {
        try {
          const content = fs.readFileSync(filePath, "utf8").slice(0, 500);
          const match = content.match(/\/\*\s*AVATAR_META\s*(\{[\s\S]*?\})\s*\*\//);
          if (match) return JSON.parse(match[1]);
        } catch (e) {
          /* ignore */
        }
        return null;
      };

      const selected = getSelectedAvatar();

      // Find avatar file in ~/.clawtime/avatars/
      const avatarPath = selected ? path.join(DATA_DIR, "avatars", selected + ".js") : null;

      if (avatarPath && fs.existsSync(avatarPath)) {
        const meta = parseAvatarMeta(avatarPath);
        if (meta) {
          return json(200, {
            id: selected,
            emoji: meta.emoji || "🎭",
            color: meta.color || "f97316",
          });
        }
      }

      // Fallback: return first available avatar or generic theme
      const avatarsDir = path.join(DATA_DIR, "avatars");
      const available = fs.existsSync(avatarsDir)
        ? fs.readdirSync(avatarsDir).filter((f) => f.endsWith(".js"))
        : [];
      if (available.length > 0) {
        const firstAvatar = available[0].replace(".js", "");
        const firstMeta = parseAvatarMeta(path.join(avatarsDir, available[0]));
        return json(200, {
          id: firstAvatar,
          emoji: firstMeta?.emoji || "🎭",
          color: firstMeta?.color || "f97316",
        });
      }
      return json(200, { id: null, emoji: "🎭", color: "f97316" });
    }

    // ── Generate invite token (localhost only) ──
    if (urlPath === "/api/invite" && req.method === "POST") {
      const reqIp = req.socket.remoteAddress;
      if (reqIp !== "127.0.0.1" && reqIp !== "::1" && reqIp !== "::ffff:127.0.0.1") {
        return json(403, { error: "Localhost only" });
      }
      const { label, expiresMinutes } = await parseBody(req);
      const token = crypto.randomBytes(16).toString("hex");
      const now = Date.now();
      const expiresAt = now + (expiresMinutes || 60) * 60 * 1000;
      inviteTokens.set(token, { createdAt: now, expiresAt, label: label || "invite" });
      // Clean expired tokens
      for (const [k, v] of inviteTokens) {
        if (v.expiresAt < now) inviteTokens.delete(k);
      }
      auditLog("invite_created", { label, expiresMinutes: expiresMinutes || 60 });
      return json(200, { token, expiresAt, url: `/?invite=${token}` });
    }

    // ── Validate invite token ──
    if (urlPath === "/auth/invite-check" && req.method === "POST") {
      const { token } = await parseBody(req);
      const inv = inviteTokens.get(token);
      if (!inv || inv.expiresAt < Date.now()) {
        return json(200, { valid: false });
      }
      return json(200, { valid: true, label: inv.label });
    }

    // ── Auth status ──
    if (urlPath === "/auth/status" && req.method === "GET") {
      const creds = loadCredentials();
      return json(200, { registered: creds.length > 0 });
    }

    // ── Session check ──
    if (urlPath === "/auth/session" && req.method === "POST") {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        auditLog("rate_limit", { ip: clientIp });
        return json(429, { error: "Too many requests" });
      }
      const { token } = await parseBody(req);
      cleanExpiredSessions();
      const sess = sessions.get(token);
      if (token && sess && ipMatches(sess.ip, clientIp)) {
        return json(200, { valid: true });
      }
      return json(200, { valid: false });
    }

    // ── Token auth for automated testing ──
    if (urlPath === "/auth/token" && req.method === "POST") {
      const { token } = await parseBody(req);
      const testToken = process.env.TEST_TOKEN;
      if (testToken && token === testToken) {
        const clientIp =
          req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
        const sessionToken = crypto.randomBytes(32).toString("hex");
        sessions.set(sessionToken, { ip: clientIp, createdAt: Date.now() });
        auditLog("token_auth", { ip: clientIp });
        return json(200, { valid: true, sessionToken });
      }
      return json(200, { valid: false });
    }

    // ── List passkeys ──
    if (urlPath === "/auth/passkeys" && req.method === "GET") {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace("Bearer ", "");
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      cleanExpiredSessions();
      const sess = sessions.get(token);
      if (!token || !sess || !ipMatches(sess.ip, clientIp)) {
        return json(401, { error: "Unauthorized" });
      }
      const creds = loadCredentials();
      const list = creds.map((c) => ({
        id: c.credentialID,
        deviceType: c.deviceType || "unknown",
        backedUp: !!c.backedUp,
        createdAt: c.createdAt || null,
        transports: c.transports || [],
      }));
      return json(200, { passkeys: list });
    }

    // ── Delete passkey ──
    if (urlPath === "/auth/passkeys" && req.method === "DELETE") {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace("Bearer ", "");
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      cleanExpiredSessions();
      const sess = sessions.get(token);
      if (!token || !sess || !ipMatches(sess.ip, clientIp)) {
        return json(401, { error: "Unauthorized" });
      }
      const { id } = await parseBody(req);
      const creds = loadCredentials();
      if (creds.length <= 1) {
        return json(400, { error: "Cannot delete last passkey" });
      }
      const filtered = creds.filter((c) => c.credentialID !== id);
      if (filtered.length === creds.length) {
        return json(404, { error: "Passkey not found" });
      }
      saveCredentials(filtered);
      auditLog("passkey_deleted", { id, ip: clientIp });
      return json(200, { ok: true });
    }

    // ── Registration options ──
    if (urlPath === "/auth/register-options" && req.method === "POST") {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        auditLog("rate_limit", { ip: clientIp });
        return json(429, { error: "Too many requests" });
      }
      const { setupToken } = await parseBody(req);
      const creds = loadCredentials();
      // DECISION: Register-options gating — two distinct paths:
      //   • No passkeys exist yet → require the one-time setup token
      //     (this is the initial bootstrap for the first admin)
      //   • Passkeys already exist → require a valid authenticated session
      //     (only existing admins can add more passkeys)
      if (creds.length > 0) {
        const authHeader = req.headers["authorization"] || "";
        const sessToken = authHeader.replace("Bearer ", "");
        cleanExpiredSessions();
        const sess = sessions.get(sessToken);
        if (!sessToken || !sess || !ipMatches(sess.ip, clientIp)) {
          return json(401, { error: "Unauthorized — sign in first to add a passkey" });
        }
      } else {
        if (!getSetupToken() || setupToken !== getSetupToken()) {
          return json(401, { error: "Setup token required for first registration" });
        }
      }
      const rpID = getRpID(req);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID,
        userName: "clawtime-admin",
        userDisplayName: `${BOT_NAME} Admin`,
        attestationType: "none",
        excludeCredentials: creds.map((c) => ({
          id: c.credentialID,
          type: "public-key",
          transports: c.transports,
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      const challengeId = crypto.randomUUID();
      challenges.set(challengeId, {
        challenge: options.challenge,
        type: "registration",
        createdAt: Date.now(),
      });
      cleanExpiredChallenges();

      return json(200, { options, challengeId });
    }

    // ── Registration verify ──
    if (urlPath === "/auth/register-verify" && req.method === "POST") {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        auditLog("rate_limit", { ip: clientIp });
        return json(429, { error: "Too many requests" });
      }
      const { challengeId, response } = await parseBody(req);
      const stored = challenges.get(challengeId);
      if (!stored || stored.type !== "registration") {
        return json(400, { error: "Invalid or expired challenge" });
      }

      const rpID = getRpID(req);
      const expectedOrigin = getExpectedOrigin(req);

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin,
        expectedRPID: rpID,
      });

      challenges.delete(challengeId);

      if (!verification.verified || !verification.registrationInfo) {
        return json(400, { error: "Registration verification failed" });
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      const creds = loadCredentials();
      creds.push({
        credentialID: credential.id,
        credentialPublicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: credential.counter,
        transports: response.response?.transports || [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: new Date().toISOString(),
      });
      saveCredentials(creds);

      const token = crypto.randomBytes(32).toString("hex");
      createSession(token, { createdAt: Date.now(), ip: clientIp });

      // Consume setup token after successful first registration — one-time use
      if (getSetupToken()) {
        consumeSetupToken();
      }
      auditLog("register", { ip: clientIp });
      return json(200, { verified: true, token });
    }

    // ── Authentication options ──
    if (urlPath === "/auth/login-options" && req.method === "POST") {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        auditLog("rate_limit", { ip: clientIp });
        return json(429, { error: "Too many requests" });
      }
      const creds = loadCredentials();
      const rpID = getRpID(req);

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: creds.map((c) => ({
          id: c.credentialID,
          type: "public-key",
          transports: c.transports,
        })),
        userVerification: "preferred",
      });

      const challengeId = crypto.randomUUID();
      challenges.set(challengeId, {
        challenge: options.challenge,
        type: "authentication",
        createdAt: Date.now(),
      });
      cleanExpiredChallenges();

      return json(200, { options, challengeId });
    }

    // ── Authentication verify ──
    if (urlPath === "/auth/login-verify" && req.method === "POST") {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        auditLog("rate_limit", { ip: clientIp });
        return json(429, { error: "Too many requests" });
      }
      const { challengeId, response } = await parseBody(req);
      const stored = challenges.get(challengeId);
      if (!stored || stored.type !== "authentication") {
        return json(400, { error: "Invalid or expired challenge" });
      }

      const creds = loadCredentials();
      const credential = creds.find((c) => c.credentialID === response.id);
      if (!credential) {
        return json(400, { error: "Credential not found" });
      }

      const rpID = getRpID(req);
      const expectedOrigin = getExpectedOrigin(req);

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: credential.credentialID,
          publicKey: new Uint8Array(Buffer.from(credential.credentialPublicKey, "base64")),
          counter: credential.counter,
          transports: credential.transports,
        },
      });

      challenges.delete(challengeId);

      if (!verification.verified) {
        auditLog("auth_fail", { ip: clientIp });
        return json(400, { error: "Authentication failed" });
      }

      credential.counter = verification.authenticationInfo.newCounter;
      saveCredentials(creds);

      cleanExpiredSessions();
      const token = crypto.randomBytes(32).toString("hex");
      createSession(token, { createdAt: Date.now(), ip: clientIp });

      auditLog("auth_success", { ip: clientIp });
      return json(200, { verified: true, token });
    }

    // ── Re-verify (sensitive operation confirmation) ──
    if (urlPath === "/auth/reverify" && req.method === "POST") {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace("Bearer ", "");
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      cleanExpiredSessions();
      const sess = sessions.get(token);
      if (!token || !sess || !ipMatches(sess.ip, clientIp)) {
        return json(401, { error: "Unauthorized" });
      }
      if (!checkRateLimit(clientIp)) {
        return json(429, { error: "Too many requests" });
      }
      const { challengeId, response } = await parseBody(req);

      // Step 1: No challenge yet — generate options
      if (!challengeId) {
        const creds = loadCredentials();
        const rpID = getRpID(req);
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: creds.map((c) => ({
            id: c.credentialID,
            type: "public-key",
            transports: c.transports,
          })),
          userVerification: "required",
        });
        const cid = crypto.randomUUID();
        challenges.set(cid, {
          challenge: options.challenge,
          type: "reverify",
          createdAt: Date.now(),
        });
        cleanExpiredChallenges();
        return json(200, { options, challengeId: cid });
      }

      // Step 2: Verify the response
      const stored = challenges.get(challengeId);
      if (!stored || stored.type !== "reverify") {
        return json(400, { error: "Invalid or expired challenge" });
      }
      const creds = loadCredentials();
      const credential = creds.find((c) => c.credentialID === response.id);
      if (!credential) {
        return json(400, { error: "Credential not found" });
      }
      const rpID = getRpID(req);
      const expectedOrigin = getExpectedOrigin(req);
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: stored.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: credential.credentialID,
          publicKey: new Uint8Array(Buffer.from(credential.credentialPublicKey, "base64")),
          counter: credential.counter,
          transports: credential.transports,
        },
      });
      challenges.delete(challengeId);
      if (!verification.verified) {
        auditLog("reverify_fail", { ip: clientIp });
        return json(400, { error: "Verification failed" });
      }
      credential.counter = verification.authenticationInfo.newCounter;
      saveCredentials(creds);
      auditLog("reverify_success", { ip: clientIp });
      return json(200, { verified: true });
    }

    // ── Task list ──
    if (urlPath === "/api/tasks" && ENABLE_TASKS && TASKS_FILE) {
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      const taskClientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
      const taskSess = sessions.get(token);
      if (!taskSess || taskSess.ip !== taskClientIp) return json(401, { error: "Unauthorized" });
      if (req.method === "GET") {
        try {
          const content = fs.existsSync(TASKS_FILE)
            ? fs.readFileSync(TASKS_FILE, "utf-8")
            : "# Tasks\n\nNo tasks yet.";
          return json(200, { content });
        } catch (err) {
          return json(500, { error: "Failed to read tasks" });
        }
      }
      if (req.method === "POST") {
        const body = await parseBody(req);
        if (typeof body.content !== "string") return json(400, { error: "content required" });
        try {
          fs.writeFileSync(TASKS_FILE, body.content, "utf-8");
          return json(200, { ok: true });
        } catch (err) {
          return json(500, { error: "Failed to save tasks" });
        }
      }
    }

    // ── Serve media files (uploaded images, PDFs, etc.) ──
    // DECISION: This route exists so the bot/gateway can reference uploaded images
    // back in its responses. When a user uploads an image, we save it to disk and
    // include the URL (e.g., [Image: /media/img-abc123.jpg]) in the gateway message.
    // The bot can then echo that URL in markdown, and the client renders it.
    if (urlPath.startsWith("/media/") && req.method === "GET") {
      const filename = path.basename(urlPath);
      const filePath = path.join(MEDIA_DIR, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(MEDIA_DIR)) || !fs.existsSync(resolved)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(filename).toLowerCase();
      const mimeMap = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".mp3": "audio/mpeg",
      };
      const contentType = mimeMap[ext] || "application/octet-stream";
      const data = fs.readFileSync(resolved);
      const headers = {
        "Content-Type": contentType,
        "Content-Length": data.length,
        "Cache-Control": "max-age=3600",
      };
      // Force download for non-image/non-audio files (PDFs, etc.) so browser doesn't navigate away
      if (!contentType.startsWith("image/") && !contentType.startsWith("audio/")) {
        headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      }
      res.writeHead(200, headers);
      return res.end(data);
    }

    // ── Serve TTS audio files ──
    // NOTE: TTS filenames use crypto.randomBytes(8) (unguessable 16-hex-char IDs).
    // URLs are only delivered to authenticated clients via encrypted WebSocket.
    // The random filename acts as a capability token — no extra auth needed.
    if (urlPath.startsWith("/tts/") && req.method === "GET") {
      const filename = path.basename(urlPath);
      const filePath = path.join(TTS_DIR, filename);
      if (!filename.match(/^tts-[\w-]+\.mp3$/) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
      });
      return res.end(data);
    }

    // ── Dynamic manifest.json with BOT_NAME ──
    if (urlPath === "/manifest.json" && req.method === "GET") {
      const manifest = {
        name: BOT_NAME,
        short_name: BOT_NAME,
        description: `Chat with ${BOT_NAME}`,
        start_url: "/",
        display: "standalone",
        background_color: "#0d1117",
        theme_color: "#0d1117",
        orientation: "portrait",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      return res.end(JSON.stringify(manifest, null, 2));
    }

    // ── Serve customizable assets with fallback (check ~/.clawtime first) ──
    // Note: avatar.js is handled separately in serveStatic with query param support
    const customizableAssets = [
      "/icon-192.png",
      "/icon-512.png",
      "/apple-touch-icon.png",
      "/favicon.ico",
    ];
    if (customizableAssets.includes(urlPath) && req.method === "GET") {
      const filename = path.basename(urlPath);
      const customPath = path.join(DATA_DIR, filename);
      const defaultPath = path.join(PUBLIC_DIR, filename);
      const assetPath = fs.existsSync(customPath) ? customPath : defaultPath;
      if (!fs.existsSync(assetPath)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(assetPath);
      const mime = MIME[ext] || "application/octet-stream";
      const data = fs.readFileSync(assetPath);
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
      return res.end(data);
    }

    // ── Serve avatar with fallback: ~/.clawtime/avatar.png -> public/default-avatar.png ──
    if (urlPath === "/avatar.png" && req.method === "GET") {
      const customAvatar = path.join(DATA_DIR, "avatar.png");
      const defaultAvatar = path.join(PUBLIC_DIR, "default-avatar.png");
      const avatarPath = fs.existsSync(customAvatar) ? customAvatar : defaultAvatar;
      if (!fs.existsSync(avatarPath)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const data = fs.readFileSync(avatarPath);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
      return res.end(data);
    }

    // ── Serve custom assets from ~/.clawtime/ ──
    if (urlPath.startsWith("/custom/") && req.method === "GET") {
      const filename = path.basename(urlPath);
      // Only allow safe filenames (alphanumeric, dash, underscore, dot)
      if (!filename.match(/^[\w.-]+$/) || filename.startsWith(".")) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      const filePath = path.join(DATA_DIR, filename);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(DATA_DIR)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(filePath);
      const mime = MIME[ext] || "application/octet-stream";
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
      return res.end(data);
    }

    // ── Serve static files ──
    serveStatic(req, res);
  } catch (err) {
    console.error("Request error:", err);
    json(500, { error: "Internal server error" });
  }
}
