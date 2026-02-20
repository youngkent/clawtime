/**
 * State tests - session persistence and avatar state
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SESSIONS_PATH = path.join(__dirname, "test-sessions.json");

// Simulate the state module functions
function loadSessions(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch (e) {}
  return new Map();
}

function saveSessions(sessions, filePath) {
  const obj = Object.fromEntries(sessions);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function createSession(sessions, token, data, filePath) {
  sessions.set(token, data);
  saveSessions(sessions, filePath);
}

function updateSession(sessions, token, updates, filePath) {
  const sess = sessions.get(token);
  if (sess) {
    Object.assign(sess, updates);
    saveSessions(sessions, filePath);
  }
}

function getSessionAvatarState(sessions, token) {
  const sess = sessions.get(token);
  return sess?.avatarState || "idle";
}

beforeEach(() => {
  if (fs.existsSync(TEST_SESSIONS_PATH)) {
    fs.unlinkSync(TEST_SESSIONS_PATH);
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_SESSIONS_PATH)) {
    fs.unlinkSync(TEST_SESSIONS_PATH);
  }
});

describe("Session State", () => {
  describe("createSession", () => {
    test("should create a new session", () => {
      const sessions = new Map();
      createSession(
        sessions,
        "token-123",
        { createdAt: Date.now(), ip: "127.0.0.1" },
        TEST_SESSIONS_PATH,
      );

      expect(sessions.has("token-123")).toBe(true);
      expect(fs.existsSync(TEST_SESSIONS_PATH)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(TEST_SESSIONS_PATH, "utf8"));
      expect(saved["token-123"]).toBeDefined();
      expect(saved["token-123"].ip).toBe("127.0.0.1");
    });
  });

  describe("updateSession", () => {
    test("should update existing session with avatar state", () => {
      const sessions = new Map();
      createSession(sessions, "token-456", { createdAt: Date.now() }, TEST_SESSIONS_PATH);

      updateSession(sessions, "token-456", { avatarState: "thinking" }, TEST_SESSIONS_PATH);

      const sess = sessions.get("token-456");
      expect(sess.avatarState).toBe("thinking");

      // Verify persisted
      const saved = JSON.parse(fs.readFileSync(TEST_SESSIONS_PATH, "utf8"));
      expect(saved["token-456"].avatarState).toBe("thinking");
    });

    test("should not update non-existent session", () => {
      const sessions = new Map();
      updateSession(sessions, "nonexistent", { avatarState: "error" }, TEST_SESSIONS_PATH);

      expect(sessions.has("nonexistent")).toBe(false);
    });
  });

  describe("getSessionAvatarState", () => {
    test("should return idle for new session without avatar state", () => {
      const sessions = new Map();
      createSession(sessions, "token-789", { createdAt: Date.now() }, TEST_SESSIONS_PATH);

      const state = getSessionAvatarState(sessions, "token-789");
      expect(state).toBe("idle");
    });

    test("should return stored avatar state", () => {
      const sessions = new Map();
      createSession(
        sessions,
        "token-abc",
        { createdAt: Date.now(), avatarState: "working" },
        TEST_SESSIONS_PATH,
      );

      const state = getSessionAvatarState(sessions, "token-abc");
      expect(state).toBe("working");
    });

    test("should return idle for non-existent session", () => {
      const sessions = new Map();
      const state = getSessionAvatarState(sessions, "nonexistent");
      expect(state).toBe("idle");
    });
  });

  describe("Session persistence", () => {
    test("should persist and reload sessions", () => {
      // Create and save
      const sessions1 = new Map();
      createSession(
        sessions1,
        "persist-test",
        {
          createdAt: Date.now(),
          avatarState: "happy",
        },
        TEST_SESSIONS_PATH,
      );

      // Load from disk
      const sessions2 = loadSessions(TEST_SESSIONS_PATH);
      expect(sessions2.has("persist-test")).toBe(true);
      expect(sessions2.get("persist-test").avatarState).toBe("happy");
    });

    test("should handle multiple sessions", () => {
      const sessions = new Map();
      createSession(sessions, "user-1", { avatarState: "idle" }, TEST_SESSIONS_PATH);
      createSession(sessions, "user-2", { avatarState: "thinking" }, TEST_SESSIONS_PATH);
      createSession(sessions, "user-3", { avatarState: "coding" }, TEST_SESSIONS_PATH);

      expect(sessions.size).toBe(3);

      const reloaded = loadSessions(TEST_SESSIONS_PATH);
      expect(reloaded.size).toBe(3);
      expect(getSessionAvatarState(reloaded, "user-2")).toBe("thinking");
    });
  });
});

describe("Avatar State Values", () => {
  const validStates = [
    "idle",
    "thinking",
    "working",
    "coding",
    "talking",
    "happy",
    "error",
    "sleeping",
  ];

  test.each(validStates)("should accept valid state: %s", (state) => {
    const sessions = new Map();
    createSession(sessions, "state-test", { createdAt: Date.now() }, TEST_SESSIONS_PATH);
    updateSession(sessions, "state-test", { avatarState: state }, TEST_SESSIONS_PATH);

    expect(getSessionAvatarState(sessions, "state-test")).toBe(state);
  });
});
