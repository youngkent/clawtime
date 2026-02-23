/**
 * Unit tests for src/helpers.js utility functions
 */

import { getRpID, getExpectedOrigin, ipMatches, isSafeFilename, MIME } from "../src/helpers.js";

describe("getRpID", () => {
  test("extracts hostname from host header", () => {
    const req = { headers: { host: "example.com" } };
    expect(getRpID(req)).toBe("example.com");
  });

  test("strips port from host header", () => {
    const req = { headers: { host: "example.com:3000" } };
    expect(getRpID(req)).toBe("example.com");
  });

  test("returns localhost when no host header", () => {
    const req = { headers: {} };
    expect(getRpID(req)).toBe("localhost");
  });

  test("handles IP addresses", () => {
    const req = { headers: { host: "192.168.1.1:8080" } };
    expect(getRpID(req)).toBe("192.168.1.1");
  });
});

describe("getExpectedOrigin", () => {
  test("constructs origin from forwarded proto and host", () => {
    const req = { headers: { "x-forwarded-proto": "https", host: "example.com" } };
    expect(getExpectedOrigin(req)).toBe("https://example.com");
  });

  test("defaults to http when no forwarded proto", () => {
    const req = { headers: { host: "example.com" } };
    expect(getExpectedOrigin(req)).toBe("http://example.com");
  });

  test("includes port in origin", () => {
    const req = { headers: { "x-forwarded-proto": "http", host: "localhost:3000" } };
    expect(getExpectedOrigin(req)).toBe("http://localhost:3000");
  });

  test("defaults to localhost when no host", () => {
    const req = { headers: {} };
    expect(getExpectedOrigin(req)).toBe("http://localhost");
  });
});

describe("ipMatches", () => {
  describe("exact matches", () => {
    test("returns true for identical IPs", () => {
      expect(ipMatches("192.168.1.1", "192.168.1.1")).toBe(true);
    });

    test("returns false for different IPs", () => {
      expect(ipMatches("192.168.1.1", "192.168.1.2")).toBe(false);
    });
  });

  describe("localhost variants", () => {
    test("matches 127.0.0.1 to ::1", () => {
      expect(ipMatches("127.0.0.1", "::1")).toBe(true);
    });

    test("matches ::ffff:127.0.0.1 to 127.0.0.1", () => {
      expect(ipMatches("::ffff:127.0.0.1", "127.0.0.1")).toBe(true);
    });

    test("matches localhost string variants", () => {
      expect(ipMatches("localhost", "127.0.0.1")).toBe(true);
    });

    test("does not match localhost to external IP", () => {
      expect(ipMatches("127.0.0.1", "8.8.8.8")).toBe(false);
    });
  });

  describe("IPv6 prefix matching", () => {
    test("matches IPv6 addresses with same /64 prefix", () => {
      // Same first 4 segments, different interface identifiers
      expect(ipMatches(
        "2001:db8:85a3:1234:abcd:1234:5678:90ab",
        "2001:db8:85a3:1234:ffff:eeee:dddd:cccc"
      )).toBe(true);
    });

    test("does not match different /64 prefixes", () => {
      expect(ipMatches(
        "2001:db8:85a3:1234:abcd:1234:5678:90ab",
        "2001:db8:85a3:9999:ffff:eeee:dddd:cccc"
      )).toBe(false);
    });

    test("handles shortened IPv6 notation", () => {
      // Both have same prefix
      expect(ipMatches("::1:2:3:4:5:6:7", "::1:2:3:4:a:b:c:d")).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("handles null session IP", () => {
      expect(ipMatches(null, "192.168.1.1")).toBe(false);
    });

    test("handles undefined connection IP", () => {
      expect(ipMatches("192.168.1.1", undefined)).toBe(false);
    });

    test("does not match IPv4 to IPv6", () => {
      expect(ipMatches("192.168.1.1", "2001:db8::1")).toBe(false);
    });
  });
});

describe("isSafeFilename", () => {
  describe("valid filenames", () => {
    test("accepts alphanumeric", () => {
      expect(isSafeFilename("avatar123")).toBe(true);
    });

    test("accepts dashes", () => {
      expect(isSafeFilename("my-avatar")).toBe(true);
    });

    test("accepts underscores", () => {
      expect(isSafeFilename("my_avatar")).toBe(true);
    });

    test("accepts mixed valid characters", () => {
      expect(isSafeFilename("Avatar_2024-v1")).toBe(true);
    });
  });

  describe("invalid filenames", () => {
    test("rejects empty string", () => {
      expect(isSafeFilename("")).toBe(false);
    });

    test("rejects null", () => {
      expect(isSafeFilename(null)).toBe(false);
    });

    test("rejects undefined", () => {
      expect(isSafeFilename(undefined)).toBe(false);
    });

    test("rejects numbers", () => {
      expect(isSafeFilename(123)).toBe(false);
    });

    test("rejects path traversal", () => {
      expect(isSafeFilename("../etc/passwd")).toBe(false);
    });

    test("rejects dots", () => {
      expect(isSafeFilename("file.txt")).toBe(false);
    });

    test("rejects spaces", () => {
      expect(isSafeFilename("my avatar")).toBe(false);
    });

    test("rejects slashes", () => {
      expect(isSafeFilename("path/to/file")).toBe(false);
    });

    test("rejects backslashes", () => {
      expect(isSafeFilename("path\\to\\file")).toBe(false);
    });

    test("rejects special characters", () => {
      expect(isSafeFilename("file@name")).toBe(false);
      expect(isSafeFilename("file$name")).toBe(false);
      expect(isSafeFilename("file!name")).toBe(false);
    });
  });
});

describe("MIME types", () => {
  test("has correct content-type for HTML", () => {
    expect(MIME[".html"]).toBe("text/html");
  });

  test("has correct content-type for CSS", () => {
    expect(MIME[".css"]).toBe("text/css");
  });

  test("has correct content-type for JavaScript", () => {
    expect(MIME[".js"]).toBe("text/javascript");
  });

  test("has correct content-type for PNG", () => {
    expect(MIME[".png"]).toBe("image/png");
  });

  test("has correct content-type for SVG", () => {
    expect(MIME[".svg"]).toBe("image/svg+xml");
  });

  test("has correct content-type for JSON", () => {
    expect(MIME[".json"]).toBe("application/json");
  });

  test("has correct content-type for audio files", () => {
    expect(MIME[".mp3"]).toBe("audio/mpeg");
    expect(MIME[".webm"]).toBe("audio/webm");
  });
});
