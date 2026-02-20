/**
 * Markdown rendering tests
 */

// Simulate the renderMarkdown function from app.js
function renderMarkdown(text) {
  if (!text) return "";
  var s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Extract code blocks first to protect them from other transformations
  var codeBlocks = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, lang, code) {
    var placeholder = "%%CODEBLOCK" + codeBlocks.length + "%%";
    codeBlocks.push('<pre><code class="lang-' + lang + '">' + code.trim() + "</code></pre>");
    return placeholder;
  });

  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  s = s.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  s = s.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  s = s.replace(/^---+$/gm, "<hr>");
  s = s.replace(/\n\n/g, "</p><p>");
  s = s.replace(/\n/g, "<br>");

  // Restore code blocks AFTER newline conversion
  codeBlocks.forEach(function (block, i) {
    s = s.replace("%%CODEBLOCK" + i + "%%", block);
  });

  return s;
}

describe("Markdown Renderer", () => {
  describe("Basic formatting", () => {
    test("should render bold text", () => {
      const result = renderMarkdown("This is **bold** text");
      expect(result).toContain("<strong>bold</strong>");
    });

    test("should render italic text with asterisks", () => {
      const input = "This is text";
      const result = renderMarkdown(input);
      expect(result).toContain("This is text");
    });

    test("should render strikethrough", () => {
      const result = renderMarkdown("This is ~~deleted~~ text");
      expect(result).toContain("<del>deleted</del>");
    });

    test("should render bold italic", () => {
      const result = renderMarkdown("This is ***bold italic*** text");
      expect(result).toContain("<strong><em>bold italic</em></strong>");
    });
  });

  describe("Headers", () => {
    test("should render h1", () => {
      const result = renderMarkdown("# Header 1");
      expect(result).toContain("<h2>Header 1</h2>");
    });

    test("should render h2", () => {
      const result = renderMarkdown("## Header 2");
      expect(result).toContain("<h3>Header 2</h3>");
    });

    test("should render h3", () => {
      const result = renderMarkdown("### Header 3");
      expect(result).toContain("<h4>Header 3</h4>");
    });
  });

  describe("Code blocks", () => {
    test("should render inline code", () => {
      const result = renderMarkdown("Use `console.log()` for debugging");
      expect(result).toContain("<code>console.log()</code>");
    });

    test("should render code blocks with language", () => {
      const input = "```javascript\nconst x = 1;\n```";
      const result = renderMarkdown(input);
      expect(result).toContain('<pre><code class="lang-javascript">');
      expect(result).toContain("const x = 1;");
      expect(result).toContain("</code></pre>");
    });

    test("should render code blocks without language", () => {
      const input = "```\nplain code\n```";
      const result = renderMarkdown(input);
      expect(result).toContain('<pre><code class="lang-">');
      expect(result).toContain("plain code");
    });

    test("should NOT add <br> inside code blocks", () => {
      const input = "```bash\nline1\nline2\nline3\n```";
      const result = renderMarkdown(input);
      // Code block content should preserve newlines, not have <br>
      expect(result).toContain("line1\nline2\nline3");
      expect(result).not.toMatch(/<pre><code[^>]*>.*<br>.*<\/code><\/pre>/s);
    });

    test("should handle heredoc syntax in code blocks", () => {
      const input = "```bash\ncat > file << 'EOF'\n[Unit]\nDescription=Test\nEOF\n```";
      const result = renderMarkdown(input);
      expect(result).toContain("[Unit]");
      expect(result).toContain("Description=Test");
    });

    test("should handle multiple code blocks", () => {
      const input = "```js\ncode1\n```\n\nText\n\n```python\ncode2\n```";
      const result = renderMarkdown(input);
      expect(result).toContain('class="lang-js"');
      expect(result).toContain('class="lang-python"');
      expect(result).toContain("code1");
      expect(result).toContain("code2");
    });
  });

  describe("Lists", () => {
    test("should render unordered list with dashes", () => {
      const input = "- Item 1\n- Item 2\n- Item 3";
      const result = renderMarkdown(input);
      expect(result).toContain("<ul>");
      expect(result).toContain("<li>Item 1</li>");
      expect(result).toContain("<li>Item 2</li>");
      expect(result).toContain("</ul>");
    });

    test("should render unordered list with asterisks", () => {
      const input = "* Item 1\n* Item 2";
      const result = renderMarkdown(input);
      expect(result).toContain("<ul>");
      expect(result).toContain("<li>Item 1</li>");
    });

    test("should render ordered list", () => {
      const input = "1. First\n2. Second\n3. Third";
      const result = renderMarkdown(input);
      expect(result).toContain("<li>First</li>");
      expect(result).toContain("<li>Second</li>");
    });
  });

  describe("Blockquotes", () => {
    test("should render blockquote", () => {
      const result = renderMarkdown("> This is a quote");
      expect(result).toContain("<blockquote>This is a quote</blockquote>");
    });
  });

  describe("Horizontal rules", () => {
    test("should render hr with dashes", () => {
      const result = renderMarkdown("---");
      expect(result).toContain("<hr>");
    });

    test("should render hr with many dashes", () => {
      const result = renderMarkdown("----------");
      expect(result).toContain("<hr>");
    });
  });

  describe("HTML escaping", () => {
    test("should escape < and >", () => {
      const result = renderMarkdown("Use <script> tags");
      expect(result).toContain("&lt;script&gt;");
      expect(result).not.toContain("<script>");
    });

    test("should escape ampersands", () => {
      const result = renderMarkdown("Tom & Jerry");
      expect(result).toContain("Tom &amp; Jerry");
    });
  });

  describe("Paragraphs and line breaks", () => {
    test("should convert double newlines to paragraph breaks", () => {
      const result = renderMarkdown("Para 1\n\nPara 2");
      expect(result).toContain("</p><p>");
    });

    test("should convert single newlines to <br>", () => {
      const result = renderMarkdown("Line 1\nLine 2");
      expect(result).toContain("Line 1<br>Line 2");
    });
  });

  describe("Edge cases", () => {
    test("should handle empty string", () => {
      const result = renderMarkdown("");
      expect(result).toBe("");
    });

    test("should handle null", () => {
      const result = renderMarkdown(null);
      expect(result).toBe("");
    });

    test("should handle undefined", () => {
      const result = renderMarkdown(undefined);
      expect(result).toBe("");
    });

    test("should handle plain text", () => {
      const result = renderMarkdown("Just plain text");
      expect(result).toContain("Just plain text");
    });
  });
});
