// ─── Version check: use query string hash for cache busting ───
// No hardcoded version — rely on ?v= query strings in HTML for cache control
(function() {
  console.log('[ClawTime] JS loaded, version:', window.CLAWTIME_VERSION || 'unknown');
})();

// ─── Config (loaded from server) ───
const CFG = {
  botName: 'ClawTime',
  botEmoji: null,  // Set from avatar theme
  botTagline: 'Your AI assistant. Type a message to start chatting.',
  enableAvatar: true,
  themeAccent: null,  // Set from avatar theme
};

// Load config from server before anything else
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    Object.assign(CFG, data);
  } catch (e) {
    // Use defaults
  }
  
  // Apply avatar theme (from pre-fetch or fetch now)
  let theme = window.CLAWTIME_THEME;
  if (!theme) {
    try {
      const r = await fetch('/api/avatar/current');
      theme = await r.json();
    } catch (e) {
      theme = { emoji: '🦞', color: 'f97316' };  // Fallback
    }
  }
  CFG.botEmoji = theme.emoji || '🦞';
  CFG.themeAccent = theme.color || 'f97316';
  
  applyConfig();
}

function applyConfig() {
  // Update page title
  document.title = CFG.botName;

  // Update theme accent color
  const r = document.documentElement;
  const hex = CFG.themeAccent;
  if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) {
    const rr = parseInt(hex.slice(0,2), 16);
    const gg = parseInt(hex.slice(2,4), 16);
    const bb = parseInt(hex.slice(4,6), 16);
    r.style.setProperty('--accent', '#' + hex);
    r.style.setProperty('--accent-glow', 'rgba(' + rr + ',' + gg + ',' + bb + ',0.15)');
  }

  // Auth screen
  document.getElementById('authEmoji').textContent = CFG.botEmoji;
  document.getElementById('authTitle').textContent = CFG.botName;

  // Welcome screen
  document.getElementById('welcomeEmoji').textContent = CFG.botEmoji;
  document.getElementById('welcomeTitle').textContent = CFG.botName;
  document.getElementById('welcomeTagline').textContent = CFG.botTagline;

  // Avatar panel visibility
  if (!CFG.enableAvatar) {
    document.getElementById('chatUi').classList.add('no-avatar');
  }

  // Task button visibility
  const taskBtn = document.getElementById('taskBtn');
  const taskBtnHeader = document.getElementById('taskBtnHeader');
  if (taskBtn && !CFG.enableTasks) taskBtn.style.display = 'none';
  if (taskBtnHeader && !CFG.enableTasks) taskBtnHeader.style.display = 'none';

  // Voice button visibility
  const voiceBtn = document.getElementById('callToggleBtn');
  if (voiceBtn && !CFG.enableVoice) voiceBtn.style.display = 'none';
}

const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser;

const authScreen = document.getElementById('authScreen');
const chatUi = document.getElementById('chatUi');
const authBtn = document.getElementById('authBtn');
const authBtnText = document.getElementById('authBtnText');
const authLabel = document.getElementById('authLabel');
const authError = document.getElementById('authError');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');

let ws = null;
let connected = false;
let typingEl = null;
// No local message cache - use DOM with data-msgid as source of truth
let reconnectTimer = null;
let sessionToken = null;
let isRegistered = false;
let pendingAttachments = [];  // Array of { base64, name, type, dataUrl? }

// ─── History Pagination ───
const HISTORY_PAGE_SIZE = 10;
let historyMessages = [];
let historyIndex = 0;
let loadingMore = false;
let historyLoaded = false;
let pendingChatEvents = [];
const deltaGapTimer = null;
let activeRunning = false;
const avatarIdleTimer = null;  // Track idle timeout for cancellation

function showLoadMoreIndicator() {
  let indicator = document.getElementById('load-more');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'load-more';
    indicator.style.cssText = 'text-align:center;padding:12px;color:#888;font-size:13px;cursor:pointer;';
    indicator.textContent = '↑ Scroll up for older messages';
    indicator.addEventListener('click', loadOlderMessages);
    messagesEl.prepend(indicator);
  }
}

function removeLoadMoreIndicator() {
  const indicator = document.getElementById('load-more');
  if (indicator) indicator.remove();
}

function showLoadingIndicator() {
  let el = document.getElementById('loading-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-indicator';
    el.style.cssText = 'text-align:center;padding:12px;color:var(--text-dim);font-size:13px;';
    el.textContent = 'Loading messages…';
    messagesEl.prepend(el);
  }
}

function removeLoadingIndicator() {
  const el = document.getElementById('loading-indicator');
  if (el) el.remove();
}

function loadOlderMessages() {
  if (loadingMore || historyIndex <= 0) return;
  loadingMore = true;

  const newStart = Math.max(0, historyIndex - HISTORY_PAGE_SIZE);

  // Remove indicators first and measure
  removeLoadMoreIndicator();
  removeLoadingIndicator();

  // Record current state
  const prevScrollHeight = messagesEl.scrollHeight;
  const prevScrollTop = messagesEl.scrollTop;

  // Temporarily prevent scroll events by setting overflow
  const prevOverflow = messagesEl.style.overflow;
  messagesEl.style.overflow = 'hidden';

  // Create a document fragment for batch DOM insertion
  const fragment = document.createDocumentFragment();
  const tempMessages = [];
  
  for (let i = newStart; i < historyIndex; i++) {
    const m = historyMessages[i];
    if (m.widget) continue; // Skip widgets
    
    const div = document.createElement('div');
    div.className = 'message ' + m.role;
    
    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + m.role;
    
    if (m.images && m.images.length > 0) {
      m.images.forEach(function(imgSrc) {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = imgSrc;
        bubble.appendChild(img);
      });
      if (m.text) {
        const textDiv = document.createElement('div');
        textDiv.innerHTML = renderMarkdown(m.text);
        bubble.appendChild(textDiv);
      }
    } else {
      bubble.innerHTML = renderMarkdown(m.text || '');
    }
    
    div.appendChild(bubble);
    tempMessages.push(div);
  }
  
  // Insert all at once at the beginning
  const firstChild = messagesEl.firstChild;
  for (let j = tempMessages.length - 1; j >= 0; j--) {
    messagesEl.insertBefore(tempMessages[j], firstChild);
  }

  historyIndex = newStart;

  // Calculate new scroll position to maintain view
  const newScrollHeight = messagesEl.scrollHeight;
  const heightAdded = newScrollHeight - prevScrollHeight;
  
  // Set scroll position before re-enabling overflow
  messagesEl.scrollTop = prevScrollTop + heightAdded;
  
  // Re-enable scroll
  messagesEl.style.overflow = prevOverflow || '';

  // Add load more indicator
  if (historyIndex > 0) {
    showLoadMoreIndicator();
  }

  loadingMore = false;
}

// ─── Send Button State ───
function updateSendBtn() {
  const hasContent = !!(inputEl.value.trim() || pendingAttachments.length > 0);
  sendBtn.disabled = !hasContent || !connected;
}

// ─── Initialize ───
async function init() {
  await loadConfig();

  // Token-based auth for automated testing
  const urlParams = new URLSearchParams(window.location.search);
  const testToken = urlParams.get('token');
  if (testToken) {
    try {
      const tokenRes = await fetch('/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: testToken })
      });
      const tokenData = await tokenRes.json();
      if (tokenData.valid) {
        sessionToken = tokenData.sessionToken;
        localStorage.setItem('clawtime_session', sessionToken);
        enterChat();
        return;
      }
    } catch (e) {
      console.log('[Auth] Token auth failed:', e.message);
    }
  }

  sessionToken = localStorage.getItem('clawtime_session');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(function() { controller.abort(); }, 5000);
    const res = await fetch('/auth/status?_=' + Date.now(), { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeoutId);
    const data = await res.json();
    isRegistered = data.registered;
  } catch (e) {
    authError.textContent = e.name === 'AbortError' ? 'Auth check timed out — try hard refresh (Cmd+Shift+R)' : 'Failed to check auth status';
    return;
  }

  if (sessionToken) {
    try {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(function() { controller2.abort(); }, 5000);
      const res = await fetch('/auth/session?_=' + Date.now(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken }),
        signal: controller2.signal,
        cache: 'no-store',
      });
      clearTimeout(timeoutId2);
      const data = await res.json();
      if (data.valid) {
        enterChat();
        return;
      }
    } catch { /* ignore */ }
    localStorage.removeItem('clawtime_session');
    sessionToken = null;
  }

  if (isRegistered) {
    // Auto-trigger authentication — no button click needed
    authLabel.textContent = 'Authenticating...';
    doLogin();
    return;
  } else {
    // Check for setup token in URL
    const urlParams = new URLSearchParams(window.location.search);
    const setupToken = urlParams.get('setup');
    if (setupToken) {
      window._setupToken = setupToken;
      authLabel.textContent = 'Set up your passkey to get started';
      authBtnText.textContent = 'Register passkey';
    } else {
      authLabel.textContent = 'Enter setup token to register';
      // Show token input
      const tokenInput = document.createElement('input');
      tokenInput.type = 'text';
      tokenInput.placeholder = 'Setup token';
      tokenInput.id = 'setupTokenInput';
      tokenInput.style.cssText = 'width:100%;max-width:300px;padding:12px 16px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);color:var(--fg);font-size:16px;margin:12px auto;display:block;text-align:center;outline:none;';
      authBtn.parentNode.insertBefore(tokenInput, authBtn);
      authBtnText.textContent = 'Register passkey';
      tokenInput.addEventListener('input', function() {
        window._setupToken = tokenInput.value.trim();
      });
      tokenInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && tokenInput.value.trim()) {
          authBtn.click();
        }
      });
    }
  }
  authBtn.style.display = '';
}

// ─── Friendly WebAuthn error messages ───
function getPasskeyErrorMessage(err, isLogin) {
  const name = err.name || '';
  const msg = err.message || '';
  
  // User cancelled
  if (name === 'NotAllowedError') {
    if (/cancelled/i.test(msg) || /aborted/i.test(msg)) {
      return 'Cancelled. Try again when ready.';
    }
    return 'Passkey access denied. Check browser settings.';
  }
  
  // Browser doesn't support WebAuthn
  if (name === 'NotSupportedError' || /not supported/i.test(msg)) {
    return 'Passkeys not supported in this browser. Try Chrome, Safari, or Firefox.';
  }
  
  // No passkeys available (guest mode, incognito, or none registered)
  if (name === 'InvalidStateError' || /no credentials/i.test(msg) || /no passkey/i.test(msg)) {
    return isLogin 
      ? 'No passkeys found. Try a different browser or device.'
      : 'Cannot create passkey here. Try a regular browser window.';
  }
  
  // Security error (wrong origin, etc)
  if (name === 'SecurityError') {
    return 'Security error. Make sure you\'re on the correct site.';
  }
  
  // Timeout
  if (name === 'AbortError' || /timeout/i.test(msg)) {
    return 'Timed out. Try again.';
  }
  
  // Fallback
  return msg || (isLogin ? 'Login failed' : 'Registration failed');
}

// ─── Passkey Registration ───
async function doRegister() {
  authBtn.disabled = true;
  authError.textContent = '';

  try {
    const optRes = await fetch('/auth/register-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: window._setupToken || undefined }),
    });
    const optData = await optRes.json();
    if (optData.error) throw new Error(optData.error);
    const { options, challengeId } = optData;
    const attResp = await startRegistration({ optionsJSON: options });

    const verRes = await fetch('/auth/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: attResp }),
    });
    const verData = await verRes.json();

    if (verData.verified && verData.token) {
      sessionToken = verData.token;
      localStorage.setItem('clawtime_session', sessionToken);
      enterChat();
    } else {
      authError.textContent = verData.error || 'Registration failed';
      authBtn.disabled = false;
    }
  } catch (err) {
    authError.textContent = getPasskeyErrorMessage(err, false);
    authBtn.disabled = false;
  }
}

// ─── Passkey Authentication ───
async function doLogin() {
  authBtn.disabled = true;
  authError.textContent = '';

  try {
    const optRes = await fetch('/auth/login-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!optRes.ok) {
      throw new Error('Login options failed: ' + optRes.status);
    }
    const optData = await optRes.json();
    const options = optData.options;
    const challengeId = optData.challengeId;
    if (!options) {
      throw new Error('Invalid login options received');
    }
    if (!options.allowCredentials || options.allowCredentials.length === 0) {
      authError.textContent = 'No passkeys registered. Contact the admin for a setup link.';
      authBtn.disabled = false;
      return;
    }
    const authResp = await startAuthentication({ optionsJSON: options });

    const verRes = await fetch('/auth/login-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: authResp }),
    });
    const verData = await verRes.json();

    if (verData.verified && verData.token) {
      sessionToken = verData.token;
      localStorage.setItem('clawtime_session', sessionToken);
      enterChat();
    } else {
      authError.textContent = verData.error || 'Authentication failed';
      authBtn.disabled = false;
    }
  } catch (err) {
    authError.textContent = getPasskeyErrorMessage(err, true);
    authBtn.disabled = false;
  }
}

authBtn.addEventListener('click', function() {
  if (isRegistered) { doLogin(); } else { doRegister(); }
});

// ─── Enter chat ───
function enterChat() {
  authScreen.style.display = 'none';
  chatUi.classList.add('active');
  setStatus('connecting');
  connectWs();
  inputEl.focus();
  if (CFG.enableAvatar && window.initAvatarScene) window.initAvatarScene();
  initSeparator();
  if (window.loadTaskBadge) setTimeout(window.loadTaskBadge, 500);

  messagesEl.addEventListener('scroll', function() {
    if (messagesEl.scrollTop < 80 && historyIndex > 0 && !loadingMore) {
      loadOlderMessages();
    }
  });
}

// ─── Status ───
function setStatus(state) {
  connected = state === 'online';
  updateSendBtn();
  if (window.setAvatarConnection) window.setAvatarConnection(state);
}

// ─── Markdown Rendering ───
function renderMarkdown(text) {
  if (!text) return '';
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Extract code blocks first to protect them from other transformations
  const codeBlocks = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    const placeholder = '%%CODEBLOCK' + codeBlocks.length + '%%';
    codeBlocks.push('<pre><code class="lang-' + lang + '">' + code.trim() + '</code></pre>');
    return placeholder;
  });

  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Inline images: ![alt](url) → <img> with E2E fetch for self-hosted
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function(m, alt, url) {
    // For self-hosted images (relative URLs or same origin), fetch through encrypted WS
    if (url.startsWith('/') || url.indexOf(location.host) !== -1) {
      const relUrl = url.startsWith('/') ? url : new URL(url).pathname;
      // Check if we already have a blob URL cached for this resource
      const cached = window._e2eBlobCache && window._e2eBlobCache[relUrl];
      if (cached) {
        return '<img src="' + cached + '" alt="' + alt + '" style="max-width:100%;border-radius:8px;margin:6px 0;display:block">';
      }
      // Request through E2E channel (deduplicate — only fetch once per URL)
      if (!window._e2ePendingFetches) window._e2ePendingFetches = {};
      if (!window._e2ePendingFetches[relUrl]) {
        window._e2ePendingFetches[relUrl] = true;
        setTimeout(function() { secureSend(JSON.stringify({ type: 'fetch_resource', url: relUrl })); }, 0);
      }
      return '<img alt="' + alt + '" style="max-width:100%;border-radius:8px;margin:6px 0;display:block" data-e2e-url="' + relUrl + '">';
    }
    return '<img src="' + url + '" alt="' + alt + '" style="max-width:100%;border-radius:8px;margin:6px 0;display:block" loading="lazy">';
  });
  // Audio player for /tts/ links: [label](/tts/file.mp3) → audio player
  s = s.replace(/\[([^\]]*)\]\((\/tts\/[^)]+\.mp3)\)/g, '<div style="margin:6px 0"><div style="font-size:13px;margin-bottom:4px">$1</div><audio controls style="width:100%;height:36px" src="$2"></audio></div>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, label, url) {
    const isFile = /\.(pdf|zip|doc|docx|xls|xlsx|csv|txt)(\?.*)?$/i.test(url);
    if (isFile) {
      const fname = url.split('/').pop().split('?')[0];
      return '<a href="' + url + '" onclick="event.preventDefault();window.openFileViewer(\'' + url + '\',\'' + fname + '\')" rel="noopener">' + label + '</a>';
    }
    return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
  });
  s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(?<!<\/ul>)((?:<li>.*<\/li>\n?)+)(?!<\/ul>)/g, function(m) {
    return '<ol>' + m + '</ol>';
  });
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/<\/blockquote>\n<blockquote>/g, '<br>');
  s = s.replace(/^---+$/gm, '<hr>');
  s = s.replace(/\n\n/g, '</p><p>');
  s = s.replace(/\n/g, '<br>');

  // Restore code blocks AFTER newline conversion (so <br> doesn't appear inside <pre>)
  codeBlocks.forEach(function(block, i) {
    s = s.replace('%%CODEBLOCK' + i + '%%', block);
  });

  if (!/^<(h[2-4]|pre|ul|ol|blockquote|hr|p)/.test(s)) {
    s = '<p>' + s + '</p>';
  }
  s = s.replace(/<p><\/p>/g, '');

  return s;
}

function setBubbleContent(bubble, text) {
  const timeEl = bubble.querySelector('.msg-time');
  const quoteEl = bubble.querySelector('.reply-quote');
  
  // Extract widgets from text
  const extracted = extractWidgets(text);
  text = extracted.text;
  const widgets = extracted.widgets;
  
  bubble.innerHTML = '';
  bubble.dataset.rawText = text;
  if (quoteEl) bubble.appendChild(quoteEl);
  const contentDiv = document.createElement('div');
  try {
    contentDiv.innerHTML = renderMarkdown(text);
  } catch (e) {
    console.error('[Markdown] Render error:', e);
    contentDiv.textContent = text; // Fallback to plain text
  }
  bubble.appendChild(contentDiv);
  
  // Render extracted widgets
  for (let i = 0; i < widgets.length; i++) {
    const widgetEl = renderWidget(widgets[i]);
    if (widgetEl) bubble.appendChild(widgetEl);
  }
  
  if (timeEl) bubble.appendChild(timeEl);
}

// ─── Message Context Menu & Reply ───
let contextMenu = null;
let replyTarget = null;
let longPressTimer = null;

function showContextMenu(x, y, bubbleEl, sender) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';

  const copyBtn = document.createElement('button');
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
  copyBtn.onclick = function() {
    const rawText = bubbleEl.dataset.rawText || bubbleEl.innerText.replace(/\d{2}:\d{2}\s*(AM|PM)?$/m, '').trim();
    navigator.clipboard.writeText(rawText).then(function() {
      copyBtn.innerHTML = '✅ Copied!';
      setTimeout(hideContextMenu, 600);
    });
  };
  menu.appendChild(copyBtn);

  const replyBtn = document.createElement('button');
  replyBtn.innerHTML = '↩️ Reply';
  replyBtn.onclick = function() {
    const rawText = bubbleEl.dataset.rawText || bubbleEl.innerText.replace(/\d{2}:\d{2}\s*(AM|PM)?$/m, '').trim();
    setReplyTarget(sender, rawText, bubbleEl);
    hideContextMenu();
  };
  menu.appendChild(replyBtn);

  document.body.appendChild(menu);
  contextMenu = menu;

  const rect = menu.getBoundingClientRect();
  const mx = Math.min(x, window.innerWidth - rect.width - 10);
  const my = Math.min(y, window.innerHeight - rect.height - 10);
  menu.style.left = Math.max(5, mx) + 'px';
  menu.style.top = Math.max(5, my) + 'px';
}

function hideContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

function setReplyTarget(sender, text, bubbleEl) {
  replyTarget = { sender: sender, text: text, bubbleEl: bubbleEl };
  const replyBar = document.getElementById('replyBar');
  document.getElementById('replyBarSender').textContent = sender === 'bot' ? CFG.botName : 'You';
  document.getElementById('replyBarText').textContent = text.length > 120 ? text.slice(0, 120) + '…' : text;
  replyBar.classList.add('active');
  document.getElementById('input').focus();
}

function clearReply() {
  replyTarget = null;
  document.getElementById('replyBar').classList.remove('active');
}

document.getElementById('replyBarClose').addEventListener('click', clearReply);

document.addEventListener('click', function(e) {
  if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
});

messagesEl.addEventListener('contextmenu', function(e) {
  const bubble = e.target.closest('.bubble');
  if (!bubble) return;
  e.preventDefault();
  const msg = bubble.closest('.message');
  const sender = msg && msg.classList.contains('user') ? 'user' : 'bot';
  showContextMenu(e.clientX, e.clientY, bubble, sender);
});

messagesEl.addEventListener('touchstart', function(e) {
  const bubble = e.target.closest('.bubble');
  if (!bubble) return;
  longPressTimer = setTimeout(function() {
    const touch = e.touches[0];
    const msg = bubble.closest('.message');
    const sender = msg && msg.classList.contains('user') ? 'user' : 'bot';
    showContextMenu(touch.clientX, touch.clientY, bubble, sender);
  }, 500);
}, { passive: true });

messagesEl.addEventListener('touchend', function() { clearTimeout(longPressTimer); });
messagesEl.addEventListener('touchmove', function() { clearTimeout(longPressTimer); });

// ─── Chat Messages ───
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Extract [[WIDGET:{...}]] from text, return { text, widgets }
function extractWidgets(text) {
  if (!text) return { text: text, widgets: [] };
  const widgets = [];
  const cleaned = text.replace(/\[\[WIDGET:([\s\S]*?)\]\]/g, function(match, json) {
    try {
      widgets.push(JSON.parse(json));
    } catch (e) {
      console.error('[Widget] Failed to parse:', json, e);
    }
    return '';
  });
  return { text: cleaned.trim(), widgets: widgets };
}

function addMessage(text, sender, opts) {
  opts = opts || {};
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  // Extract widgets from text (bot messages only)
  let extractedWidgets = [];
  if (sender === 'bot') {
    const extracted = extractWidgets(text);
    text = extracted.text;
    extractedWidgets = extracted.widgets;
  }

  const div = document.createElement('div');
  div.className = 'message ' + sender;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = sender === 'bot' ? CFG.botEmoji : '👤';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.dataset.rawText = text;

  if (opts.replyTo) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    const qs = document.createElement('div');
    qs.className = 'reply-quote-sender';
    qs.textContent = opts.replyTo.sender === 'bot' ? CFG.botName : 'You';
    const qt = document.createElement('div');
    qt.className = 'reply-quote-text';
    qt.textContent = opts.replyTo.text.length > 80 ? opts.replyTo.text.slice(0, 80) + '…' : opts.replyTo.text;
    quote.appendChild(qs);
    quote.appendChild(qt);
    if (opts.replyTo.bubbleEl) {
      quote.addEventListener('click', function() {
        opts.replyTo.bubbleEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        opts.replyTo.bubbleEl.style.outline = '2px solid var(--accent)';
        setTimeout(function() { opts.replyTo.bubbleEl.style.outline = ''; }, 1500);
      });
    }
    bubble.appendChild(quote);
  }

  if (sender === 'bot') {
    const contentDiv = document.createElement('div');
    contentDiv.innerHTML = renderMarkdown(text);
    bubble.appendChild(contentDiv);
  } else {
    bubble.appendChild(document.createTextNode(text));
  }

  // Render extracted widgets inside the bubble
  for (let i = 0; i < extractedWidgets.length; i++) {
    const widgetEl = renderWidget(extractedWidgets[i]);
    if (widgetEl) bubble.appendChild(widgetEl);
  }

  const timeStr = formatTime(opts.timestamp || Date.now());
  if (timeStr) {
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-time';
    timeEl.textContent = timeStr;
    bubble.appendChild(timeEl);
  }

  div.appendChild(avatar);
  div.appendChild(bubble);

  if (opts.prepend && opts.beforeEl) {
    messagesEl.insertBefore(div, opts.beforeEl);
  } else {
    messagesEl.appendChild(div);
  }

  if (!opts.noScroll) {
    // Only auto-scroll if user is near the bottom (not scrolled up reading history)
    const isNearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150;
    if (isNearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  return bubble;
}

function processChatEvent(msg) {
  let state = msg.state, messageId = msg.messageId, text = msg.text || '', error = msg.error, images = msg.images || [];
  
  // Guard: if no messageId, generate a temporary one
  if (!messageId) {
    console.warn('[chat] Missing messageId, generating temporary');
    messageId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  // Find existing bubble by messageId in DOM (stable across deltas, unique per message)
  const existingBubble = messagesEl.querySelector('[data-msgid="' + messageId + '"]');
  
  if (state === 'delta') {
    hideTyping();
    activeRunning = true;
    
    if (existingBubble) {
      // Update existing bubble
      const existingTimeEl = existingBubble.querySelector('.msg-time');
      setBubbleContent(existingBubble, text);
      if (existingTimeEl) existingBubble.appendChild(existingTimeEl);
    } else {
      // Create new bubble with data-msgid
      const bubble = addMessage(text, 'bot', { timestamp: Date.now() });
      bubble.setAttribute('data-msgid', messageId);
    }
    
    if ((messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    // Avatar state now handled by server

  } else if (state === 'final') {
    hideTyping();
    if (text) {
      if (existingBubble) {
        // Update existing bubble with final content
        setBubbleContent(existingBubble, text);
        existingBubble.removeAttribute('data-msgid'); // Done streaming
      } else {
        // Create new bubble (no streaming happened)
        addMessage(text, 'bot', { timestamp: Date.now() });
      }
    }
    // Render inline images from bot response
    if (images && images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        addImageMessage('', 'bot', images[i], { timestamp: Date.now() });
      }
    }
    if ((messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    activeRunning = false;
    // Avatar state now handled by server

  } else if (state === 'error') {
    hideTyping();
    activeRunning = false;
    const errorText = error || 'Something went wrong';
    // Remove any streaming bubble for this runId
    if (existingBubble) existingBubble.remove();
    addMessage('Error: ' + errorText, 'bot', { timestamp: Date.now() });
    // Avatar state handled by server

  } else if (state === 'aborted') {
    hideTyping();
    activeRunning = false;
    // Remove any streaming bubble for this runId
    if (existingBubble) existingBubble.remove();
    // Avatar state handled by server
  }
}

// ─── Widget System ───
const activeWidgets = new Map(); // id -> { element, data, type }

function sendWidgetResponse(id, widgetType, value, action) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const response = {
    type: 'widget_response',
    id: id,
    widget: widgetType,
    value: value,
    action: action || 'submit'
  };
  ws.send(JSON.stringify(response));
}

function renderWidget(widgetData) {
  const id = widgetData.id;
  const type = widgetData.widget;
  // Merge top-level properties into data (allows both formats)
  // Copy all properties except meta fields
  const data = Object.assign({}, widgetData.data || {});
  const skipKeys = ['id', 'widget', 'type', 'data', 'inline'];
  Object.keys(widgetData).forEach(function(key) {
    if (skipKeys.indexOf(key) === -1 && widgetData[key] !== undefined) {
      data[key] = widgetData[key];
    }
  });
  const inline = widgetData.inline || false;
  
  // Check if updating existing widget
  const existing = activeWidgets.get(id);
  if (existing && type === 'progress') {
    // Update progress in place
    updateProgressWidget(existing.element, data);
    return existing.element;
  }
  
  const container = document.createElement('div');
  container.className = 'widget widget-' + type + (inline ? ' widget-inline' : '');
  container.dataset.widgetId = id;
  container.dataset.widgetType = type;
  
  switch (type) {
    case 'buttons':
      renderButtonsWidget(container, id, data);
      break;
    case 'confirm':
      renderConfirmWidget(container, id, data);
      break;
    case 'code':
      renderCodeWidget(container, id, data);
      break;
    case 'progress':
      renderProgressWidget(container, id, data);
      break;
    case 'form':
      renderFormWidget(container, id, data);
      break;
    case 'datepicker':
      renderDatepickerWidget(container, id, data);
      break;
    case 'carousel':
      renderCarouselWidget(container, id, data);
      break;
    default:
      container.textContent = '[Unknown widget: ' + type + ']';
  }
  
  activeWidgets.set(id, { element: container, data: data, type: type });
  
  // Add to messages area
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  messagesEl.appendChild(container);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  
  return container;
}

function renderButtonsWidget(container, id, data) {
  const promptText = data.prompt || data.label;
  if (promptText) {
    const prompt = document.createElement('div');
    prompt.className = 'widget-prompt';
    prompt.textContent = promptText;
    container.appendChild(prompt);
  }
  
  const btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group' + (data.layout === 'vertical' ? ' vertical' : '');
  
  const options = data.options || data.buttons || [];
  options.forEach(function(opt) {
    const btn = document.createElement('button');
    btn.className = 'widget-btn';
    
    if (typeof opt === 'string') {
      btn.textContent = opt;
      btn.dataset.value = opt;
    } else {
      btn.textContent = opt.label || opt.value;
      btn.dataset.value = opt.value !== undefined ? opt.value : opt.label;
      if (opt.style === 'primary') btn.classList.add('primary');
      if (opt.style === 'secondary') btn.classList.add('secondary');
      if (opt.style === 'danger') btn.classList.add('danger');
    }
    
    btn.addEventListener('click', function() {
      if (container.classList.contains('disabled')) return;
      
      if (data.multiSelect) {
        btn.classList.toggle('selected');
      } else {
        // Single select - disable widget and send response
        container.classList.add('disabled');
        btn.classList.add('selected');
        sendWidgetResponse(id, 'buttons', btn.dataset.value, 'submit');
      }
    });
    
    btnGroup.appendChild(btn);
  });
  
  container.appendChild(btnGroup);
  
  if (data.multiSelect) {
    const submitBtn = document.createElement('button');
    submitBtn.className = 'widget-btn primary widget-submit';
    submitBtn.textContent = 'Submit';
    submitBtn.addEventListener('click', function() {
      if (container.classList.contains('disabled')) return;
      const selected = Array.from(btnGroup.querySelectorAll('.selected')).map(function(b) {
        return b.dataset.value;
      });
      container.classList.add('disabled');
      sendWidgetResponse(id, 'buttons', selected, 'submit');
    });
    container.appendChild(submitBtn);
  }
}

function renderConfirmWidget(container, id, data) {
  if (data.title) {
    const title = document.createElement('div');
    title.className = 'widget-title';
    title.textContent = data.title;
    container.appendChild(title);
  }
  
  const messageText = data.message || data.label;
  if (messageText) {
    const msg = document.createElement('div');
    msg.className = 'widget-message';
    msg.textContent = messageText;
    container.appendChild(msg);
  }
  
  const btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'widget-btn secondary';
  cancelBtn.textContent = data.cancelLabel || 'Cancel';
  cancelBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    container.classList.add('disabled');
    sendWidgetResponse(id, 'confirm', false, 'cancel');
  });
  
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'widget-btn ' + (data.confirmStyle === 'danger' ? 'danger' : 'primary');
  confirmBtn.textContent = data.confirmLabel || 'Confirm';
  confirmBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    container.classList.add('disabled');
    sendWidgetResponse(id, 'confirm', true, 'submit');
  });
  
  btnGroup.appendChild(cancelBtn);
  btnGroup.appendChild(confirmBtn);
  container.appendChild(btnGroup);
}

function renderCodeWidget(container, id, data) {
  if (data.filename) {
    const header = document.createElement('div');
    header.className = 'widget-code-header';
    header.textContent = data.filename;
    container.appendChild(header);
  }
  
  const pre = document.createElement('pre');
  pre.className = 'widget-code-block';
  if (data.language) pre.dataset.language = data.language;
  if (data.wrap) pre.style.whiteSpace = 'pre-wrap';
  
  const code = document.createElement('code');
  code.textContent = data.code || '';
  pre.appendChild(code);
  container.appendChild(pre);
  
  const actions = document.createElement('div');
  actions.className = 'widget-code-actions';
  
  if (data.showCopy !== false) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'widget-btn small';
    copyBtn.innerHTML = '📋 Copy';
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(data.code || '').then(function() {
        copyBtn.innerHTML = '✓ Copied';
        setTimeout(function() { copyBtn.innerHTML = '📋 Copy'; }, 2000);
        sendWidgetResponse(id, 'code', null, 'copy');
      });
    });
    actions.appendChild(copyBtn);
  }
  
  if (data.showRun) {
    const runBtn = document.createElement('button');
    runBtn.className = 'widget-btn small primary';
    runBtn.innerHTML = '▶ Run';
    runBtn.addEventListener('click', function() {
      sendWidgetResponse(id, 'code', null, 'run');
    });
    actions.appendChild(runBtn);
  }
  
  container.appendChild(actions);
}

function renderProgressWidget(container, id, data) {
  if (data.label) {
    const label = document.createElement('div');
    label.className = 'widget-progress-label';
    label.textContent = data.label;
    container.appendChild(label);
  }
  
  const barOuter = document.createElement('div');
  barOuter.className = 'widget-progress-bar';
  
  const barInner = document.createElement('div');
  barInner.className = 'widget-progress-fill';
  if (data.percent != null) {
    barInner.style.width = data.percent + '%';
  } else {
    barInner.classList.add('indeterminate');
  }
  
  barOuter.appendChild(barInner);
  container.appendChild(barOuter);
  
  const footer = document.createElement('div');
  footer.className = 'widget-progress-footer';
  
  if (data.status) {
    const status = document.createElement('span');
    status.className = 'widget-progress-status';
    status.textContent = data.status;
    footer.appendChild(status);
  }
  
  if (data.showPercent && data.percent != null) {
    const pct = document.createElement('span');
    pct.className = 'widget-progress-percent';
    pct.textContent = data.percent + '%';
    footer.appendChild(pct);
  }
  
  if (data.cancelable) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'widget-btn small secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() {
      container.classList.add('disabled');
      sendWidgetResponse(id, 'progress', null, 'cancel');
    });
    footer.appendChild(cancelBtn);
  }
  
  container.appendChild(footer);
}

function renderDatepickerWidget(container, id, data) {
  if (data.label) {
    const label = document.createElement('div');
    label.className = 'widget-prompt';
    label.textContent = data.label;
    container.appendChild(label);
  }
  
  const inputWrap = document.createElement('div');
  inputWrap.className = 'widget-datepicker-wrap';
  
  const input = document.createElement('input');
  input.className = 'widget-form-input widget-datepicker-input';
  input.type = data.type || 'date'; // date, time, datetime-local
  if (data.value) input.value = data.value;
  if (data.min) input.min = data.min;
  if (data.max) input.max = data.max;
  input.dataset.fieldName = 'value';
  inputWrap.appendChild(input);
  container.appendChild(inputWrap);
  
  const btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group';
  
  const submitBtn = document.createElement('button');
  submitBtn.className = 'widget-btn primary';
  submitBtn.textContent = data.submitLabel || 'Select';
  submitBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    if (data.required && !input.value) {
      input.classList.add('widget-form-error');
      return;
    }
    container.classList.add('disabled');
    sendWidgetResponse(id, 'datepicker', input.value, 'submit');
  });
  
  btnGroup.appendChild(submitBtn);
  container.appendChild(btnGroup);
}

function renderCarouselWidget(container, id, data) {
  const items = data.items || [];
  if (items.length === 0) return;
  
  let currentIndex = 0;
  
  const carousel = document.createElement('div');
  carousel.className = 'widget-carousel';
  
  const viewport = document.createElement('div');
  viewport.className = 'widget-carousel-viewport';
  
  const track = document.createElement('div');
  track.className = 'widget-carousel-track';
  
  items.forEach(function(item, idx) {
    const slide = document.createElement('div');
    slide.className = 'widget-carousel-slide';
    
    if (item.type === 'image' || item.image || item.url) {
      const img = document.createElement('img');
      img.src = item.url || item.image;
      img.alt = item.caption || item.title || '';
      slide.appendChild(img);
    }
    
    if (item.title || item.caption || item.description) {
      const info = document.createElement('div');
      info.className = 'widget-carousel-info';
      if (item.title) {
        const title = document.createElement('div');
        title.className = 'widget-carousel-title';
        title.textContent = item.title;
        info.appendChild(title);
      }
      if (item.caption || item.description) {
        const desc = document.createElement('div');
        desc.className = 'widget-carousel-desc';
        desc.textContent = item.caption || item.description;
        info.appendChild(desc);
      }
      slide.appendChild(info);
    }
    
    if (data.selectable) {
      slide.style.cursor = 'pointer';
      slide.addEventListener('click', function() {
        if (container.classList.contains('disabled')) return;
        container.classList.add('disabled');
        sendWidgetResponse(id, 'carousel', { index: idx, item: item }, 'submit');
      });
    }
    
    track.appendChild(slide);
  });
  
  viewport.appendChild(track);
  carousel.appendChild(viewport);
  
  function goTo(idx) {
    currentIndex = Math.max(0, Math.min(items.length - 1, idx));
    track.style.transform = 'translateX(-' + (currentIndex * 100) + '%)';
    updateDots();
  }
  
  if (data.showArrows !== false && items.length > 1) {
    const prevBtn = document.createElement('button');
    prevBtn.className = 'widget-carousel-arrow prev';
    prevBtn.innerHTML = '‹';
    prevBtn.addEventListener('click', function() { goTo(currentIndex - 1); });
    carousel.appendChild(prevBtn);
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'widget-carousel-arrow next';
    nextBtn.innerHTML = '›';
    nextBtn.addEventListener('click', function() { goTo(currentIndex + 1); });
    carousel.appendChild(nextBtn);
  }
  
  let dots;
  function updateDots() {
    if (!dots) return;
    const dotEls = dots.querySelectorAll('.widget-carousel-dot');
    dotEls.forEach(function(d, i) {
      d.classList.toggle('active', i === currentIndex);
    });
  }
  
  if (data.showDots !== false && items.length > 1) {
    dots = document.createElement('div');
    dots.className = 'widget-carousel-dots';
    items.forEach(function(_, idx) {
      const dot = document.createElement('button');
      dot.className = 'widget-carousel-dot' + (idx === 0 ? ' active' : '');
      dot.addEventListener('click', function() { goTo(idx); });
      dots.appendChild(dot);
    });
    carousel.appendChild(dots);
  }
  
  container.appendChild(carousel);
}

function applyWidgetResponse(container, widgetType, data, response) {
  container.classList.add('disabled');
  
  switch (widgetType) {
    case 'buttons': {
      // Highlight the selected button
      const buttons = container.querySelectorAll('.widget-btn');
      buttons.forEach(function(btn) {
        if (btn.dataset.value === response.value || 
            (Array.isArray(response.value) && response.value.includes(btn.dataset.value))) {
          btn.classList.add('selected');
        }
      });
      break;
    }
    case 'confirm': {
      // Show which option was chosen
      const btns = container.querySelectorAll('.widget-btn');
      btns.forEach(function(btn) {
        if ((response.value && btn.classList.contains('primary')) ||
            (!response.value && btn.classList.contains('secondary'))) {
          btn.classList.add('selected');
        }
      });
      break;
    }
    case 'form': {
      // Fill in the form values
      if (response.value && typeof response.value === 'object') {
        Object.keys(response.value).forEach(function(key) {
          const input = container.querySelector('[data-field-name="' + key + '"]');
          if (input) {
            if (input.type === 'checkbox') {
              input.checked = !!response.value[key];
            } else if (input._isRadioGroup) {
              const radio = input.querySelector('input[value="' + response.value[key] + '"]');
              if (radio) radio.checked = true;
            } else {
              input.value = response.value[key] || '';
            }
          }
        });
      }
      break;
    }
    case 'datepicker': {
      const dateInput = container.querySelector('.widget-datepicker-input');
      if (dateInput && response.value) {
        dateInput.value = response.value;
      }
      break;
    }
    case 'carousel': {
      if (response.value && typeof response.value.index === 'number') {
        const slides = container.querySelectorAll('.widget-carousel-slide');
        if (slides[response.value.index]) {
          slides[response.value.index].style.outline = '3px solid var(--accent)';
        }
      }
      break;
    }
    // code and progress don't need special response handling
  }
}

function updateProgressWidget(container, data) {
  const fill = container.querySelector('.widget-progress-fill');
  if (fill) {
    if (data.percent != null) {
      fill.style.width = data.percent + '%';
      fill.classList.remove('indeterminate');
    } else {
      fill.classList.add('indeterminate');
    }
  }
  
  const label = container.querySelector('.widget-progress-label');
  if (label && data.label) label.textContent = data.label;
  
  const status = container.querySelector('.widget-progress-status');
  if (status && data.status) status.textContent = data.status;
  
  const pct = container.querySelector('.widget-progress-percent');
  if (pct && data.percent != null) pct.textContent = data.percent + '%';
}

function renderFormWidget(container, id, data) {
  if (data.title) {
    const title = document.createElement('div');
    title.className = 'widget-title';
    title.textContent = data.title;
    container.appendChild(title);
  }
  
  const form = document.createElement('div');
  form.className = 'widget-form-fields';
  
  const fields = data.fields || [];
  fields.forEach(function(field) {
    const fieldDiv = document.createElement('div');
    fieldDiv.className = 'widget-form-field';
    
    if (field.label) {
      const label = document.createElement('label');
      label.className = 'widget-form-label';
      label.textContent = field.label;
      if (field.required) {
        const req = document.createElement('span');
        req.className = 'widget-form-required';
        req.textContent = ' *';
        label.appendChild(req);
      }
      fieldDiv.appendChild(label);
    }
    
    let input;
    switch (field.type) {
      case 'textarea':
        input = document.createElement('textarea');
        input.className = 'widget-form-input widget-form-textarea';
        input.rows = field.rows || 3;
        break;
      case 'select':
        input = document.createElement('select');
        input.className = 'widget-form-input widget-form-select';
        (field.options || []).forEach(function(opt) {
          const option = document.createElement('option');
          if (typeof opt === 'string') {
            option.value = opt;
            option.textContent = opt;
          } else {
            option.value = opt.value;
            option.textContent = opt.label || opt.value;
          }
          input.appendChild(option);
        });
        break;
      case 'checkbox': {
        const checkWrap = document.createElement('div');
        checkWrap.className = 'widget-form-checkbox-wrap';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'widget-form-checkbox';
        const checkLabel = document.createElement('span');
        checkLabel.textContent = field.checkLabel || '';
        checkWrap.appendChild(input);
        checkWrap.appendChild(checkLabel);
        fieldDiv.appendChild(checkWrap);
        input._isCheckbox = true;
        break;
      }
      case 'radio': {
        const radioGroup = document.createElement('div');
        radioGroup.className = 'widget-form-radio-group';
        (field.options || []).forEach(function(opt, _idx) {
          const radioWrap = document.createElement('label');
          radioWrap.className = 'widget-form-radio-wrap';
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'field-' + field.name;
          radio.value = typeof opt === 'string' ? opt : opt.value;
          const radioLabel = document.createElement('span');
          radioLabel.textContent = typeof opt === 'string' ? opt : (opt.label || opt.value);
          radioWrap.appendChild(radio);
          radioWrap.appendChild(radioLabel);
          radioGroup.appendChild(radioWrap);
        });
        fieldDiv.appendChild(radioGroup);
        input = radioGroup;
        input._isRadioGroup = true;
        break;
      }
      default:
        input = document.createElement('input');
        input.type = field.type || 'text';
        input.className = 'widget-form-input';
    }
    
    if (!input._isCheckbox && !input._isRadioGroup) {
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.value) input.value = field.value;
      if (field.required) input.required = true;
      fieldDiv.appendChild(input);
    }
    
    input.dataset.fieldName = field.name;
    form.appendChild(fieldDiv);
  });
  
  container.appendChild(form);
  
  const btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group widget-form-buttons';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'widget-btn secondary';
  cancelBtn.textContent = data.cancelLabel || 'Cancel';
  cancelBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    container.classList.add('disabled');
    sendWidgetResponse(id, 'form', null, 'cancel');
  });
  
  const submitBtn = document.createElement('button');
  submitBtn.className = 'widget-btn primary';
  submitBtn.textContent = data.submitLabel || 'Submit';
  submitBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    
    const values = {};
    let valid = true;
    
    fields.forEach(function(field) {
      const el = form.querySelector('[data-field-name="' + field.name + '"]');
      if (!el) return;
      
      if (el._isCheckbox) {
        values[field.name] = el.checked;
      } else if (el._isRadioGroup) {
        const checked = el.querySelector('input:checked');
        values[field.name] = checked ? checked.value : null;
      } else if (field.type === 'number' || field.type === 'range') {
        values[field.name] = el.value ? parseFloat(el.value) : null;
      } else {
        values[field.name] = el.value;
      }
      
      if (field.required && !values[field.name]) {
        valid = false;
        el.classList.add('widget-form-error');
      } else {
        el.classList.remove('widget-form-error');
      }
    });
    
    if (!valid) return;
    
    container.classList.add('disabled');
    sendWidgetResponse(id, 'form', values, 'submit');
  });
  
  btnGroup.appendChild(cancelBtn);
  btnGroup.appendChild(submitBtn);
  container.appendChild(btnGroup);
}

// ─── Speech preview (live transcription in chat area) ───
let speechPreviewEl = null;

function showSpeechPreview(text) {
  // Show in messages area as pending bubble (real-time transcript)
  if (!speechPreviewEl) {
    const div = document.createElement('div');
    div.className = 'message user speech-preview';

    const bubble = document.createElement('div');
    bubble.className = 'bubble user';
    bubble.style.opacity = '0.7';
    bubble.style.borderStyle = 'dashed';
    bubble.style.borderColor = 'rgba(255, 255, 255, 0.5)';
    bubble.style.borderWidth = '2px';

    div.appendChild(bubble);
    messagesEl.appendChild(div);
    speechPreviewEl = { container: div, bubble: bubble };
  }
  speechPreviewEl.bubble.textContent = text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideSpeechPreview() {
  // Remove pending message bubble
  if (speechPreviewEl) {
    speechPreviewEl.container.remove();
    speechPreviewEl = null;
  }
}

function showTyping() {
  if (typingEl) return;
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'message bot';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = CFG.botEmoji;

  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.innerHTML = '<span></span><span></span><span></span>';

  div.appendChild(avatar);
  div.appendChild(typing);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  typingEl = div;

  if (window.setAvatarState) setAvatarState('thinking');
}

function hideTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

// ─── E2E Resource Cache ───
window._e2eBlobCache = {};       // url → blob URL (cached)
window._e2ePendingFetches = {};  // url → true (dedup in-flight requests)

// ─── E2E Encryption (ECDH P-256 + AES-256-GCM) ───
// Client generates an ephemeral ECDH keypair, exchanges public keys with
// the server, derives a shared secret, then uses HKDF to produce an
// AES-256-GCM key. All messages after handshake are encrypted.
// See server.js § 11 for the full protocol description.
let e2eKey = null; // CryptoKey for AES-GCM
let e2eReady = false;
let e2ePendingOutbound = [];

async function e2eInit(serverPubKeyB64) {
  try {
    // Generate client ECDH keypair
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveBits']
    );
    // Import server public key (raw format from base64 uncompressed point)
    const serverPubRaw = Uint8Array.from(atob(serverPubKeyB64), function(c) { return c.charCodeAt(0); });
    const serverPubKey = await crypto.subtle.importKey(
      'raw', serverPubRaw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );
    // Derive shared secret bits
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverPubKey },
      keyPair.privateKey, 256
    );
    // HKDF: import shared secret as key material
    const hkdfKey = await crypto.subtle.importKey(
      'raw', sharedBits, 'HKDF', false, ['deriveKey']
    );
    const salt = new TextEncoder().encode('clawtime-e2e-salt');
    const info = new TextEncoder().encode('clawtime-e2e-key');
    e2eKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
    // Export client public key and send to server
    const clientPubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const clientPubB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(clientPubRaw)));
    ws.send(JSON.stringify({ type: 'e2e_key', clientPublicKey: clientPubB64 }));
  } catch (err) {
    console.error('[E2E] Init failed:', err);
  }
}

// DECISION: Chunked base64 encoding — String.fromCharCode.apply() throws
// "Maximum call stack size exceeded" on large Uint8Arrays (e.g., TTS audio)
// because .apply() spreads the entire array as function arguments. We chunk
// at 8192 bytes to stay well within the stack limit on all browsers.
function uint8ToBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

async function e2eEncrypt(plaintext) {
  if (!e2eKey) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    e2eKey,
    new TextEncoder().encode(plaintext)
  );
  // AES-GCM output includes tag appended to ciphertext
  const encBytes = new Uint8Array(enc);
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const tag = encBytes.slice(encBytes.length - 16);
  return JSON.stringify({
    _e2e: true,
    iv: uint8ToBase64(iv),
    tag: uint8ToBase64(tag),
    data: uint8ToBase64(ciphertext),
  });
}

async function e2eDecrypt(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg._e2e || !e2eKey) return raw;
    const iv = Uint8Array.from(atob(msg.iv), function(c) { return c.charCodeAt(0); });
    const tag = Uint8Array.from(atob(msg.tag), function(c) { return c.charCodeAt(0); });
    const data = Uint8Array.from(atob(msg.data), function(c) { return c.charCodeAt(0); });
    // Reassemble ciphertext + tag for Web Crypto (AES-GCM expects them concatenated)
    const combined = new Uint8Array(data.length + tag.length);
    combined.set(data);
    combined.set(tag, data.length);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      e2eKey,
      combined
    );
    return new TextDecoder().decode(dec);
  } catch {
    return raw; // not encrypted or failed — pass through
  }
}

async function secureSend(data) {
  if (!ws || ws.readyState !== 1) return;
  if (e2eReady && e2eKey) {
    ws.send(await e2eEncrypt(data));
  } else {
    e2ePendingOutbound.push(data);
  }
}
window.secureSend = secureSend;

async function flushE2ePending() {
  for (let i = 0; i < e2ePendingOutbound.length; i++) {
    ws.send(await e2eEncrypt(e2ePendingOutbound[i]));
  }
  e2ePendingOutbound = [];
}

// ─── WebSocket ───
function connectWs() {
  if (ws) { ws.close(); ws = null; }
  // Reset E2E state on reconnect
  e2eKey = null;
  e2eReady = false;
  e2ePendingOutbound = [];

  // Generate unique visitor ID for this tab (for message dedup)
  if (!window._visitorId) {
    window._visitorId = Math.random().toString(36).slice(2, 10);
  }
  
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + location.host);

  // Heartbeat to detect dead connections
  let heartbeatInterval = null;
  let heartbeatTimeout = null;
  const HEARTBEAT_INTERVAL = 30000; // 30 seconds
  const HEARTBEAT_TIMEOUT = 10000;  // 10 seconds to respond
  
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
        heartbeatTimeout = setTimeout(function() {
          console.log('[WS] Heartbeat timeout - connection dead');
          ws.close();
        }, HEARTBEAT_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  }
  
  function stopHeartbeat() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  }
  
  function heartbeatReceived() {
    if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  }

  ws.onopen = function() {
    ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
    startHeartbeat();
  };

  ws.onmessage = async function(e) {
    try {
      // Decrypt if E2E is active, or pass through for handshake messages
      const rawData = e.data;
      let decrypted = rawData;
      try {
        const peek = JSON.parse(rawData);
        if (peek._e2e && e2eKey) {
          decrypted = await e2eDecrypt(rawData);
        }
      } catch(pe) { /* not JSON or not encrypted */ }
      const msg = JSON.parse(decrypted);

      if (msg.type === 'auth_ok') {
        setStatus('connecting');
        // Start E2E key exchange if server sent its public key
        if (msg.serverPublicKey) {
          e2eInit(msg.serverPublicKey);
        }
        return;
      }
      
      if (msg.type === 'auth_fail') {
        return;
      }

      // E2E key exchange complete
      if (msg.type === 'e2e_ready') {
        e2eReady = true;
        // E2E active — no title change (favicon only)
        flushE2ePending();
        // Re-send voice mode state after reconnection
        if (window.callActive) {
          secureSend(JSON.stringify({ type: 'voice_mode', enabled: true }));
        }
        return;
      }

      // E2E resource response — set blob URL on all matching images
      if (msg.type === 'resource_data' && msg.url && msg.data) {
        const bytes = atob(msg.data);
        const arr = new Uint8Array(bytes.length);
        for (let ri = 0; ri < bytes.length; ri++) arr[ri] = bytes.charCodeAt(ri);
        const blob = new Blob([arr], { type: msg.mimeType || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        // Cache for future re-renders
        if (!window._e2eBlobCache) window._e2eBlobCache = {};
        window._e2eBlobCache[msg.url] = blobUrl;
        if (window._e2ePendingFetches) delete window._e2ePendingFetches[msg.url];
        // Preserve scroll position when images load
        const prevScrollTop = messagesEl.scrollTop;
        const prevScrollHeight = messagesEl.scrollHeight;
        const wasAtBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 50;
        // Find all img elements waiting for this URL
        const imgs = document.querySelectorAll('img[data-e2e-url="' + msg.url + '"]');
        for (let ii = 0; ii < imgs.length; ii++) {
          imgs[ii].src = blobUrl;
          imgs[ii].removeAttribute('data-e2e-url');
        }
        // After image loads, stabilize scroll
        requestAnimationFrame(function() {
          if (wasAtBottom) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else {
            // Keep scroll position stable — adjust for height change
            const heightDiff = messagesEl.scrollHeight - prevScrollHeight;
            messagesEl.scrollTop = prevScrollTop + heightDiff;
          }
        });
        return;
      }

      // Server-side TTS audio — base64 data through encrypted WS
      if (msg.type === 'tts_audio' && msg.audioData) {
        // Decode base64 directly to ArrayBuffer — skip blob URLs (iOS compat)
        try {
          const audioBytes = atob(msg.audioData);
          var audioArr = new Uint8Array(audioBytes.length);
          for (let ai = 0; ai < audioBytes.length; ai++) audioArr[ai] = audioBytes.charCodeAt(ai);
        } catch(ttsErr) {
          console.error('[TTS] Failed to decode audio:', ttsErr);
          return;
        }
        window._ttsQueue = window._ttsQueue || [];
        window._ttsQueue.push(audioArr.buffer); // Push ArrayBuffer directly
        if (msg.runId) activeTTSRunId = msg.runId;
        // Restart mic for barge-in if not running
        if (window.callActive && !callRecognition) {
          startRecognition();
        }
        // Only start playback if nothing is currently playing
        if (!callPlaying && !activeTTSSource && !window._ttsAudioEl) {
          playNextTTSChunk();
        }
        return;
      }

      if (msg.type === 'auth_fail') {
        localStorage.removeItem('clawtime_session');
        sessionToken = null;
        authScreen.style.display = '';
        chatUi.classList.remove('active');
        authError.textContent = 'Session expired. Please sign in again.';
        authBtn.disabled = false;
        authBtn.style.display = '';
        authLabel.textContent = 'Authenticate to continue';
        authBtnText.textContent = 'Sign in with passkey';
        isRegistered = true;
        return;
      }

      if (msg.type === 'auth_required') return;

      if (msg.type === 'connected') {
        setStatus('online');
        secureSend(JSON.stringify({ type: 'get_history' }));
        // Restore exact avatar state from server
        if (msg.avatarState && window.setAvatarState) {
          // Use original function to avoid re-sending to server
          const origFn = window.setAvatarState._original || window.setAvatarState;
          origFn(msg.avatarState);
          if (msg.avatarState !== 'idle') activeRunning = true;
        }
        // Voice mode remembered — user taps avatar to restart
        return;
      }

      if (msg.type === 'pong') {
        heartbeatReceived();
        // Also clear health check timeout if pending
        if (ws._healthCheckTimeout) {
          clearTimeout(ws._healthCheckTimeout);
          ws._healthCheckTimeout = null;
        }
        return;
      }

      if (msg.type === 'disconnected') {
        setStatus('offline');
        return;
      }

      if (msg.type === 'error') {
        hideTyping();
        const errorText = msg.data || '';
        addMessage('Error: ' + errorText, 'bot', { timestamp: Date.now() });
        // Avatar state handled by server
        return;
      }

      if (msg.type === 'transcription') {
        hideTyping();
        // Remove transcribing placeholder
        if (window._whisperPlaceholder) {
          try { window._whisperPlaceholder.remove(); } catch(_e) { /* ignore */ }
          window._whisperPlaceholder = null;
        }
        if (msg.text) {
          addMessage(msg.text, 'user', { timestamp: Date.now() });
          showTyping();
          setCallStatus('thinking');
          if (window.setAvatarState) setAvatarState('thinking');
        } else if (sttActive && window.callActive) {
          // Empty transcription — restart recording
          startRecordingChunk();
        }
        return;
      }

      if (msg.type === 'stt_error') {
        hideTyping();
        // Remove transcribing placeholder
        if (window._whisperPlaceholder) {
          try { window._whisperPlaceholder.remove(); } catch(_e) { /* ignore */ }
          window._whisperPlaceholder = null;
        }
        addMessage('🎤 ' + (msg.error || 'Voice transcription failed'), 'bot', { timestamp: Date.now() });
        if (window.setAvatarState) setAvatarState('idle');
        return;
      }

      // ── Re-verify request from bot ──
      if (msg.type === 'reverify_request') {
        (function() {
          const reqId = msg.requestId || '';
          const reason = msg.reason || 'Sensitive operation requested';

          // Show confirmation dialog with context
          const modal = document.createElement('div');
          modal.className = 'passphrase-modal open';
          modal.innerHTML = '<div class="passphrase-card" style="max-width:360px;">' +
            '<h3>🔐 Identity Verification</h3>' +
            '<p class="desc" style="margin-bottom:12px;">' + reason.replace(/</g,'&lt;') + '</p>' +
            '<p class="desc" style="font-size:12px; margin-bottom:18px; color:var(--text-dim);">' + CFG.botName + ' needs to confirm your identity before proceeding.</p>' +
            '<div style="display:flex; gap:8px; justify-content:center;">' +
              '<button id="reverifyConfirm" style="background:var(--accent);">Verify with Face ID</button>' +
              '<button id="reverifyCancel" style="background:var(--surface2); border:1px solid var(--border);">Cancel</button>' +
            '</div></div>';
          document.body.appendChild(modal);

          document.getElementById('reverifyCancel').onclick = function() {
            document.body.removeChild(modal);
            secureSend(JSON.stringify({ type: 'reverify_result', requestId: reqId, verified: false, error: 'cancelled' }));
          };
          modal.onclick = function(e) { if (e.target === modal) document.getElementById('reverifyCancel').click(); };

          document.getElementById('reverifyConfirm').onclick = function() {
            document.body.removeChild(modal);
            fetch('/auth/reverify', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
              body: '{}'
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              return SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: data.options })
              .then(function(cred) {
                return fetch('/auth/reverify', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ challengeId: data.challengeId, response: cred })
                });
              });
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              secureSend(JSON.stringify({ type: 'reverify_result', requestId: reqId, verified: !!data.verified }));
            })
            .catch(function(e) {
              secureSend(JSON.stringify({ type: 'reverify_result', requestId: reqId, verified: false, error: e.message }));
            });
          };
        })();
        return;
      }

      // ── History: render past messages including inline images ──
      // Images in history come as base64 data URIs from the gateway's
      // content blocks (type: 'image' with source.data). We extract
      // them and render using addImageMessage() so they display inline
      // just like freshly-sent images.
      if (msg.type === 'history') {
        const rawMessages = msg.messages || [];
        
        // Check if we already have messages displayed (reconnect scenario)
        const existingMsgCount = messagesEl.querySelectorAll('.message').length;
        const isReconnect = existingMsgCount > 0;
        
        if (isReconnect) {
          // Reconnect — don't re-render, just update historyMessages for "load more"
          // This preserves any in-flight streaming messages
          historyMessages = [];
          for (let i = 0; i < rawMessages.length; i++) {
            const hm = rawMessages[i];
            const hmText = hm.text || (typeof hm.content === 'string' ? hm.content : '');
            if (hmText.trim()) {
              historyMessages.push({ role: hm.role === 'user' ? 'user' : 'bot', text: hmText, timestamp: hm.timestamp });
            }
          }
          historyIndex = Math.max(0, historyMessages.length - HISTORY_PAGE_SIZE);
          historyLoaded = true;
          return;
        }
        
        // First load — clear welcome and render history
        historyMessages = [];
        const welcome = messagesEl.querySelector('.welcome');
        if (welcome) welcome.remove();
        // Clear any streaming bubbles
        const streamingBubbles = messagesEl.querySelectorAll('[data-msgid]');
        for (let sb = 0; sb < streamingBubbles.length; sb++) {
          streamingBubbles[sb].removeAttribute('data-msgid');
        }
        hideTyping();
        
        for (let hi = 0; hi < rawMessages.length; hi++) {
          const historyMsg = rawMessages[hi];
          // Store format: { role: 'user'|'bot', text, images?, timestamp }
          // Also handle legacy gateway format (content blocks) for backwards compat
          const role = historyMsg.role === 'user' ? 'user' : 'bot';
          let msgText = '';
          let images = [];

          // Check for widget in history
          if (historyMsg.widget) {
            historyMessages.push({ role: 'bot', widget: historyMsg.widget, timestamp: historyMsg.timestamp || null });
            continue;
          }

          if (historyMsg.text !== undefined) {
            // New store format — simple text field
            msgText = historyMsg.text || '';
            images = historyMsg.images || [];
          } else if (Array.isArray(historyMsg.content)) {
            // Legacy gateway format — content blocks
            for (let ci = 0; ci < historyMsg.content.length; ci++) {
              const block = historyMsg.content[ci];
              if (block.type === 'text') {
                msgText += block.text || '';
              } else if (block.type === 'image' && block.source && block.source.data) {
                images.push('data:' + (block.source.media_type || 'image/jpeg') + ';base64,' + block.source.data);
              }
            }
          } else if (typeof historyMsg.content === 'string') {
            msgText = historyMsg.content;
          }

          if (msgText.trim() || images.length > 0) {
            historyMessages.push({ role: role, text: msgText, timestamp: historyMsg.timestamp || null, images: images });
          }
        }

        historyIndex = Math.max(0, historyMessages.length - HISTORY_PAGE_SIZE);
        const welcomeEl = messagesEl.querySelector('.welcome');
        if (welcomeEl) welcomeEl.remove();

        if (historyMessages.length > HISTORY_PAGE_SIZE) {
          showLoadMoreIndicator();
        }

        for (let i = historyIndex; i < historyMessages.length; i++) {
          const m = historyMessages[i];
          if (m.widget) {
            // Check if widget already rendered (dedup live vs history)
            const existingWidget = document.querySelector('[data-widget-id="' + m.widget.id + '"]');
            if (existingWidget) {
              // Widget exists - but apply response if it has one and widget isn't disabled
              if (m.widget.response && !existingWidget.classList.contains('disabled')) {
                applyWidgetResponse(existingWidget, m.widget.widget, m.widget.data, m.widget.response);
              }
              continue;
            }
            // Render widget from history (pass full widget object, renderWidget handles both formats)
            const widgetEl = renderWidget(m.widget);
            // If already responded, show response state and disable
            if (m.widget.response && widgetEl) {
              applyWidgetResponse(widgetEl, m.widget.widget, m.widget.data, m.widget.response);
            }
          } else if (m.images && m.images.length > 0) {
            addImageMessage(m.text, m.role, m.images, { timestamp: m.timestamp, noScroll: true });
          } else {
            addMessage(m.text, m.role, { timestamp: m.timestamp, noScroll: true });
          }
        }

        historyLoaded = true;
        for (let pi = 0; pi < pendingChatEvents.length; pi++) {
          processChatEvent(pendingChatEvents[pi]);
        }
        pendingChatEvents = [];

        messagesEl.style.scrollBehavior = 'auto';
        requestAnimationFrame(function() {
          messagesEl.scrollTop = messagesEl.scrollHeight;
          setTimeout(function() {
            messagesEl.scrollTop = messagesEl.scrollHeight;
            messagesEl.style.scrollBehavior = '';
          }, 150);
        });
        return;
      }

      // Handle history sync after reconnect (server pulled missed messages)
      if (msg.type === 'history_sync') {
        secureSend(JSON.stringify({ type: 'get_history' }));
        return;
      }

      // Handle avatar state updates from server (server is source of truth)
      if (msg.type === 'avatar_state' && window.setAvatarState) {
        setAvatarState(msg.state);
      }

      // Handle widget messages
      if (msg.type === 'widget') {
        renderWidget(msg);
        return;
      }

      if (msg.type === 'chat') {
        if (!historyLoaded) {
          pendingChatEvents.push(msg);
          return;
        }
        processChatEvent(msg);
      }
      
      // Handle user messages from other clients (sync across tabs)
      if (msg.type === 'user_message') {
        addMessage(msg.text, 'user', { timestamp: Date.now() });
      }
    } catch (err) {
      console.error('[WS] Message processing error:', err);
    }
  };

  ws.onclose = function(e) {
    stopHeartbeat();
    connected = false;
    
    if (chatUi.classList.contains('active')) {
      setStatus('offline');
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      
      // Don't reconnect if page is hidden (will reconnect on visibility change)
      if (document.visibilityState !== 'visible') {
        return;
      }
      
      // Don't reconnect if offline (will reconnect when online)
      if (!navigator.onLine) {
        return;
      }
      
      // Exponential backoff with jitter
      let attempts = 0;
      const maxAttempts = 15;
      const baseDelay = 1000;
      const maxDelay = 60000;
      
      function tryReconnect() {
        if (connected) return; // Already reconnected
        if (document.visibilityState !== 'visible') return; // Page hidden
        if (!navigator.onLine) return; // Offline
        
        attempts++;
        // Exponential backoff: 1s, 2s, 4s, 8s... capped at 60s
        let delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
        // Add jitter: ±25% to prevent thundering herd
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        delay = Math.round(delay + jitter);
        
        setStatus('reconnecting');
        
        reconnectTimer = setTimeout(function() {
          reconnectTimer = null;
          if (connected) return;
          
          connectWs();
          
          // Check if reconnect succeeded after connection timeout
          setTimeout(function() {
            if (!connected && attempts < maxAttempts) {
              tryReconnect();
            } else if (!connected) {
              setStatus('offline');
              // Don't reload - user can manually refresh or wait for visibility/online event
            }
          }, 5000); // Give 5s for connection to establish
        }, delay);
      }
      
      tryReconnect();
    }
  };

  ws.onerror = function(e) { 
    console.log('[WS] Error:', e);
    ws.close(); 
  };
}

// ─── Connection Stability: Visibility & Freeze Detection ───
let lastActiveTime = Date.now();
let visibilityReconnectScheduled = false;

// Track last activity to detect page freeze (iOS/mobile tab sleeping)
setInterval(function() {
  lastActiveTime = Date.now();
}, 5000);

// Detect page freeze: if gap between intervals is too large, page was frozen
function checkPageFreeze() {
  const now = Date.now();
  const gap = now - lastActiveTime;
  if (gap > 8000) { // More than 8s gap = page was frozen (interval is 5s)
    return true;
  }
  return false;
}

// Handle visibility changes (tab switching, screen off, etc.)
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    const wasFrozen = checkPageFreeze();
    lastActiveTime = Date.now();
    
    // If we're supposed to be connected but might have lost connection
    if (sessionToken && chatUi.classList.contains('active')) {
      // Check if WebSocket is still healthy
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!visibilityReconnectScheduled) {
          visibilityReconnectScheduled = true;
          setTimeout(function() {
            visibilityReconnectScheduled = false;
            if (!connected) {
              connectWs();
            }
          }, 500); // Small delay to let browser stabilize
        }
      } else {
        // Connection looks open - always verify with a ping after visibility change
        // (catches zombie connections from page freeze, network hiccups, etc.)
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
          // Set a timeout - if no pong received, connection is dead
          const healthCheckTimeout = setTimeout(function() {
            if (ws) ws.close();
            connectWs();
          }, 5000);
          // Store timeout so pong handler can clear it
          ws._healthCheckTimeout = healthCheckTimeout;
        } catch (e) {
          connectWs();
        }
      }
    }
  }
  // Hidden state - no action needed, will reconnect on visibility
});

// Handle online/offline events
window.addEventListener('online', function() {
  if (sessionToken && chatUi.classList.contains('active') && !connected) {
    setTimeout(connectWs, 1000);
  }
});

window.addEventListener('offline', function() {
  setStatus('offline');
});

// Periodic connection health check (catches zombie connections)
setInterval(function() {
  if (sessionToken && chatUi.classList.contains('active') && document.visibilityState === 'visible') {
    if (ws && ws.readyState === WebSocket.OPEN && connected) {
      // All good - connection is healthy
    } else if (!connected && !reconnectTimer && !visibilityReconnectScheduled) {
      // Should be connected but isn't, and no reconnect in progress
      connectWs();
    }
  }
}, 60000); // Check every minute

function send() {
  if (pendingAttachments.length > 0) {
    sendWithAttachments();
    return;
  }
  const text = inputEl.value.trim();
  if (!text || !connected) return;

  const msgOpts = { timestamp: Date.now() };
  if (replyTarget) {
    msgOpts.replyTo = { sender: replyTarget.sender, text: replyTarget.text, bubbleEl: replyTarget.bubbleEl };
  }
  addMessage(text, 'user', msgOpts);
  showTyping();
  // Set thinking locally for instant feedback (server will broadcast authoritatively)
  if (window.setAvatarState) setAvatarState('thinking');

  let sendText = text;
  if (replyTarget) {
    const quoteSender = replyTarget.sender === 'bot' ? CFG.botName : 'You';
    const quoteSnippet = replyTarget.text.length > 150 ? replyTarget.text.slice(0, 150) + '…' : replyTarget.text;
    sendText = '> ' + quoteSender + ': ' + quoteSnippet + '\n\n' + text;
  }
  // Cancel any playing/queued TTS from previous reply
  if (window.voiceMode || window.callActive) stopCallAudio();
  secureSend(JSON.stringify({ type: 'send', text: sendText }));
  clearReply();

  inputEl.value = '';
  inputEl.style.height = 'auto';
  updateSendBtn();
  clearDraft();
}

// ─── Input handlers ───
// Save draft to localStorage to prevent loss on refresh/disconnect
const DRAFT_KEY = 'clawtime_draft';

function saveDraft() {
  const text = inputEl.value;
  if (text) {
    localStorage.setItem(DRAFT_KEY, text);
  } else {
    localStorage.removeItem(DRAFT_KEY);
  }
}

function restoreDraft() {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft) {
    inputEl.value = draft;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    updateSendBtn();
  }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

// Restore draft on load
restoreDraft();

inputEl.addEventListener('input', function() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  updateSendBtn();
  saveDraft();
});

inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendBtn.addEventListener('click', function() { send(); });

// ─── Image Upload & Camera ───
const attachBtn = document.getElementById('attachBtn');
const attachMenu = document.getElementById('attachMenu');
const attachFileBtn = document.getElementById('attachFile');
const attachCameraBtn = document.getElementById('attachCamera');
const fileInput = document.getElementById('fileInput');
const cameraFileInput = document.getElementById('cameraFileInput');
const imagePreview = document.getElementById('imagePreview');
const previewImg = document.getElementById('previewImg');
const previewInfo = document.getElementById('previewInfo');
const previewCancel = document.getElementById('previewCancel');
const dragOverlay = document.getElementById('dragOverlay');
const cameraModal = document.getElementById('cameraModal');
const cameraVideo = document.getElementById('cameraVideo');
const cameraPreviewImg = document.getElementById('cameraPreviewImg');
const cameraControls = document.getElementById('cameraControls');
const cameraReviewControls = document.getElementById('cameraReviewControls');
const camCloseBtn = document.getElementById('camCloseBtn');
const camCaptureBtn = document.getElementById('camCaptureBtn');
const camRetakeBtn = document.getElementById('camRetakeBtn');
const camUseBtn = document.getElementById('camUseBtn');

let cameraStream = null;
let capturedImageBase64 = null;

function processFile(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function(e) {
      let dataUrl = e.target.result;
      let base64 = dataUrl.split(',')[1];
      let type = file.type || 'application/octet-stream';
      
      // For images, optionally resize large ones
      if (type.startsWith('image/')) {
        const img = new Image();
        img.onload = function() {
          const MAX = 1920;
          let w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else { w = Math.round(w * MAX / h); h = MAX; }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            base64 = dataUrl.split(',')[1];
            type = 'image/jpeg';
          }
          resolve({ base64: base64, dataUrl: dataUrl, name: file.name || 'file', type: type });
        };
        img.onerror = function() {
          resolve({ base64: base64, dataUrl: dataUrl, name: file.name || 'file', type: type });
        };
        img.src = dataUrl;
      } else {
        resolve({ base64: base64, dataUrl: dataUrl, name: file.name || 'file', type: type });
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function addAttachment(attachment) {
  pendingAttachments.push(attachment);
  renderAttachmentPreview();
  updateSendBtn();
}

function removeAttachment(index) {
  pendingAttachments.splice(index, 1);
  renderAttachmentPreview();
  updateSendBtn();
}

function renderAttachmentPreview() {
  if (pendingAttachments.length === 0) {
    imagePreview.classList.remove('active');
    imagePreview.innerHTML = '';
    return;
  }
  
  imagePreview.classList.add('active');
  imagePreview.innerHTML = pendingAttachments.map(function(att, i) {
    const isImage = att.type && att.type.startsWith('image/');
    const preview = isImage 
      ? '<img src="' + att.dataUrl + '" style="max-height:60px;max-width:80px;border-radius:6px;object-fit:cover">'
      : '<div style="width:50px;height:50px;background:#333;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:20px">📎</div>';
    return '<div style="position:relative;display:inline-block;margin:4px">' +
      preview +
      '<div style="font-size:10px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + att.name + '</div>' +
      '<button onclick="removeAttachment(' + i + ')" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:none;background:#ef4444;color:white;font-size:12px;cursor:pointer;line-height:1">×</button>' +
      '</div>';
  }).join('');
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachmentPreview();
  updateSendBtn();
}

attachBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  attachMenu.classList.toggle('active');
});

attachFileBtn.addEventListener('click', function() {
  fileInput.click();
  attachMenu.classList.remove('active');
});

attachCameraBtn.addEventListener('click', function() {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) {
    cameraFileInput.click();
  } else {
    openCamera();
  }
  attachMenu.classList.remove('active');
});

document.addEventListener('click', function(e) {
  if (!attachBtn.contains(e.target) && !attachMenu.contains(e.target)) {
    attachMenu.classList.remove('active');
  }
});

fileInput.addEventListener('change', async function(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  for (let i = 0; i < files.length; i++) {
    try {
      const result = await processFile(files[i]);
      addAttachment(result);
    } catch (err) { console.error('Failed to process file:', err); }
  }
  fileInput.value = '';
});

previewCancel.addEventListener('click', clearAttachments);

let dragCounter = 0;

messagesEl.addEventListener('dragenter', function(e) {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dragOverlay.classList.add('active');
});

messagesEl.addEventListener('dragleave', function(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dragOverlay.classList.remove('active'); }
});

messagesEl.addEventListener('dragover', function(e) { e.preventDefault(); });

messagesEl.addEventListener('drop', async function(e) {
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove('active');
  const files = e.dataTransfer.files;
  if (!files || files.length === 0) return;
  for (let i = 0; i < files.length; i++) {
    try {
      const result = await processFile(files[i]);
      addAttachment(result);
    } catch (err) { console.error('Failed to process file:', err); }
  }
});

cameraFileInput.addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const result = await processFile(file);
    addAttachment(result);
  } catch (_err) { /* ignore */ }
  cameraFileInput.value = '';
});

async function openCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    cameraVideo.srcObject = cameraStream;
    cameraVideo.style.display = '';
    cameraPreviewImg.style.display = 'none';
    cameraControls.style.display = '';
    cameraReviewControls.style.display = 'none';
    cameraModal.classList.add('active');
  } catch (err) {
    alert('Unable to access camera. Please check permissions.');
  }
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(function(t) { t.stop(); });
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  capturedImageBase64 = null;
  cameraModal.classList.remove('active');
}

camCloseBtn.addEventListener('click', closeCamera);

camCaptureBtn.addEventListener('click', function() {
  const canvas = document.createElement('canvas');
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext('2d').drawImage(cameraVideo, 0, 0);

  const MAX = 1920;
  let w = canvas.width, h = canvas.height;
  if (w > MAX || h > MAX) {
    const resized = document.createElement('canvas');
    if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
    else { w = Math.round(w * MAX / h); h = MAX; }
    resized.width = w;
    resized.height = h;
    resized.getContext('2d').drawImage(canvas, 0, 0, w, h);
    capturedImageBase64 = resized.toDataURL('image/jpeg', 0.8).split(',')[1];
    cameraPreviewImg.src = resized.toDataURL('image/jpeg', 0.8);
  } else {
    capturedImageBase64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    cameraPreviewImg.src = canvas.toDataURL('image/jpeg', 0.8);
  }

  cameraVideo.style.display = 'none';
  cameraPreviewImg.style.display = '';
  cameraControls.style.display = 'none';
  cameraReviewControls.style.display = '';
});

camRetakeBtn.addEventListener('click', function() {
  capturedImageBase64 = null;
  cameraVideo.style.display = '';
  cameraPreviewImg.style.display = 'none';
  cameraControls.style.display = '';
  cameraReviewControls.style.display = 'none';
});

camUseBtn.addEventListener('click', function() {
  if (capturedImageBase64) {
    addAttachment({
      base64: capturedImageBase64,
      dataUrl: 'data:image/jpeg;base64,' + capturedImageBase64,
      name: 'camera-photo.jpg',
      type: 'image/jpeg'
    });
  }
  closeCamera();
});

function sendWithAttachments() {
  const text = inputEl.value.trim();
  const hasAttachments = pendingAttachments.length > 0;
  const hasText = !!text;

  if (!connected || (!hasText && !hasAttachments)) return;

  const msgOpts = { timestamp: Date.now() };
  if (replyTarget) {
    msgOpts.replyTo = { sender: replyTarget.sender, text: replyTarget.text, bubbleEl: replyTarget.bubbleEl };
  }

  // Show user message with attachments
  if (hasAttachments) {
    const imageAttachments = pendingAttachments.filter(function(a) { return a.type && a.type.startsWith('image/'); });
    if (imageAttachments.length > 0) {
      const imageUrls = imageAttachments.map(function(a) { return a.dataUrl; });
      addImageMessage(text, 'user', imageUrls, msgOpts);
    } else {
      addMessage(text + ' [' + pendingAttachments.length + ' attachment(s)]', 'user', msgOpts);
    }
  } else {
    addMessage(text, 'user', msgOpts);
  }

  showTyping();
  if (window.setAvatarState) setAvatarState('thinking');

  let sendText = text;
  if (replyTarget) {
    const quoteSender = replyTarget.sender === 'bot' ? CFG.botName : 'You';
    const quoteSnippet = replyTarget.text.length > 150 ? replyTarget.text.slice(0, 150) + '…' : replyTarget.text;
    sendText = '> ' + quoteSender + ': ' + quoteSnippet + '\n\n' + text;
  }

  if (hasAttachments) {
    // Send attachments with message
    const attachmentData = pendingAttachments.map(function(a) {
      return { data: a.base64, name: a.name, type: a.type };
    });
    secureSend(JSON.stringify({ type: 'attachments', attachments: attachmentData, caption: sendText || '' }));
  } else {
    secureSend(JSON.stringify({ type: 'send', text: sendText }));
  }

  clearReply();
  inputEl.value = '';
  inputEl.style.height = 'auto';
  clearAttachments();
  clearDraft();
}

function addImageMessage(caption, sender, imageDataUrlOrArray, opts) {
  opts = opts || {};
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'message ' + sender;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = sender === 'bot' ? CFG.botEmoji : '👤';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (caption) {
    const textNode = document.createElement('div');
    textNode.textContent = caption;
    bubble.appendChild(textNode);
  }

  // Support single image or array of images
  const images = Array.isArray(imageDataUrlOrArray) ? imageDataUrlOrArray : [imageDataUrlOrArray];
  images.forEach(function(imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'chat-image';
    img.src = imageDataUrl;
    img.alt = 'Shared image';
    img.onclick = function() { window.open(imageDataUrl, '_blank'); };
    bubble.appendChild(img);
  });

  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  const ts = opts.timestamp ? new Date(opts.timestamp) : new Date();
  timeEl.textContent = ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  bubble.appendChild(timeEl);

  div.appendChild(avatar);
  div.appendChild(bubble);

  if (opts.prepend && opts.beforeEl) {
    messagesEl.insertBefore(div, opts.beforeEl);
  } else {
    messagesEl.appendChild(div);
  }
  if (!opts.noScroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  return bubble;
}

// ─── File Viewer Overlay ───
// DECISION: We show PDFs/files in an in-app overlay (iframe) instead of
// opening them directly. On iOS Safari / PWA mode, navigating to a PDF
// replaces the page and there's no back button to return to the chat.
// The overlay provides a Close button and a Download button, keeping
// the chat session intact.
const fileViewer = document.getElementById('fileViewer');
const fvFrame = document.getElementById('fvFrame');
const fvTitle = document.getElementById('fvTitle');
const fvClose = document.getElementById('fvClose');
const fvDownload = document.getElementById('fvDownload');
let fvCurrentUrl = '';

window.openFileViewer = function(url, filename) {
  fvCurrentUrl = url;
  fvTitle.textContent = filename || url.split('/').pop();
  fvFrame.src = url;
  fileViewer.classList.add('active');
};

fvClose.addEventListener('click', function() {
  fileViewer.classList.remove('active');
  fvFrame.src = '';
});

fvDownload.addEventListener('click', function() {
  const a = document.createElement('a');
  a.href = fvCurrentUrl;
  a.download = fvTitle.textContent || 'file';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// ─── Push-to-Talk (PTT) ───
// DECISION: PTT uses the browser's SpeechRecognition API (not server-side
// Whisper) for real-time transcription. This gives the user immediate visual
// feedback as they speak (interim results shown in a live bubble). The text
// is sent as a normal chat message on release — no audio upload needed.
// On browsers without SpeechRecognition, we fall back to MediaRecorder +
// server-side Whisper (see startMediaRecorderSTT below).
//
// DECISION: Swipe-left-to-cancel — dragging left > 80px while holding the
// PTT removed — voice mode toggle handles voice input now
// Keep variables to avoid reference errors in any remaining code
const pttBtn = document.createElement('div'); // dummy element
let pttRecording = false;
let pttCancelled = false;
let pttStartX = 0;
let pttStartY = 0;
const PTT_CANCEL_DIST = 80; // pixels to drag before cancelling
let pttRecognition = null;
let pttBubble = null;
let pttFinalText = '';
let pttLastTranscript = '';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let pttMicStream = null; // Keep mic stream alive to persist permission

// ── Adaptive STT: Browser vs Whisper based on noise level ──
// DECISION: Measure ambient noise for ~200ms when PTT starts. If noise RMS
// exceeds threshold, record audio and send to server-side Whisper (more
// accurate in noise). Otherwise, use browser SpeechRecognition (faster,
// real-time feedback). This gives best of both worlds automatically.
let pttUsingWhisper = false;
let pttMediaRecorder = null;
let pttAudioChunks = [];
let pttAudioContext = null;
let pttAnalyser = null;
const PTT_NOISE_THRESHOLD = 1.0; // RMS threshold — set to 1.0 to always use browser Web Speech API (no Whisper)
const PTT_NOISE_SAMPLE_MS = 150; // How long to sample noise before deciding

function pttEnsureMicPermission() {
  if (pttMicStream) return Promise.resolve(pttMicStream);
  return navigator.mediaDevices.getUserMedia({ 
    audio: { 
      noiseSuppression: true, 
      autoGainControl: true,
      echoCancellation: true 
    } 
  }).then(function(stream) {
    pttMicStream = stream;
    return stream;
  });
}

// Measure ambient noise level using Web Audio API
function pttMeasureNoise(stream, durationMs) {
  return new Promise(function(resolve) {
    try {
      if (!pttAudioContext) {
        pttAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      const source = pttAudioContext.createMediaStreamSource(stream);
      pttAnalyser = pttAudioContext.createAnalyser();
      pttAnalyser.fftSize = 2048;
      source.connect(pttAnalyser);
      
      const samples = [];
      const dataArray = new Float32Array(pttAnalyser.fftSize);
      const sampleInterval = 50; // sample every 50ms
      let elapsed = 0;
      
      const sampler = setInterval(function() {
        pttAnalyser.getFloatTimeDomainData(dataArray);
        // Calculate RMS (root mean square) of the signal
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        samples.push(rms);
        elapsed += sampleInterval;
        
        if (elapsed >= durationMs) {
          clearInterval(sampler);
          source.disconnect();
          // Return average RMS across samples
          const avgRms = samples.reduce(function(a, b) { return a + b; }, 0) / samples.length;
          resolve(avgRms);
        }
      }, sampleInterval);
    } catch (e) {
      console.error('Noise measurement error:', e);
      resolve(0); // Default to low noise on error
    }
  });
}

// Start MediaRecorder for Whisper path
function pttStartWhisperRecording(stream) {
  pttAudioChunks = [];
  let options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'audio/webm' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = {};
    }
  }
  pttMediaRecorder = new MediaRecorder(stream, options);
  pttMediaRecorder.ondataavailable = function(e) {
    if (e.data.size > 0) pttAudioChunks.push(e.data);
  };
  pttMediaRecorder.start(100); // Collect in 100ms chunks
}

// Start browser SpeechRecognition for quiet environment
function pttStartBrowserRecognition() {
  pttRecognition = new SpeechRecognition();
  pttRecognition.continuous = true;
  pttRecognition.interimResults = true;
  pttRecognition.lang = 'en-US';

  pttRecognition.onresult = function(e) {
    let interim = '';
    let final = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        final += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    pttFinalText = final;
    const display = (final + interim).trim() || '🎤 Listening...';
    pttLastTranscript = (final + interim).trim();
    if (pttBubble) {
      pttBubble.bubble.textContent = display;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  pttRecognition.onerror = function(e) {
    console.error('PTT speech error:', e.error);
  };

  pttRecognition.onend = function() {
    // Recognition ended (browser may stop it) — if still recording, restart
    if (pttRecording && pttRecognition && !pttUsingWhisper) {
      try { pttRecognition.start(); } catch(_e) { /* ignore */ }
    }
  };

  try { 
    pttRecognition.start(); 
  } catch(e) {
    console.error('PTT start error:', e);
    pttRecording = false;
    pttBtn.classList.add('recording');
    if (pttBubble) { pttBubble.div.remove(); pttBubble = null; }
  }
}

function pttStart() {
  if (pttRecording) return;
  pttRecording = true;
  pttUsingWhisper = false;
  pttBtn.classList.add('recording');
  pttFinalText = '';
  pttLastTranscript = '';

  // Enable voice mode so response gets spoken
  if (!window.voiceMode) {
    window.voiceMode = true;
    secureSend(JSON.stringify({ type: 'voice_mode', enabled: true }));
  }

  // Create live transcription bubble
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'message user';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '👤';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.opacity = '0.6';
  bubble.style.fontStyle = 'italic';
  bubble.textContent = '🎤 Measuring...';
  div.appendChild(avatar);
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  pttBubble = { div: div, bubble: bubble };

  pttEnsureMicPermission().then(function(stream) {
    if (!pttRecording) return; // User already released
    
    // Measure noise level
    pttMeasureNoise(stream, PTT_NOISE_SAMPLE_MS).then(function(noiseLevel) {
      if (!pttRecording) return; // User released during measurement
      
      if (noiseLevel > PTT_NOISE_THRESHOLD || !SpeechRecognition) {
        // High noise or no browser support — use Whisper
        pttUsingWhisper = true;
        if (pttBubble) pttBubble.bubble.textContent = '🎤 Recording... (Whisper)';
        pttStartWhisperRecording(stream);
      } else {
        // Low noise — use browser recognition for real-time feedback
        if (pttBubble) pttBubble.bubble.textContent = '🎤 Listening...';
        pttStartBrowserRecognition();
      }
    });
  }).catch(function(err) {
    console.error('PTT mic error:', err);
    pttRecording = false;
    pttBtn.classList.remove('recording');
    if (pttBubble) { pttBubble.div.remove(); pttBubble = null; }
  });
}

function pttStop() {
  if (!pttRecording) return;
  pttRecording = false;
  pttBtn.classList.remove('recording');
  pttBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

  if (pttCancelled) {
    pttCancelled = false;
    // Clean up both recognition modes
    if (pttRecognition) {
      pttRecognition.onend = null;
      pttRecognition.onresult = null;
      try { pttRecognition.stop(); } catch(_e) { /* ignore */ }
      pttRecognition = null;
    }
    if (pttMediaRecorder && pttMediaRecorder.state !== 'inactive') {
      try { pttMediaRecorder.stop(); } catch(_e) { /* ignore */ }
      pttMediaRecorder = null;
    }
    pttAudioChunks = [];
    if (pttBubble) { pttBubble.div.remove(); pttBubble = null; }
    pttLastTranscript = '';
    pttUsingWhisper = false;
    return;
  }

  const savedBubble = pttBubble;
  pttBubble = null;

  if (pttUsingWhisper) {
    // ── Whisper path: stop recording, send audio to server ──
    if (pttMediaRecorder && pttMediaRecorder.state !== 'inactive') {
      pttMediaRecorder.onstop = function() {
        const blob = new Blob(pttAudioChunks, { type: pttMediaRecorder.mimeType || 'audio/webm' });
        pttAudioChunks = [];
        pttMediaRecorder = null;
        
        if (blob.size < 1000) {
          // Too short, probably just noise
          if (savedBubble) savedBubble.div.remove();
          pttUsingWhisper = false;
          return;
        }
        
        // Update bubble to show transcribing with visual indicator
        if (savedBubble) {
          savedBubble.bubble.innerHTML = '<span class="transcribing-indicator">⏳ Transcribing with Whisper...</span>';
          savedBubble.bubble.style.opacity = '0.8';
        }
        
        // Convert blob to base64 and send to server
        const reader = new FileReader();
        reader.onloadend = function() {
          const base64data = reader.result.split(',')[1];
          secureSend(JSON.stringify({ type: 'audio', data: base64data }));
        };
        reader.readAsDataURL(blob);
        
        // Listen for transcription result
        const transcriptionHandler = function(e) {
          try {
            let rawStr = e.data;
            // Decrypt if E2E is active
            if (window._e2eReady && window._e2eDecrypt) {
              rawStr = window._e2eDecrypt(rawStr);
            }
            const msg = JSON.parse(rawStr);
            if (msg.type === 'transcription') {
              ws.removeEventListener('message', transcriptionHandler);
              if (savedBubble) savedBubble.div.remove();
              
              if (msg.text && msg.text.trim()) {
                // Send the transcribed text
                inputEl.value = msg.text;
                updateSendBtn();
                send();
              }
              pttUsingWhisper = false;
            } else if (msg.type === 'stt_error') {
              ws.removeEventListener('message', transcriptionHandler);
              console.error('STT error:', msg.error);
              if (savedBubble) savedBubble.div.remove();
              pttUsingWhisper = false;
            }
          } catch(_err) { /* ignore parse errors */ }
        };
        ws.addEventListener('message', transcriptionHandler);
        
        // Timeout after 15 seconds
        setTimeout(function() {
          ws.removeEventListener('message', transcriptionHandler);
          if (savedBubble && savedBubble.div.parentNode) {
            savedBubble.div.remove();
          }
          pttUsingWhisper = false;
        }, 15000);
      };
      try { pttMediaRecorder.stop(); } catch(_e) { /* ignore */ }
    } else {
      if (savedBubble) savedBubble.div.remove();
      pttUsingWhisper = false;
    }
  } else {
    // ── Browser recognition path: wait for final result ──
    if (pttRecognition) {
      pttRecognition.onend = null;
      try { pttRecognition.stop(); } catch(_e) { /* ignore */ }
    }

    // Wait briefly for final result to arrive
    setTimeout(function() {
      pttRecognition = null;
      const text = pttLastTranscript || '';
      pttLastTranscript = '';

      if (!text) {
        if (savedBubble) savedBubble.div.remove();
        return;
      }

      // Remove PTT bubble — send() will create the proper one
      if (savedBubble) savedBubble.div.remove();

      // Send via normal flow
      inputEl.value = text;
      updateSendBtn();
      send();
    }, 300);
  }
}

function pttCheckCancel(clientX, clientY) {
  const dx = pttStartX - clientX; // positive = swiped left
  if (dx > PTT_CANCEL_DIST && pttRecording) {
    // Immediately cancel on swipe
    pttCancelled = true;
    pttStop();
  }
}

// Touch events (mobile)
pttBtn.addEventListener('touchstart', function(e) {
  e.preventDefault();
  const touch = e.touches[0];
  pttStartX = touch.clientX;
  pttStartY = touch.clientY;
  pttCancelled = false;
  pttStart();
}, { passive: false });
document.addEventListener('touchmove', function(e) {
  if (!pttRecording) return;
  const touch = e.touches[0];
  pttCheckCancel(touch.clientX, touch.clientY);
}, { passive: true });
document.addEventListener('touchend', function(e) {
  if (pttRecording) {
    e.preventDefault();
    pttStop();
  }
});
document.addEventListener('touchcancel', function(e) {
  if (pttRecording) { pttCancelled = true; pttStop(); }
});

// Mouse events (desktop)
pttBtn.addEventListener('mousedown', function(e) {
  e.preventDefault();
  pttStartX = e.clientX;
  pttStartY = e.clientY;
  pttCancelled = false;
  pttStart();
});
document.addEventListener('mousemove', function(e) {
  if (!pttRecording) return;
  pttCheckCancel(e.clientX, e.clientY);
});
document.addEventListener('mouseup', function() { if (pttRecording) pttStop(); });

// ─── Draggable Separator ───
const avatarPanel = document.getElementById('avatarPanel');
const dragSeparator = document.getElementById('dragSeparator');
const MOBILE_BP = 768;

function isMobileLayout() { return window.innerWidth <= MOBILE_BP; }

function initSeparator() {
  if (!CFG.enableAvatar) return;
  if (isMobileLayout()) {
    const saved = localStorage.getItem('clawtime_avatar_height');
    const h = saved ? parseInt(saved) : 200;
    avatarPanel.style.height = Math.max(80, Math.min(h, window.innerHeight * 0.6)) + 'px';
  } else {
    const saved = localStorage.getItem('clawtime_avatar_width');
    const w = saved ? parseFloat(saved) : 40;
    avatarPanel.style.width = Math.max(20, Math.min(w, 60)) + '%';
  }

  setTimeout(function() {
    if (window.adjustAvatarCamera) window.adjustAvatarCamera();
  }, 100);
}

let sepDragging = false;
let sepStartPos = 0;
let sepStartSize = 0;

function sepStartDrag(e) {
  if (!CFG.enableAvatar) return;
  e.preventDefault();
  sepDragging = true;
  document.body.style.cursor = isMobileLayout() ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  document.body.style.webkitUserSelect = 'none';

  const pos = e.touches ? e.touches[0] : e;
  sepStartPos = isMobileLayout() ? pos.clientY : pos.clientX;
  sepStartSize = isMobileLayout() ? avatarPanel.offsetHeight : avatarPanel.offsetWidth;

  document.addEventListener('mousemove', sepOnDrag);
  document.addEventListener('mouseup', sepEndDrag);
  document.addEventListener('touchmove', sepOnDrag, { passive: false });
  document.addEventListener('touchend', sepEndDrag);
}

let sepRafPending = false;
function sepOnDrag(e) {
  if (!sepDragging) return;
  e.preventDefault();

  const pos = e.touches ? e.touches[0] : e;
  const current = isMobileLayout() ? pos.clientY : pos.clientX;
  const delta = current - sepStartPos;

  if (isMobileLayout()) {
    const newH = Math.max(80, Math.min(sepStartSize + delta, window.innerHeight * 0.6));
    avatarPanel.style.height = newH + 'px';
    localStorage.setItem('clawtime_avatar_height', Math.round(newH));
  } else {
    const containerW = chatUi.offsetWidth;
    const newW = ((sepStartSize + delta) / containerW) * 100;
    const clamped = Math.max(20, Math.min(newW, 60));
    avatarPanel.style.width = clamped + '%';
    localStorage.setItem('clawtime_avatar_width', clamped.toFixed(1));
  }

  // Use RAF for smooth resizing
  if (!sepRafPending && window.adjustAvatarCamera) {
    sepRafPending = true;
    requestAnimationFrame(function() {
      window.adjustAvatarCamera();
      sepRafPending = false;
    });
  }
}

function sepEndDrag() {
  sepDragging = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  document.body.style.webkitUserSelect = '';
  document.removeEventListener('mousemove', sepOnDrag);
  document.removeEventListener('mouseup', sepEndDrag);
  document.removeEventListener('touchmove', sepOnDrag);
  document.removeEventListener('touchend', sepEndDrag);
}

dragSeparator.addEventListener('mousedown', sepStartDrag);
dragSeparator.addEventListener('touchstart', sepStartDrag, { passive: false });

window.addEventListener('resize', function() {
  if (!chatUi.classList.contains('active')) return;
  initSeparator();
});

// ═══════════════════════════════════════════════════════════
// ─── LIVE TALK (Voice Call Mode) ───
//
// DECISION: Voice mode uses server-side TTS only (edge-tts
// via WebSocket), NOT browser speechSynthesis. Browser TTS
// was removed because:
//   • Voices are robotic/inconsistent across platforms
//   • iOS Safari pauses speechSynthesis on long text
//   • Server TTS provides high-quality neural voices
//
// The speakCallResponse function is kept as a stub for API
// compat but its browser TTS body is dead code.
//
// Audio playback uses Web Audio API (decodeAudioData) for
// reliable gapless playback, with Audio element as fallback.
// ═══════════════════════════════════════════════════════════

window.callActive = false;
window.voiceMode = false;
let callRecognition = null;
let callPlaying = false;

// Echo detection threshold for barge-in during TTS
const ECHO_CONFIDENCE_THRESHOLD = 0.88; // Balance between barge-in sensitivity and echo rejection

// Check browser support for SpeechRecognition
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

// ── Create call overlay UI ──
const callOverlay = document.createElement('div');
callOverlay.id = 'callOverlay';
callOverlay.innerHTML = '' +
  '<div class="call-ring-container">' +
    '<div class="call-ring call-ring-1"></div>' +
    '<div class="call-ring call-ring-2"></div>' +
    '<div class="call-ring call-ring-3"></div>' +
    '<div class="call-mic-icon">🎙️</div>' +
  '</div>' +
  '<div class="call-status" id="callStatus">Listening...</div>' +
  '<div class="call-interim" id="callInterim"></div>' +
  '<div class="call-waveform" id="callWaveform">' +
    '<span></span><span></span><span></span><span></span><span></span>' +
    '<span></span><span></span><span></span><span></span>' +
  '</div>' +
  '<button class="call-end-btn" id="callEndBtn">✕</button>';

// Whisper mode state for voice calls
const callUseWhisper = false; // Browser STT by default (set true for server-side Whisper)

// Element references for avatar panel interactions
const avatarPanelEl = document.getElementById('avatarPanel');
const chatMainEl = document.querySelector('.chat-main');
const dragSeparatorEl = document.getElementById('dragSeparator');

// Append overlay to avatar panel (positioned at bottom)
if (avatarPanelEl) avatarPanelEl.appendChild(callOverlay);

// ── Call button (overlaid on avatar) ──
// Call button removed — voice mode uses the 🔊 button in avatar-buttons

// ── Start call ──
// Web Audio API — unlocked on user gesture, used for TTS playback
let audioCtx = null;

function unlockAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  // Play silent buffer to fully unlock
  const buf = audioCtx.createBuffer(1, 1, 22050);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start(0);
}

let activeTTSSource = null;
let activeTTSRunId = null; // Track which runId is currently being spoken

function playTTSAudio(data, onDone) {
  // data can be an ArrayBuffer (from E2E WS) or a URL string (legacy)
  // Stop any currently playing
  if (activeTTSSource) {
    try { activeTTSSource.stop(); } catch(_e) { /* ignore */ }
    activeTTSSource = null;
  }
  if (window._ttsAudioEl) {
    window._ttsAudioEl.pause();
    window._ttsAudioEl = null;
  }

  const isBuffer = data instanceof ArrayBuffer;

  // Ensure AudioContext exists
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_e) { /* ignore */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(function() {});
  }

  if (audioCtx && isBuffer) {
    // Direct ArrayBuffer → decodeAudioData (no fetch needed, iOS-safe)
    audioCtx.decodeAudioData(data.slice(0), function(buffer) {
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      activeTTSSource = source;
      source.onended = function() { activeTTSSource = null; if (onDone) onDone(); };
      source.start(0);
    }, function(err) {
      console.error('[TTS] decode failed:', err);
      // Fallback: create blob URL and use Audio element
      const blob = new Blob([new Uint8Array(data)], { type: 'audio/mpeg' });
      playTTSFallback(URL.createObjectURL(blob), onDone);
    });
  } else if (audioCtx && audioCtx.state === 'running' && !isBuffer) {
    fetch(data)
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(ab) { return audioCtx.decodeAudioData(ab); })
      .then(function(buffer) {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        activeTTSSource = source;
        source.onended = function() { activeTTSSource = null; if (onDone) onDone(); };
        source.start(0);
      })
      .catch(function() { playTTSFallback(data, onDone); });
  } else if (isBuffer) {
    // No AudioContext — fallback with blob URL
    const blob = new Blob([new Uint8Array(data)], { type: 'audio/mpeg' });
    playTTSFallback(URL.createObjectURL(blob), onDone);
  } else {
    playTTSFallback(data, onDone);
  }
}

function playTTSFallback(url, onDone) {
  const audio = new Audio(url);
  window._ttsAudioEl = audio;
  audio.onended = function() { window._ttsAudioEl = null; if (onDone) onDone(); };
  audio.onerror = function() { window._ttsAudioEl = null; if (onDone) onDone(); };
  audio.play().catch(function() { window._ttsAudioEl = null; if (onDone) onDone(); });
}

// ─── Server-side STT fallback (MediaRecorder) ───
let mediaRecorder = null;
let mediaStream = null;
let recordingChunks = [];
let analyserNode = null;
let sttActive = false;

function startMediaRecorderSTT() {
  // Only start Whisper STT when enabled or browser STT unavailable
  if (!callUseWhisper && SpeechRecognitionAPI) return;
  sttActive = true;
  navigator.mediaDevices.getUserMedia({ 
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  }).then(function(stream) {
    mediaStream = stream;

    // Set up audio analyser for silence detection
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;
    source.connect(analyserNode);

    startRecordingChunk();
  }).catch(function(err) {
    console.error('[STT] Mic access denied:', err);
    setCallStatus('Mic blocked');
    sttActive = false;
  });
}

function startRecordingChunk() {
  if (!sttActive || !mediaStream || !window.callActive) return;
  recordingChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
                 MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
                 MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType: mimeType } : {});
  mediaRecorder.ondataavailable = function(e) {
    if (e.data.size > 0) recordingChunks.push(e.data);
  };
  mediaRecorder.onstop = function() {
    if (recordingChunks.length === 0 || !window.callActive) return;
    // Discard audio if TTS was playing (avoid echo) — but barge-in already stopped TTS
    if (callPlaying) {
      if (sttActive && window.callActive) setTimeout(startRecordingChunk, 300);
      return;
    }
    const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (blob.size < 500) {
      // Too small — restart
      if (sttActive && window.callActive) setTimeout(startRecordingChunk, 300);
      return;
    }
    setCallStatus('transcribing');
    // Update placeholder to show transcribing
    if (window._whisperPlaceholder) {
      const bubble = window._whisperPlaceholder.querySelector('.msg-bubble');
      if (bubble) bubble.textContent = '⏳ Transcribing...';
    } else {
      window._whisperPlaceholder = addMessage('⏳ Transcribing...', 'user', { timestamp: Date.now(), placeholder: true });
    }
    const reader = new FileReader();
    reader.onload = function() {
      const b64 = reader.result.split(',')[1];
      secureSend(JSON.stringify({ type: 'audio', data: b64 }));
      // Restart recording for next utterance
      if (sttActive && window.callActive && !callPlaying) {
        setTimeout(startRecordingChunk, 300);
      }
    };
    reader.readAsDataURL(blob);
  };

  // Record in chunks with voice activity detection
  mediaRecorder.start();
  setCallStatus('listening');

  // Use simple energy-based VAD
  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  let speechStarted = false;
  let silenceCount = 0;
  let totalFrames = 0;

  const vadInterval = setInterval(function() {
    if (!sttActive || !window.callActive || !mediaRecorder || mediaRecorder.state !== 'recording') {
      clearInterval(vadInterval);
      return;
    }
    totalFrames++;
    analyserNode.getByteTimeDomainData(dataArray);

    // Calculate RMS energy
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const val = (dataArray[i] - 128) / 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / dataArray.length);

    if (rms > 0.07) { // Balanced: responsive but filters noise
      // Barge-in: stop TTS if user starts speaking
      if (callPlaying && !speechStarted) {
        if (activeTTSRunId) {
          secureSend(JSON.stringify({ type: 'barge_in', runId: activeTTSRunId }));
        }
        stopCallAudio();
        activeTTSRunId = null;
        setCallStatus('listening');
        if (window.setAvatarState) setAvatarState('listening');
      }
      if (!speechStarted) {
        // Show recording placeholder as soon as speech detected
        if (!window._whisperPlaceholder) {
          window._whisperPlaceholder = addMessage('🎤 Recording...', 'user', { timestamp: Date.now(), placeholder: true });
        }
      }
      speechStarted = true;
      silenceCount = 0;
    } else if (speechStarted) {
      silenceCount++;
    }

    // Speech detected then 2s silence → send
    if (speechStarted && silenceCount > 20) {
      clearInterval(vadInterval);
      try { mediaRecorder.stop(); } catch(_e) { /* ignore */ }
      return;
    }

    // Max 10s recording
    if (totalFrames > 100) {
      clearInterval(vadInterval);
      if (speechStarted) {
        try { mediaRecorder.stop(); } catch(_e) { /* ignore */ }
      } else {
        // No speech detected in 10s — restart
        try { mediaRecorder.stop(); } catch(_e) { /* ignore */ }
      }
    }
  }, 100);
}

function stopMediaRecorderSTT() {
  sttActive = false;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch(_e) { /* ignore */ }
  }
  mediaRecorder = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach(function(t) { t.stop(); });
    mediaStream = null;
  }
  analyserNode = null;
  recordingChunks = [];
}

function startCall() {
  // Unlock audio context first (must happen in user gesture)
  unlockAudioContext();
  
  // Pre-grant mic permission via getUserMedia (persists in PWA mode on iOS)
  const micReady = micPermissionGranted
    ? Promise.resolve()
    : navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
        // Keep stream alive — stopping tracks revokes permission on some browsers
        window._micStream = stream;
        micPermissionGranted = true;
      });

  micReady.then(function() {
    // Only enter voice mode after mic permission granted
    window.callActive = true;
    window.voiceMode = true;
    localStorage.setItem('clawtime_voice', 'true');
    callOverlay.classList.add('active');
    // Voice bar now in avatar panel, no padding needed
    messagesEl.scrollTop = messagesEl.scrollHeight; // Keep scroll at bottom
    // Notify server to enable TTS
    if (ws && ws.readyState === 1) secureSend(JSON.stringify({ type: 'voice_mode', enabled: true }));
    setCallStatus('listening');
    // Use Whisper if enabled, otherwise browser STT
    if (callUseWhisper) {
      startMediaRecorderSTT();
    } else if (SpeechRecognitionAPI) {
      startRecognition();
      startBargeInVAD(); // VAD for barge-in during browser STT
    } else {
      startMediaRecorderSTT();
    }
    if (window.setAvatarState) setAvatarState('listening');
  }).catch(function(err) {
    console.error('[MIC] Permission denied:', err);
  });
}

// ── End call ──
function endCall() {
  window.callActive = false;
  window.voiceMode = false;
  localStorage.removeItem('clawtime_voice');
  // Notify server
  if (ws && ws.readyState === 1) secureSend(JSON.stringify({ type: 'voice_mode', enabled: false }));
  callOverlay.classList.remove('active');
  // Voice bar now in avatar panel, no padding change needed
  stopRecognition();
  stopMediaRecorderSTT();
  stopBargeInVAD();
  stopCallAudio();
  callPlaying = false;
  if (synth) synth.cancel();
  hideSpeechPreview();
  // Release mic stream (stops iOS mic indicator)
  if (window._micStream) {
    window._micStream.getTracks().forEach(function(t) { t.stop(); });
    window._micStream = null;
    micPermissionGranted = false;
  }
  if (window.setAvatarState) setAvatarState('idle');
}

// ── Update call status text ──
function setCallStatus(mode) {
  const statusEl = document.getElementById('callStatus');
  const waveform = document.getElementById('callWaveform');
  if (mode === 'listening') {
    statusEl.textContent = 'Listening...';
    statusEl.className = 'call-status listening';
    waveform.className = 'call-waveform listening';
  } else if (mode === 'thinking') {
    statusEl.textContent = 'Thinking...';
    statusEl.className = 'call-status thinking';
    waveform.className = 'call-waveform';
  } else if (mode === 'speaking') {
    statusEl.textContent = 'Speaking...';
    statusEl.className = 'call-status speaking';
    waveform.className = 'call-waveform speaking';
  }
}

// ── Noise-filtering helpers ──
const CALL_CONFIDENCE_THRESHOLD = 0.5; // Lowered to accept more barge-in speech
const CALL_MIN_LENGTH = 2;
// Common noise / filler transcriptions to discard
const CALL_NOISE_WORDS = /^(um+|uh+|hm+|hmm+|ah+|oh+|er+|huh+|mhm+|mm+|shh+|tsk|psst|ha(ha)*|he(he)*|ho(ho)*)$/i;
// Single repeated letter like "aaa", "sss"
const CALL_REPEATED_LETTER = /^(.)\1*$/;

/**
 * Returns true if the transcript should be discarded as noise.
 * Checks: empty, too short, low confidence, filler words, repeated letters.
 */
function isNoisyTranscript(text, confidence) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < CALL_MIN_LENGTH) return true;
  if (typeof confidence === 'number' && confidence < CALL_CONFIDENCE_THRESHOLD) return true;
  if (CALL_NOISE_WORDS.test(t)) return true;
  if (t.length <= 4 && CALL_REPEATED_LETTER.test(t)) return true;
  return false;
}

// ── Speech Recognition ──
let micPermissionGranted = false;
let _sttRestartTimer = null;
let _sttStarting = false;
let _sttBargeInActive = false;
let _sttErrorHandled = false;

function scheduleRecognitionRestart(delayMs) {
  if (_sttRestartTimer) clearTimeout(_sttRestartTimer);
  _sttRestartTimer = setTimeout(function() {
    _sttRestartTimer = null;
    startRecognition();
  }, delayMs);
}

// Create a single reusable SpeechRecognition instance
function ensureRecognitionInstance() {
  if (callRecognition) return;
  callRecognition = new SpeechRecognitionAPI();
  callRecognition.continuous = true;
  callRecognition.interimResults = true;
  callRecognition.lang = 'en-US';

  callRecognition.onstart = function() { _sttStarting = false; };

  // Buffer to capture speech during TTS for barge-in
  let _bargeInBuffer = '';
  
  callRecognition.onresult = function(event) {
    if (!window.callActive) return;
    
    // If TTS is playing, buffer high-confidence speech for after barge-in
    if (callPlaying) {
      for (let k = event.resultIndex; k < event.results.length; k++) {
        if (event.results[k][0].confidence > 0.75) {
          _bargeInBuffer = event.results[k][0].transcript;
        }
      }
      return;
    }
    
    // After barge-in, prepend buffered speech if any
    let bargeInPrefix = '';
    if (_bargeInBuffer) {
      bargeInPrefix = _bargeInBuffer;
      _bargeInBuffer = '';
    }
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      const confidence = event.results[i][0].confidence;

      if (event.results[i].isFinal) {
        if (isNoisyTranscript(transcript, confidence)) {
          hideSpeechPreview();
          continue;
        }
        // Include any buffered barge-in speech
        let text = (bargeInPrefix ? bargeInPrefix + ' ' : '') + transcript.trim();
        text = text.trim();
        bargeInPrefix = ''; // Clear after use
        addMessage(text, 'user', { timestamp: Date.now() });
        showTyping();
        secureSend(JSON.stringify({ type: 'send', text: text }));
        _sttBargeInActive = false;
        setCallStatus('thinking');
        if (window.setAvatarState) setAvatarState('thinking');
        hideSpeechPreview();
      } else {
        interim += transcript;
      }
    }
    if (interim) {
      showSpeechPreview(interim);
    } else {
      hideSpeechPreview();
    }
  };

  callRecognition.onerror = function(event) {
    _sttStarting = false;
    if (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network') {
      _sttErrorHandled = true;
      if (window.callActive && !callPlaying) {
        scheduleRecognitionRestart(800);
      }
    } else if (event.error === 'not-allowed') {
      setCallStatus('Mic blocked — check permissions');
    }
  };

  callRecognition.onend = function() {
    _sttStarting = false;
    if (_sttErrorHandled) {
      _sttErrorHandled = false;
      return;
    }
    if (_sttBargeInActive) {
      _sttBargeInActive = false;
      if (window.callActive && !callPlaying) {
        scheduleRecognitionRestart(300);
      }
      return;
    }
    if (window.callActive && !callPlaying) {
      scheduleRecognitionRestart(800);
    }
  };
}

// ── VAD for barge-in during browser STT ──
let bargeInVADInterval = null;
let bargeInStream = null;
let bargeInAnalyser = null;

function startBargeInVAD() {
  if (bargeInVADInterval) return; // Already running
  
  navigator.mediaDevices.getUserMedia({ 
    audio: { echoCancellation: true, noiseSuppression: true }
  }).then(function(stream) {
    bargeInStream = stream;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    bargeInAnalyser = audioCtx.createAnalyser();
    bargeInAnalyser.fftSize = 512;
    source.connect(bargeInAnalyser);
    
    const dataArray = new Uint8Array(bargeInAnalyser.fftSize);
    
    bargeInVADInterval = setInterval(function() {
      if (!window.callActive) { stopBargeInVAD(); return; }
      if (!callPlaying) return; // Only check during TTS playback
      
      bargeInAnalyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      
      // Lower threshold for barge-in
      if (rms > 0.08) {
        if (activeTTSRunId) {
          secureSend(JSON.stringify({ type: 'barge_in', runId: activeTTSRunId }));
        }
        stopCallAudio();
        activeTTSRunId = null;
        setCallStatus('listening');
        if (window.setAvatarState) setAvatarState('listening');
        // Restart speech recognition to capture barge-in speech
        if (!callUseWhisper && SpeechRecognitionAPI) {
          try {
            if (callRecognition) callRecognition.abort();
          } catch(_e) { /* ignore */ }
          setTimeout(function() { startRecognition(); }, 100);
        }
      }
    }, 100);
  }).catch(function(err) {
    console.error('[VAD] Mic error:', err);
  });
}

function stopBargeInVAD() {
  if (bargeInVADInterval) {
    clearInterval(bargeInVADInterval);
    bargeInVADInterval = null;
  }
  if (bargeInStream) {
    bargeInStream.getTracks().forEach(function(t) { t.stop(); });
    bargeInStream = null;
  }
}

function startRecognition() {
  if (!SpeechRecognitionAPI || !window.callActive) return;
  if (callUseWhisper) return; // Don't start browser STT when Whisper mode is on
  // Keep running during TTS for barge-in support (removed callPlaying check)
  if (_sttStarting) return;
  _sttStarting = true;
  if (_sttRestartTimer) { clearTimeout(_sttRestartTimer); _sttRestartTimer = null; }

  // Reuse existing instance — avoids iOS re-prompting for mic permission
  ensureRecognitionInstance();

  try {
    callRecognition.start();
  } catch (e) {
    // If already running (InvalidStateError), abort and retry
    if (e.name === 'InvalidStateError') {
      try { callRecognition.abort(); } catch (_e2) { /* ignore */ }
      _sttStarting = false;
      scheduleRecognitionRestart(500);
    } else {
      console.error('[STT] .start() failed:', e);
      _sttStarting = false;
    }
  }
}

function stopRecognition() {
  if (_sttRestartTimer) { clearTimeout(_sttRestartTimer); _sttRestartTimer = null; }
  _sttStarting = false;
  _sttBargeInActive = false;
  _sttErrorHandled = false;
  if (callRecognition) {
    try { callRecognition.abort(); } catch (_e) { /* ignore */ }
    callRecognition = null; // destroy on full stop (endCall)
  }
}

// ── Browser TTS (speechSynthesis) ──
const synth = window.speechSynthesis;

// DEAD CODE: speakCallResponse was the browser speechSynthesis path.
// Server-side TTS (edge-tts) now handles all voice output via the
// tts_audio WebSocket messages and playNextTTSChunk(). This stub is
// kept for API compatibility in case any code path still calls it.
window.speakCallResponse = function(text) {
  // No-op — server TTS handles all audio playback
};

function playNextTTSChunk() {
  // Ensure AudioContext is ready — create if needed
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(_e) { /* ignore */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(function() {});
  }
  const queue = window._ttsQueue || [];
  if (queue.length === 0) {
    callPlaying = false;
    if (window.callActive) {
      setCallStatus('listening');
      if (window.setAvatarState) setAvatarState('listening');
      // Restart recording after TTS finishes
      if (sttActive) {
        setTimeout(startRecordingChunk, 300);
      }
    } else {
      if (window.setAvatarState) setAvatarState('idle');
    }
    return;
  }
  callPlaying = true;
  // Keep speech recognition running for barge-in
  if (!callUseWhisper && SpeechRecognitionAPI && callRecognition) {
    try {
      // Ensure recognition is active during TTS for barge-in
      if (callRecognition.state !== 'running') {
        callRecognition.start();
      }
    } catch(_e) { /* ignore - recognition may not be available */ }
  }
  if (window.setAvatarState) setAvatarState('talking');
  setCallStatus('speaking');
  const url = queue.shift();
  playTTSAudio(url, function() {
    // Play next chunk or finish
    playNextTTSChunk();
  });
}

function stopCallAudio() {
  if (synth) synth.cancel();
  if (activeTTSSource) {
    try { activeTTSSource.onended = null; activeTTSSource.stop(); } catch(_e) { /* ignore */ }
    activeTTSSource = null;
  }
  if (window._ttsAudioEl) {
    window._ttsAudioEl.pause();
    window._ttsAudioEl.onended = null;
    window._ttsAudioEl = null;
  }
  window._ttsQueue = [];
  callPlaying = false;
}

// ── Event listeners ──
// Tap avatar panel to start call (but not when clicking buttons or dragging camera)
if (avatarPanelEl) {
  const avatarDragState = { startX: 0, startY: 0, endX: 0, endY: 0 };
  // Use capture phase to always get pointer position, even if canvas stops propagation
  window.addEventListener('pointerdown', function(e) {
    avatarDragState.startX = e.clientX;
    avatarDragState.startY = e.clientY;
  }, true);
  window.addEventListener('pointerup', function(e) {
    avatarDragState.endX = e.clientX;
    avatarDragState.endY = e.clientY;
  }, true);
  avatarPanelEl.addEventListener('click', function(e) {
    // Check if it was a drag (moved > 10px)
    const dx = Math.abs(avatarDragState.endX - avatarDragState.startX);
    const dy = Math.abs(avatarDragState.endY - avatarDragState.startY);
    if (dx > 10 || dy > 10) return; // Was a drag, not a click
    if (e.target.closest('.avatar-buttons') || e.target.closest('.avatar-action-btn') ||
        e.target.closest('#callEndBtn') || e.target.closest('#callOverlay') ||
        e.target.closest('.avatar-menu')) return;
    if (window.callActive) { endCall(); } else { startCall(); }
  });
}

// Voice toggle in input area (if present) — toggles server TTS replies
const voiceToggle = document.getElementById('voiceToggle');
if (voiceToggle) {
  voiceToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    window.voiceMode = !window.voiceMode;
    voiceToggle.classList.toggle('active', window.voiceMode);
    if (ws && ws.readyState === 1) {
      secureSend(JSON.stringify({ type: 'voice_mode', enabled: window.voiceMode }));
    }
  });
}

const callEndBtnEl = document.getElementById('callEndBtn');
callEndBtnEl.addEventListener('click', function(e) {
  e.stopPropagation();
  e.preventDefault();
  endCall();
});
callEndBtnEl.addEventListener('touchend', function(e) {
  e.stopPropagation();
  e.preventDefault();
  endCall();
});

// (Whisper mode is always on — toggle removed)

// (Voice loading removed — server TTS handles all speech)

// ═══════════════════════════════════════════════════════════
// ─── TASK PANEL ───
// ═══════════════════════════════════════════════════════════
(function() {
  const taskBtn = document.getElementById('taskBtn');
  const taskBtnHeader = document.getElementById('taskBtnHeader');
  const taskPanel = document.getElementById('taskPanel');
  const taskList = document.getElementById('taskList');
  const taskCancel = document.getElementById('taskCancel');
  const taskClose = document.getElementById('taskPanelClose');
  const taskBadgeHeader = document.getElementById('taskBadgeHeader');
  let rawLines = [];

  function parseTasks(content) {
    rawLines = content.split('\n');
    const sections = [];
    let currentSection = { title: '', items: [] };
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i].trim();
      if (line.startsWith('## ') && line !== '## Priority Guide') {
        if (currentSection.title || currentSection.items.length) sections.push(currentSection);
        currentSection = { title: line.replace('## ', ''), items: [] };
      } else if (line.startsWith('- ')) {
        const text = line.slice(2);
        const done = text.startsWith('[x] ') || text.startsWith('✅');
        currentSection.items.push({ text: text, lineIndex: i, done: done });
      }
    }
    if (currentSection.title || currentSection.items.length) sections.push(currentSection);
    return sections;
  }

  function renderTasks(sections) {
    taskList.innerHTML = '';
    sections.forEach(function(section) {
      if (section.title) {
        const h = document.createElement('div');
        h.className = 'task-section-title';
        h.textContent = section.title;
        taskList.appendChild(h);
      }
      if (section.items.length === 0 && section.title) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-dim);font-size:13px;padding:6px 12px;';
        empty.textContent = 'No tasks';
        taskList.appendChild(empty);
      }
      section.items.forEach(function(item) {
        const row = document.createElement('div');
        row.className = 'task-item';
        const txt = document.createElement('span');
        txt.className = 'task-text' + (item.done ? ' done' : '');
        txt.textContent = item.text.replace(/^\[x\] /, '').replace(/^\[ \] /, '');
        const rm = document.createElement('button');
        rm.className = 'task-remove-btn';
        rm.textContent = '✕';
        rm.title = 'Remove task';
        rm.addEventListener('click', function() { removeTask(item.lineIndex); });
        row.appendChild(txt);
        row.appendChild(rm);
        taskList.appendChild(row);
      });
    });
    // Add new task input
    const addRow = document.createElement('div');
    addRow.className = 'task-add-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a task...';
    input.id = 'taskAddInput';
    const addBtn = document.createElement('button');
    addBtn.className = 'task-add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', function() { addTask(input.value); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && input.value.trim()) addTask(input.value);
    });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    taskList.appendChild(addRow);
  }

  function removeTask(lineIndex) {
    rawLines.splice(lineIndex, 1);
    saveAndRefresh();
  }

  function addTask(text) {
    if (!text.trim()) return;
    // Find the "Active" section and add after it
    let insertAt = -1;
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].trim() === '## Active') { insertAt = i + 1; break; }
    }
    if (insertAt === -1) {
      // Find first ## section with items
      for (let j = 0; j < rawLines.length; j++) {
        if (rawLines[j].trim().startsWith('## ') && rawLines[j].trim() !== '## Priority Guide') {
          insertAt = j + 1; break;
        }
      }
    }
    if (insertAt === -1) insertAt = rawLines.length;
    rawLines.splice(insertAt, 0, '- 🟡 ' + text.trim());
    saveAndRefresh();
  }

  function saveAndRefresh() {
    const content = rawLines.join('\n');
    fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + sessionToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: content })
    }).then(function() {
      const sections = parseTasks(content);
      renderTasks(sections);
      updateBadge(content);
    });
  }

  function openTasks() {
    taskPanel.classList.add('active');
    taskList.innerHTML = '<div style="padding:20px;color:var(--text-dim)">Loading...</div>';
    fetch('/api/tasks', {
      headers: { 'Authorization': 'Bearer ' + sessionToken }
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      const sections = parseTasks(data.content || '');
      renderTasks(sections);
      updateBadge(data.content);
    })
    .catch(function() {
      taskList.innerHTML = '<div style="padding:20px;color:#e53935">Error loading tasks</div>';
    });
  }

  function closeTasks() { taskPanel.classList.remove('active'); }

  function updateBadge(content) {
    const badge = document.getElementById('taskBadge');
    const badgeHeader = document.getElementById('taskBadgeHeader');
    const lines = (content || '').split('\n');
    let count = 0;
    let inDone = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith('## Done')) { inDone = true; continue; }
      if (l.startsWith('## ')) inDone = false;
      if (!inDone && l.startsWith('- ') && !l.startsWith('- [x]') && !l.startsWith('- ✅')) count++;
    }
    // Update both badges
    [badge, badgeHeader].forEach(function(b) {
      if (!b) return;
      if (count > 0) {
        b.textContent = count;
        b.classList.add('visible');
      } else {
        b.textContent = '';
        b.classList.remove('visible');
      }
    });
  }

  // Load badge on startup
  window.loadTaskBadge = function() {
    fetch('/api/tasks', {
      headers: { 'Authorization': 'Bearer ' + sessionToken }
    })
    .then(function(r) { return r.json(); })
    .then(function(data) { updateBadge(data.content); })
    .catch(function() {});
  };

  if (taskBtn) taskBtn.addEventListener('click', function(e) { e.stopPropagation(); openTasks(); });
  if (taskBtnHeader) taskBtnHeader.addEventListener('click', function(e) { e.stopPropagation(); openTasks(); });
  if (taskClose) taskClose.addEventListener('click', closeTasks);
  if (taskCancel) taskCancel.addEventListener('click', closeTasks);
  if (taskPanel) taskPanel.addEventListener('click', function(e) {
    if (e.target === taskPanel) closeTasks();
  });
})();

// ─── Menu & Passphrase ───
(function() {
  const menuBtn = document.getElementById('menuBtn');
  const avatarMenu = document.getElementById('avatarMenu');
  if (menuBtn && avatarMenu) {
    menuBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      avatarMenu.classList.toggle('open');
    });
    // Close menu on outside click
    document.addEventListener('click', function(e) {
      if (!avatarMenu.contains(e.target) && e.target !== menuBtn) {
        avatarMenu.classList.remove('open');
      }
    });
  }

  // ── Passkeys management ──
  const passkeysBtn = document.getElementById('passkeysBtn');
  const passkeysModal = document.getElementById('passkeysModal');
  const passkeysList = document.getElementById('passkeysList');
  const addPasskeyBtn = document.getElementById('addPasskeyBtn');
  const passkeysClose = document.getElementById('passkeysClose');

  function loadPasskeys() {
    fetch('/auth/passkeys', {
      headers: { 'Authorization': 'Bearer ' + sessionToken }
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.passkeys) return;
      passkeysList.innerHTML = '';
      data.passkeys.forEach(function(pk) {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:var(--surface2); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;';
        const info = document.createElement('div');
        const transports = (pk.transports || []).join(', ') || 'unknown';
        const date = pk.createdAt ? new Date(pk.createdAt).toLocaleDateString() : 'unknown';
        info.innerHTML = '<div style="font-size:14px; font-weight:600;">' +
          (pk.deviceType === 'multiDevice' ? '☁️' : '💻') + ' ' +
          (pk.deviceType === 'multiDevice' ? 'Synced' : 'Device-bound') +
          (pk.backedUp ? ' ✓' : '') + '</div>' +
          '<div style="font-size:12px; color:var(--text-dim);">' + transports + ' · ' + date + '</div>';
        div.appendChild(info);
        if (data.passkeys.length > 1) {
          const del = document.createElement('button');
          del.textContent = '🗑';
          del.style.cssText = 'background:none; border:none; font-size:18px; cursor:pointer; padding:4px 8px;';
          del.onclick = function() {
            if (!confirm('Delete this passkey?')) return;
            fetch('/auth/passkeys', {
              method: 'DELETE',
              headers: { 'Authorization': 'Bearer ' + sessionToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: pk.id })
            }).then(function() { loadPasskeys(); });
          };
          div.appendChild(del);
        }
        passkeysList.appendChild(div);
      });
    });
  }

  if (passkeysBtn) {
    passkeysBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      avatarMenu.classList.remove('open');
      loadPasskeys();
      passkeysModal.classList.add('open');
    });
  }

  // Voice tip button — starts voice call when clicked
  const voiceTipBtn = document.getElementById('voiceTipBtn');
  if (voiceTipBtn) {
    voiceTipBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      avatarMenu.classList.remove('open');
      if (typeof startCall === 'function' && !window.callActive) {
        startCall();
      }
    });
  }

  // Copy URL button
  const copyUrlBtn = document.getElementById('copyUrlBtn');
  if (copyUrlBtn) {
    copyUrlBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const cleanUrl = window.location.origin + window.location.pathname;
      navigator.clipboard.writeText(cleanUrl).then(function() {
        copyUrlBtn.innerHTML = copyUrlBtn.innerHTML.replace('Copy App URL', 'Copied!');
        setTimeout(function() {
          copyUrlBtn.innerHTML = copyUrlBtn.innerHTML.replace('Copied!', 'Copy App URL');
        }, 1500);
      }).catch(function() {
        // Fallback for older browsers
        const input = document.createElement('input');
        input.value = cleanUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        copyUrlBtn.innerHTML = copyUrlBtn.innerHTML.replace('Copy App URL', 'Copied!');
        setTimeout(function() {
          copyUrlBtn.innerHTML = copyUrlBtn.innerHTML.replace('Copied!', 'Copy App URL');
        }, 1500);
      });
    });
  }

  // Logout button
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      avatarMenu.classList.remove('open');
      // Clear session and reload
      localStorage.removeItem('clawtime_session');
      sessionToken = null;
      if (ws) ws.close();
      location.reload();
    });
  }

  if (addPasskeyBtn) {
    addPasskeyBtn.addEventListener('click', async function() {
      addPasskeyBtn.disabled = true;
      addPasskeyBtn.textContent = 'Registering...';
      try {
        const optRes = await fetch('/auth/register-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const optData = await optRes.json();
        if (!optData.options) throw new Error('No options from server: ' + JSON.stringify(optData));
        const cred = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: optData.options });
        const verRes = await fetch('/auth/register-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId: optData.challengeId, response: cred })
        });
        const verData = await verRes.json();
        if (verData.verified) {
          addPasskeyBtn.textContent = '✓ Added!';
          setTimeout(function() { addPasskeyBtn.textContent = '+ Add Passkey'; addPasskeyBtn.disabled = false; }, 2000);
          loadPasskeys();
        } else {
          throw new Error(verData.error || 'Verification failed');
        }
      } catch(e) {
        console.error('Passkey registration error:', e);
        alert('Passkey registration failed: ' + e.message);
        addPasskeyBtn.textContent = '+ Add Passkey';
        addPasskeyBtn.disabled = false;
      }
    });
  }

  if (passkeysClose) {
    passkeysClose.addEventListener('click', function() {
      passkeysModal.classList.remove('open');
    });
  }
  if (passkeysModal) {
    passkeysModal.addEventListener('click', function(e) {
      if (e.target === passkeysModal) passkeysModal.classList.remove('open');
    });
  }

  // ─── Avatar Manager ───
  const avatarManagerBtn = document.getElementById('avatarManagerBtn');
  const avatarManagerModal = document.getElementById('avatarManagerModal');
  const avatarList = document.getElementById('avatarList');
  const selectAvatarBtn = document.getElementById('selectAvatarBtn');
  const deleteAvatarBtn = document.getElementById('deleteAvatarBtn');
  const avatarManagerClose = document.getElementById('avatarManagerClose');

  let availableAvatars = [];  // Populated from server via /api/avatar/list
  
  // Fetch avatar list from server (includes cloud only if file exists)
  function refreshAvatarList() {
    return fetch('/api/avatar/list').then(function(r) { return r.json(); }).then(function(data) {
      if (data.avatars) availableAvatars = data.avatars;
    }).catch(function() {});
  }
  refreshAvatarList();
  // Prefer server's avatar selection (from pre-fetch), fall back to localStorage
  let currentAvatar = (window.CLAWTIME_THEME && window.CLAWTIME_THEME.id) || localStorage.getItem('selectedAvatar');
  let previewingAvatar = null;
  let previewAnimationId = null;

  function getAvatarData(id) {
    const found = availableAvatars.find(function(a) { return a.id === id; }) || availableAvatars[0];
    return found || { id: id || 'unknown', emoji: '🎭', color: 'f97316', name: 'Loading...' };
  }

  // Apply avatar theme (emoji + color)
  function applyAvatarTheme(avatarId) {
    const av = getAvatarData(avatarId);
    
    // Update favicon emoji (remove+create to defeat caching)
    const oldLink = document.querySelector('link[rel="icon"]');
    if (oldLink) oldLink.remove();
    const newLink = document.createElement('link');
    newLink.rel = 'icon';
    newLink.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>" + encodeURIComponent(av.emoji) + "</text></svg>";
    document.head.appendChild(newLink);
    
    // Update theme accent color
    document.documentElement.style.setProperty('--accent', '#' + av.color);
    
    // Update auth screen emoji if visible
    const authEmoji = document.getElementById('authEmoji');
    if (authEmoji) authEmoji.textContent = av.emoji;
    
    // Update welcome emoji in chat panel
    const welcomeEmoji = document.getElementById('welcomeEmoji');
    if (welcomeEmoji) welcomeEmoji.textContent = av.emoji;
    
    // Update bot emoji config
    CFG.botEmoji = av.emoji;
    
    // Update all existing bot message avatars
    document.querySelectorAll('.message.bot .msg-avatar').forEach(function(el) {
      el.textContent = av.emoji;
    });
    
    // Title stays as just "ClawTime" — emoji in favicon only
  }

  // Dynamically load avatar without page refresh
  function loadAvatar(avatarId) {
    return new Promise(function(resolve, reject) {
      
      // Clear existing avatar scene completely
      const canvas = document.getElementById('avatarCanvas');
      if (canvas) {
        // Remove all children including the WebGL canvas
        while (canvas.firstChild) {
          canvas.removeChild(canvas.firstChild);
        }
      }
      
      // Reset any global avatar state
      window.initAvatarScene = null;
      window.setAvatarState = null;
      window.setAvatarConnection = null;
      window.adjustAvatarCamera = null;
      window._laptopParts = null;
      window._screenGlow = null;
      window._leftArm = null;
      window._rightArm = null;
      window._keyParts = null;
      
      // Remove ALL avatar scripts (not just by id)
      document.querySelectorAll('script[src*="avatar.js"]').forEach(function(s) {
        s.remove();
      });
      
      // Load new avatar script with cache-busting
      const script = document.createElement('script');
      script.src = '/avatar.js?avatar=' + avatarId + '&t=' + Date.now();
      script.onload = function() {
        // Give browser time to parse and execute
        setTimeout(function() {
          if (window.initAvatarScene) {
            window.initAvatarScene();
            // Server is source of truth for avatar state - no wrapping needed
            // Trigger resize to ensure proper scaling
            window.dispatchEvent(new Event('resize'));
          } else {
            console.error('[Avatar] initAvatarScene not found!');
          }
          resolve();
        }, 100);
      };
      script.onerror = function(e) {
        console.error('[Avatar] Failed to load script:', e);
        reject(e);
      };
      document.body.appendChild(script);
    });
  }

  function startPreviewAnimation() {
    stopPreviewAnimation();
    const states = ['idle', 'thinking', 'talking', 'happy', 'working', 'sleeping', 'error'];
    let i = 0;
    function cycle() {
      if (!avatarManagerModal.classList.contains('open')) {
        if (window.setAvatarState) window.setAvatarState('idle');
        previewAnimationId = null;
        return;
      }
      if (window.setAvatarState) window.setAvatarState(states[i]);
      i = (i + 1) % states.length;
      previewAnimationId = setTimeout(cycle, 1500);
    }
    cycle();
  }

  function stopPreviewAnimation() {
    if (previewAnimationId) {
      clearTimeout(previewAnimationId);
      previewAnimationId = null;
    }
  }

  function updateButtonVisibility() {
    const av = getAvatarData(previewingAvatar);
    if (selectAvatarBtn) {
      selectAvatarBtn.style.display = (previewingAvatar !== currentAvatar) ? 'inline-block' : 'none';
    }
    if (deleteAvatarBtn) {
      // Show delete for any avatar that's not currently in use
      deleteAvatarBtn.style.display = (previewingAvatar !== currentAvatar) ? 'inline-block' : 'none';
    }
  }

  function renderAvatarList() {
    if (!avatarList) return;
    avatarList.innerHTML = '';
    availableAvatars.forEach(function(av) {
      const isSelected = currentAvatar === av.id;
      const isPreviewing = previewingAvatar === av.id;
      const card = document.createElement('div');
      card.className = 'avatar-card' + (isSelected ? ' selected' : '') + (isPreviewing ? ' previewing' : '');
      
      let html = '<div class="avatar-card-emoji">' + av.emoji + '</div>' +
                 '<div class="avatar-card-name">' + av.name + '</div>' +
                 '<div class="avatar-card-desc">' + av.description + '</div>';
      if (isSelected) html += '<div class="avatar-card-badge">Current</div>';
      card.innerHTML = html;
      
      card.onclick = function() {
        previewingAvatar = av.id;
        renderAvatarList();
        updateButtonVisibility();
        // Load and preview this avatar immediately
        loadAvatar(av.id).then(function() {
          startPreviewAnimation();
        });
      };
      avatarList.appendChild(card);
    });
    updateButtonVisibility();
  }

  if (avatarManagerBtn) {
    avatarManagerBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      document.getElementById('avatarMenu').classList.remove('open');
      // Re-sync currentAvatar from server theme (may have loaded after init)
      if (window.CLAWTIME_THEME && window.CLAWTIME_THEME.id) {
        currentAvatar = window.CLAWTIME_THEME.id;
      }
      previewingAvatar = currentAvatar;
      // Refresh avatar list from server then open modal
      refreshAvatarList().then(function() {
        renderAvatarList();
        avatarManagerModal.classList.add('open');
        startPreviewAnimation();
      });
    });
  }

  if (selectAvatarBtn) {
    selectAvatarBtn.addEventListener('click', function() {
      if (!previewingAvatar || previewingAvatar === currentAvatar) return;
      stopPreviewAnimation();
      // Save selection
      currentAvatar = previewingAvatar;
      localStorage.setItem('selectedAvatar', currentAvatar);
      // Update CLAWTIME_THEME so modal re-open shows correct selection
      if (window.CLAWTIME_THEME) {
        window.CLAWTIME_THEME.id = currentAvatar;
        const av = getAvatarData(currentAvatar);
        if (av) {
          window.CLAWTIME_THEME.emoji = av.emoji;
          window.CLAWTIME_THEME.color = av.color;
        }
      }
      // Apply theme immediately
      applyAvatarTheme(currentAvatar);
      // Notify server to save preference
      fetch('/api/avatar/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: currentAvatar })
      }).then(function() {
        renderAvatarList();
        updateButtonVisibility();
        if (window.setAvatarState) window.setAvatarState('idle');
      });
    });
  }

  if (deleteAvatarBtn) {
    deleteAvatarBtn.addEventListener('click', function() {
      const av = getAvatarData(previewingAvatar);
      if (!av) return;
      if (!confirm('Delete "' + av.name + '" avatar?')) return;
      fetch('/api/avatar/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: previewingAvatar })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) {
          const deletedAvatar = previewingAvatar;
          const wasCurrentAvatar = (deletedAvatar === currentAvatar);
          
          // Remove from available avatars list
          availableAvatars = availableAvatars.filter(function(a) { return a.id !== deletedAvatar; });
          
          // Server prevents deleting current avatar, so just update the list
          previewingAvatar = currentAvatar;
          loadAvatar(currentAvatar).then(function() {
            renderAvatarList();
          });
          // Close the modal
          avatarManagerModal.classList.remove('open');
        } else {
          alert(data.error || 'Failed to delete avatar');
        }
      }).catch(function(e) {
        alert('Error deleting avatar');
      });
    });
  }

  if (avatarManagerClose) {
    avatarManagerClose.addEventListener('click', function() {
      stopPreviewAnimation();
      avatarManagerModal.classList.remove('open');
      // Reload current avatar if we were just previewing
      if (previewingAvatar !== currentAvatar) {
        loadAvatar(currentAvatar);
      }
      if (window.setAvatarState) window.setAvatarState('idle');
    });
  }

  if (avatarManagerModal) {
    avatarManagerModal.addEventListener('click', function(e) {
      if (e.target === avatarManagerModal) {
        stopPreviewAnimation();
        avatarManagerModal.classList.remove('open');
        if (previewingAvatar !== currentAvatar) {
          loadAvatar(currentAvatar);
        }
        if (window.setAvatarState) window.setAvatarState('idle');
      }
    });
  }

  // Apply saved avatar theme on load
  applyAvatarTheme(currentAvatar);
  // Sync localStorage with server preference
  localStorage.setItem('selectedAvatar', currentAvatar);
  // Load avatar on page init (needed for avatar state sync)
  if (currentAvatar) {
    loadAvatar(currentAvatar);
  }
})();

// ─── Start ───
init();

// ─── Service Worker Registration ───
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function(){});
}
