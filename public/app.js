// ─── Version check: use query string hash for cache busting ───
// No hardcoded version — rely on ?v= query strings in HTML for cache control
(function() {
  console.log('[ClawTime] JS loaded, version:', window.CLAWTIME_VERSION || 'unknown');
})();

// ─── Config (loaded from server) ───
var CFG = {
  botName: 'ClawTime',
  botEmoji: null,  // Set from avatar theme
  botTagline: 'Your AI assistant. Type a message to start chatting.',
  enableAvatar: true,
  themeAccent: null,  // Set from avatar theme
};

// Load config from server before anything else
async function loadConfig() {
  try {
    var res = await fetch('/api/config');
    var data = await res.json();
    Object.assign(CFG, data);
  } catch (e) {
    // Use defaults
  }
  
  // Apply avatar theme (from pre-fetch or fetch now)
  var theme = window.CLAWTIME_THEME;
  if (!theme) {
    try {
      var r = await fetch('/api/avatar/current');
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
  var r = document.documentElement;
  var hex = CFG.themeAccent;
  if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) {
    var rr = parseInt(hex.slice(0,2), 16);
    var gg = parseInt(hex.slice(2,4), 16);
    var bb = parseInt(hex.slice(4,6), 16);
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
  var taskBtn = document.getElementById('taskBtn');
  var taskBtnHeader = document.getElementById('taskBtnHeader');
  if (taskBtn && !CFG.enableTasks) taskBtn.style.display = 'none';
  if (taskBtnHeader && !CFG.enableTasks) taskBtnHeader.style.display = 'none';

  // Voice button visibility
  var voiceBtn = document.getElementById('callToggleBtn');
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
const botMessagesByRunId = new Map();
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
let deltaGapTimer = null;
let activeRunning = false;

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
  var indicator = document.getElementById('load-more');
  if (indicator) indicator.remove();
}

function showLoadingIndicator() {
  var el = document.getElementById('loading-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-indicator';
    el.style.cssText = 'text-align:center;padding:12px;color:var(--text-dim);font-size:13px;';
    el.textContent = 'Loading messages…';
    messagesEl.prepend(el);
  }
}

function removeLoadingIndicator() {
  var el = document.getElementById('loading-indicator');
  if (el) el.remove();
}

function loadOlderMessages() {
  if (loadingMore || historyIndex <= 0) return;
  loadingMore = true;

  var newStart = Math.max(0, historyIndex - HISTORY_PAGE_SIZE);

  // Remove indicators first and measure
  removeLoadMoreIndicator();
  removeLoadingIndicator();

  // Record current state
  var prevScrollHeight = messagesEl.scrollHeight;
  var prevScrollTop = messagesEl.scrollTop;

  // Temporarily prevent scroll events by setting overflow
  var prevOverflow = messagesEl.style.overflow;
  messagesEl.style.overflow = 'hidden';

  // Create a document fragment for batch DOM insertion
  var fragment = document.createDocumentFragment();
  var tempMessages = [];
  
  for (var i = newStart; i < historyIndex; i++) {
    var m = historyMessages[i];
    if (m.widget) continue; // Skip widgets
    
    var div = document.createElement('div');
    div.className = 'message ' + m.role;
    
    var bubble = document.createElement('div');
    bubble.className = 'bubble ' + m.role;
    
    if (m.images && m.images.length > 0) {
      var img = document.createElement('img');
      img.className = 'msg-image';
      img.src = m.images[0];
      bubble.appendChild(img);
      if (m.text) {
        var textDiv = document.createElement('div');
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
  var firstChild = messagesEl.firstChild;
  for (var j = tempMessages.length - 1; j >= 0; j--) {
    messagesEl.insertBefore(tempMessages[j], firstChild);
  }

  historyIndex = newStart;

  // Calculate new scroll position to maintain view
  var newScrollHeight = messagesEl.scrollHeight;
  var heightAdded = newScrollHeight - prevScrollHeight;
  
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
  var hasContent = !!(inputEl.value.trim() || pendingAttachments.length > 0);
  sendBtn.disabled = !hasContent || !connected;
}

// ─── Initialize ───
async function init() {
  console.log('[Auth] init() starting');
  await loadConfig();
  console.log('[Auth] loadConfig done');

  // Token-based auth for automated testing
  var urlParams = new URLSearchParams(window.location.search);
  var testToken = urlParams.get('token');
  if (testToken) {
    try {
      var tokenRes = await fetch('/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: testToken })
      });
      var tokenData = await tokenRes.json();
      if (tokenData.valid) {
        console.log('[Auth] Token auth successful');
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
  console.log('[Auth] checking /auth/status');

  try {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 5000);
    var res = await fetch('/auth/status?_=' + Date.now(), { signal: controller.signal, cache: 'no-store' });
    console.log('[Auth] /auth/status response:', res.status);
    clearTimeout(timeoutId);
    var data = await res.json();
    isRegistered = data.registered;
  } catch (e) {
    authError.textContent = e.name === 'AbortError' ? 'Auth check timed out — try hard refresh (Cmd+Shift+R)' : 'Failed to check auth status';
    return;
  }

  if (sessionToken) {
    try {
      var controller2 = new AbortController();
      var timeoutId2 = setTimeout(function() { controller2.abort(); }, 5000);
      var res = await fetch('/auth/session?_=' + Date.now(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken }),
        signal: controller2.signal,
        cache: 'no-store',
      });
      clearTimeout(timeoutId2);
      var data = await res.json();
      if (data.valid) {
        enterChat();
        return;
      }
    } catch {}
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
    var urlParams = new URLSearchParams(window.location.search);
    var setupToken = urlParams.get('setup');
    if (setupToken) {
      window._setupToken = setupToken;
      authLabel.textContent = 'Set up your passkey to get started';
      authBtnText.textContent = 'Register passkey';
    } else {
      authLabel.textContent = 'Enter setup token to register';
      // Show token input
      var tokenInput = document.createElement('input');
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
  var name = err.name || '';
  var msg = err.message || '';
  
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
    var optRes = await fetch('/auth/register-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: window._setupToken || undefined }),
    });
    var optData = await optRes.json();
    if (optData.error) throw new Error(optData.error);
    var { options, challengeId } = optData;
    var attResp = await startRegistration({ optionsJSON: options });

    var verRes = await fetch('/auth/register-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: attResp }),
    });
    var verData = await verRes.json();

    if (verData.verified && verData.token) {
      sessionToken = verData.token;
      localStorage.setItem('clawtime_session', sessionToken);
      enterChat();
    } else {
      authError.textContent = verData.error || 'Registration failed';
      authBtn.disabled = false;
    }
  } catch (err) {
    console.log('[Auth] Registration error:', err.name, err.message);
    authError.textContent = getPasskeyErrorMessage(err, false);
    authBtn.disabled = false;
  }
}

// ─── Passkey Authentication ───
async function doLogin() {
  authBtn.disabled = true;
  authError.textContent = '';

  try {
    var optRes = await fetch('/auth/login-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!optRes.ok) {
      throw new Error('Login options failed: ' + optRes.status);
    }
    var optData = await optRes.json();
    console.log('[Auth] Login options:', optData);
    var options = optData.options;
    var challengeId = optData.challengeId;
    if (!options) {
      throw new Error('Invalid login options received');
    }
    if (!options.allowCredentials || options.allowCredentials.length === 0) {
      authError.textContent = 'No passkeys registered. Contact the admin for a setup link.';
      authBtn.disabled = false;
      return;
    }
    var authResp = await startAuthentication({ optionsJSON: options });

    var verRes = await fetch('/auth/login-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, response: authResp }),
    });
    var verData = await verRes.json();

    if (verData.verified && verData.token) {
      console.log('[Auth] Login verified, token received:', verData.token.slice(0, 8) + '...');
      sessionToken = verData.token;
      localStorage.setItem('clawtime_session', sessionToken);
      enterChat();
    } else {
      console.log('[Auth] Login failed:', verData);
      authError.textContent = verData.error || 'Authentication failed';
      authBtn.disabled = false;
    }
  } catch (err) {
    console.log('[Auth] Login error:', err.name, err.message);
    authError.textContent = getPasskeyErrorMessage(err, true);
    authBtn.disabled = false;
  }
}

authBtn.addEventListener('click', function() {
  if (isRegistered) { doLogin(); } else { doRegister(); }
});

// ─── Enter chat ───
function enterChat() {
  console.log('[Chat] enterChat called, sessionToken:', sessionToken?.slice(0, 8) + '...');
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
  var s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Extract code blocks first to protect them from other transformations
  var codeBlocks = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    var placeholder = '%%CODEBLOCK' + codeBlocks.length + '%%';
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
      var relUrl = url.startsWith('/') ? url : new URL(url).pathname;
      // Check if we already have a blob URL cached for this resource
      var cached = window._e2eBlobCache && window._e2eBlobCache[relUrl];
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
  s = s.replace(/\[([^\]]*)\]\((\/tts\/[^\)]+\.mp3)\)/g, '<div style="margin:6px 0"><div style="font-size:13px;margin-bottom:4px">$1</div><audio controls style="width:100%;height:36px" src="$2"></audio></div>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, label, url) {
    var isFile = /\.(pdf|zip|doc|docx|xls|xlsx|csv|txt)(\?.*)?$/i.test(url);
    if (isFile) {
      var fname = url.split('/').pop().split('?')[0];
      return '<a href="' + url + '" onclick="event.preventDefault();window.openFileViewer(\'' + url + '\',\'' + fname + '\')" rel="noopener">' + label + '</a>';
    }
    return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
  });
  s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
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
  var timeEl = bubble.querySelector('.msg-time');
  var quoteEl = bubble.querySelector('.reply-quote');
  
  // Extract widgets from text
  var extracted = extractWidgets(text);
  text = extracted.text;
  var widgets = extracted.widgets;
  
  bubble.innerHTML = '';
  bubble.dataset.rawText = text;
  if (quoteEl) bubble.appendChild(quoteEl);
  var contentDiv = document.createElement('div');
  try {
    contentDiv.innerHTML = renderMarkdown(text);
  } catch (e) {
    console.error('[Markdown] Render error:', e);
    contentDiv.textContent = text; // Fallback to plain text
  }
  bubble.appendChild(contentDiv);
  
  // Render extracted widgets
  for (var i = 0; i < widgets.length; i++) {
    var widgetEl = renderWidget(widgets[i]);
    if (widgetEl) bubble.appendChild(widgetEl);
  }
  
  if (timeEl) bubble.appendChild(timeEl);
}

// ─── Message Context Menu & Reply ───
var contextMenu = null;
var replyTarget = null;
var longPressTimer = null;

function showContextMenu(x, y, bubbleEl, sender) {
  hideContextMenu();
  var menu = document.createElement('div');
  menu.className = 'msg-context-menu';

  var copyBtn = document.createElement('button');
  copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
  copyBtn.onclick = function() {
    var rawText = bubbleEl.dataset.rawText || bubbleEl.innerText.replace(/\d{2}:\d{2}\s*(AM|PM)?$/m, '').trim();
    navigator.clipboard.writeText(rawText).then(function() {
      copyBtn.innerHTML = '✅ Copied!';
      setTimeout(hideContextMenu, 600);
    });
  };
  menu.appendChild(copyBtn);

  var replyBtn = document.createElement('button');
  replyBtn.innerHTML = '↩️ Reply';
  replyBtn.onclick = function() {
    var rawText = bubbleEl.dataset.rawText || bubbleEl.innerText.replace(/\d{2}:\d{2}\s*(AM|PM)?$/m, '').trim();
    setReplyTarget(sender, rawText, bubbleEl);
    hideContextMenu();
  };
  menu.appendChild(replyBtn);

  document.body.appendChild(menu);
  contextMenu = menu;

  var rect = menu.getBoundingClientRect();
  var mx = Math.min(x, window.innerWidth - rect.width - 10);
  var my = Math.min(y, window.innerHeight - rect.height - 10);
  menu.style.left = Math.max(5, mx) + 'px';
  menu.style.top = Math.max(5, my) + 'px';
}

function hideContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

function setReplyTarget(sender, text, bubbleEl) {
  replyTarget = { sender: sender, text: text, bubbleEl: bubbleEl };
  var replyBar = document.getElementById('replyBar');
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
  var bubble = e.target.closest('.bubble');
  if (!bubble) return;
  e.preventDefault();
  var msg = bubble.closest('.message');
  var sender = msg && msg.classList.contains('user') ? 'user' : 'bot';
  showContextMenu(e.clientX, e.clientY, bubble, sender);
});

messagesEl.addEventListener('touchstart', function(e) {
  var bubble = e.target.closest('.bubble');
  if (!bubble) return;
  longPressTimer = setTimeout(function() {
    var touch = e.touches[0];
    var msg = bubble.closest('.message');
    var sender = msg && msg.classList.contains('user') ? 'user' : 'bot';
    showContextMenu(touch.clientX, touch.clientY, bubble, sender);
  }, 500);
}, { passive: true });

messagesEl.addEventListener('touchend', function() { clearTimeout(longPressTimer); });
messagesEl.addEventListener('touchmove', function() { clearTimeout(longPressTimer); });

// ─── Chat Messages ───
function formatTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Extract [[WIDGET:{...}]] from text, return { text, widgets }
function extractWidgets(text) {
  if (!text) return { text: text, widgets: [] };
  var widgets = [];
  var cleaned = text.replace(/\[\[WIDGET:([\s\S]*?)\]\]/g, function(match, json) {
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
  var welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  // Extract widgets from text (bot messages only)
  var extractedWidgets = [];
  if (sender === 'bot') {
    var extracted = extractWidgets(text);
    text = extracted.text;
    extractedWidgets = extracted.widgets;
  }

  var div = document.createElement('div');
  div.className = 'message ' + sender;

  var avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = sender === 'bot' ? CFG.botEmoji : '👤';

  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.dataset.rawText = text;

  if (opts.replyTo) {
    var quote = document.createElement('div');
    quote.className = 'reply-quote';
    var qs = document.createElement('div');
    qs.className = 'reply-quote-sender';
    qs.textContent = opts.replyTo.sender === 'bot' ? CFG.botName : 'You';
    var qt = document.createElement('div');
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
    var contentDiv = document.createElement('div');
    contentDiv.innerHTML = renderMarkdown(text);
    bubble.appendChild(contentDiv);
  } else {
    bubble.appendChild(document.createTextNode(text));
  }

  // Render extracted widgets inside the bubble
  for (var i = 0; i < extractedWidgets.length; i++) {
    var widgetEl = renderWidget(extractedWidgets[i]);
    if (widgetEl) bubble.appendChild(widgetEl);
  }

  var timeStr = formatTime(opts.timestamp || Date.now());
  if (timeStr) {
    var timeEl = document.createElement('span');
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
    var isNearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150;
    if (isNearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  return bubble;
}

function processChatEvent(msg) {
  var state = msg.state, runId = msg.runId, text = msg.text || '', error = msg.error, images = msg.images || [];

  if (state === 'delta') {
    hideTyping();
    activeRunning = true;
    var existing = botMessagesByRunId.get(runId);
    
    if (existing) {
      if (existing.finalized) {
        // RunId was finalized but got reused — start fresh bubble
        clearTimeout(existing.cleanupTimer);
        var bubble = addMessage(text, 'bot', { timestamp: Date.now() });
        botMessagesByRunId.set(runId, { bubble: bubble, runId: runId, finalized: false, maxTextLen: text.length });
      } else {
        // CRITICAL: Never let shorter text overwrite longer text (cumulative deltas)
        // Only update if new text is longer OR similar length (allow small fluctuations)
        if (text.length >= existing.maxTextLen - 10) {
          var existingTimeEl = existing.bubble.querySelector('.msg-time');
          setBubbleContent(existing.bubble, text);
          if (existingTimeEl) existing.bubble.appendChild(existingTimeEl);
          existing.maxTextLen = Math.max(existing.maxTextLen || 0, text.length);
        }
        // else: shorter text with same runId — ignore silently (cumulative delta protection)
      }
    } else {
      // New runId — create bubble
      var bubble = addMessage(text, 'bot', { timestamp: Date.now() });
      botMessagesByRunId.set(runId, { bubble: bubble, runId: runId, finalized: false, maxTextLen: text.length });
    }
    
    if ((messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    if (window.setAvatarState) setAvatarState('talking');
    clearTimeout(deltaGapTimer);
    deltaGapTimer = setTimeout(function() {
      if (activeRunning && window.setAvatarState) {
        var deltaText = (text || '');
        if (/```/.test(deltaText)) { setAvatarState('coding'); }
        else { setAvatarState('working'); }
      }
    }, 2000);

  } else if (state === 'final') {
    hideTyping();
    if (text) {
      var existing = botMessagesByRunId.get(runId);
      if (existing && !existing.finalized) {
        // Final always updates (it's authoritative)
        setBubbleContent(existing.bubble, text);
        existing.maxTextLen = text.length;
      } else if (!existing) {
        var bubble = addMessage(text, 'bot', { timestamp: Date.now() });
        botMessagesByRunId.set(runId, { bubble: bubble, runId: runId, finalized: false, maxTextLen: text.length });
      }
    }
    // Render inline images from bot response
    if (images && images.length > 0) {
      for (var i = 0; i < images.length; i++) {
        addImageMessage('', 'bot', images[i], { timestamp: Date.now() });
      }
    }
    var entry = botMessagesByRunId.get(runId);
    if (entry) {
      entry.finalized = true;
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = setTimeout(function() {
        var current = botMessagesByRunId.get(runId);
        if (current && current.finalized) botMessagesByRunId.delete(runId);
      }, 60000);
    }
    if ((messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    activeRunning = false;
    clearTimeout(deltaGapTimer);

    // Server TTS handles audio — just update avatar state
    if (window.setAvatarState) {
      var finalText = text || '';
      var avatarState = 'happy';
      if (/```/.test(finalText) || /\bcode\b|\bfix(ed|ing)?\b|\bbug\b|\bfunction\b|\bsyntax\b/i.test(finalText)) {
        avatarState = 'coding';
      } else if (/🎉|✅|done|complete|success|shipped|fixed|working now|nailed/i.test(finalText)) {
        avatarState = 'celebrating';
      } else if (/error|fail|broken|crash|issue|unfortunately|can't|impossible/i.test(finalText)) {
        avatarState = 'frustrated';
      } else if (/think|consider|reflect|hmm|interesting|wonder|philosophy|meaning/i.test(finalText)) {
        avatarState = 'reflecting';
      }
      setAvatarState(avatarState);
      setTimeout(function() { setAvatarState('idle'); }, 4000);
    }

  } else if (state === 'error') {
    hideTyping();
    activeRunning = false;
    clearTimeout(deltaGapTimer);
    var errorText = error || 'Something went wrong';
    addMessage('Error: ' + errorText, 'bot', { timestamp: Date.now() });
    var errEntry = botMessagesByRunId.get(runId);
    if (errEntry) clearTimeout(errEntry.cleanupTimer);
    botMessagesByRunId.delete(runId);
    if (window.setAvatarState) {
      if (/rate.?limit|rate_limit|429/i.test(errorText)) {
        setAvatarState('sleeping');
      } else {
        setAvatarState('error');
        setTimeout(function() { setAvatarState('idle'); }, 2000);
      }
    }

  } else if (state === 'aborted') {
    hideTyping();
    activeRunning = false;
    clearTimeout(deltaGapTimer);
    var abortEntry = botMessagesByRunId.get(runId);
    if (abortEntry) clearTimeout(abortEntry.cleanupTimer);
    botMessagesByRunId.delete(runId);
    if (window.setAvatarState) setAvatarState('idle');
  }
}

// ─── Widget System ───
var activeWidgets = new Map(); // id -> { element, data, type }

function sendWidgetResponse(id, widgetType, value, action) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  var response = {
    type: 'widget_response',
    id: id,
    widget: widgetType,
    value: value,
    action: action || 'submit'
  };
  ws.send(JSON.stringify(response));
  console.log('[Widget] Sent response:', response);
}

function renderWidget(widgetData) {
  var id = widgetData.id;
  var type = widgetData.widget;
  // Merge top-level properties into data (allows both formats)
  // Copy all properties except meta fields
  var data = Object.assign({}, widgetData.data || {});
  var skipKeys = ['id', 'widget', 'type', 'data', 'inline'];
  Object.keys(widgetData).forEach(function(key) {
    if (skipKeys.indexOf(key) === -1 && widgetData[key] !== undefined) {
      data[key] = widgetData[key];
    }
  });
  var inline = widgetData.inline || false;
  
  // Check if updating existing widget
  var existing = activeWidgets.get(id);
  if (existing && type === 'progress') {
    // Update progress in place
    updateProgressWidget(existing.element, data);
    return existing.element;
  }
  
  var container = document.createElement('div');
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
  var welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  messagesEl.appendChild(container);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  
  return container;
}

function renderButtonsWidget(container, id, data) {
  var promptText = data.prompt || data.label;
  if (promptText) {
    var prompt = document.createElement('div');
    prompt.className = 'widget-prompt';
    prompt.textContent = promptText;
    container.appendChild(prompt);
  }
  
  var btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group' + (data.layout === 'vertical' ? ' vertical' : '');
  
  var options = data.options || data.buttons || [];
  options.forEach(function(opt) {
    var btn = document.createElement('button');
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
    var submitBtn = document.createElement('button');
    submitBtn.className = 'widget-btn primary widget-submit';
    submitBtn.textContent = 'Submit';
    submitBtn.addEventListener('click', function() {
      if (container.classList.contains('disabled')) return;
      var selected = Array.from(btnGroup.querySelectorAll('.selected')).map(function(b) {
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
    var title = document.createElement('div');
    title.className = 'widget-title';
    title.textContent = data.title;
    container.appendChild(title);
  }
  
  var messageText = data.message || data.label;
  if (messageText) {
    var msg = document.createElement('div');
    msg.className = 'widget-message';
    msg.textContent = messageText;
    container.appendChild(msg);
  }
  
  var btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group';
  
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'widget-btn secondary';
  cancelBtn.textContent = data.cancelLabel || 'Cancel';
  cancelBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    container.classList.add('disabled');
    sendWidgetResponse(id, 'confirm', false, 'cancel');
  });
  
  var confirmBtn = document.createElement('button');
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
    var header = document.createElement('div');
    header.className = 'widget-code-header';
    header.textContent = data.filename;
    container.appendChild(header);
  }
  
  var pre = document.createElement('pre');
  pre.className = 'widget-code-block';
  if (data.language) pre.dataset.language = data.language;
  if (data.wrap) pre.style.whiteSpace = 'pre-wrap';
  
  var code = document.createElement('code');
  code.textContent = data.code || '';
  pre.appendChild(code);
  container.appendChild(pre);
  
  var actions = document.createElement('div');
  actions.className = 'widget-code-actions';
  
  if (data.showCopy !== false) {
    var copyBtn = document.createElement('button');
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
    var runBtn = document.createElement('button');
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
    var label = document.createElement('div');
    label.className = 'widget-progress-label';
    label.textContent = data.label;
    container.appendChild(label);
  }
  
  var barOuter = document.createElement('div');
  barOuter.className = 'widget-progress-bar';
  
  var barInner = document.createElement('div');
  barInner.className = 'widget-progress-fill';
  if (data.percent != null) {
    barInner.style.width = data.percent + '%';
  } else {
    barInner.classList.add('indeterminate');
  }
  
  barOuter.appendChild(barInner);
  container.appendChild(barOuter);
  
  var footer = document.createElement('div');
  footer.className = 'widget-progress-footer';
  
  if (data.status) {
    var status = document.createElement('span');
    status.className = 'widget-progress-status';
    status.textContent = data.status;
    footer.appendChild(status);
  }
  
  if (data.showPercent && data.percent != null) {
    var pct = document.createElement('span');
    pct.className = 'widget-progress-percent';
    pct.textContent = data.percent + '%';
    footer.appendChild(pct);
  }
  
  if (data.cancelable) {
    var cancelBtn = document.createElement('button');
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
    var label = document.createElement('div');
    label.className = 'widget-prompt';
    label.textContent = data.label;
    container.appendChild(label);
  }
  
  var inputWrap = document.createElement('div');
  inputWrap.className = 'widget-datepicker-wrap';
  
  var input = document.createElement('input');
  input.className = 'widget-form-input widget-datepicker-input';
  input.type = data.type || 'date'; // date, time, datetime-local
  if (data.value) input.value = data.value;
  if (data.min) input.min = data.min;
  if (data.max) input.max = data.max;
  input.dataset.fieldName = 'value';
  inputWrap.appendChild(input);
  container.appendChild(inputWrap);
  
  var btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group';
  
  var submitBtn = document.createElement('button');
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
  var items = data.items || [];
  if (items.length === 0) return;
  
  var currentIndex = 0;
  
  var carousel = document.createElement('div');
  carousel.className = 'widget-carousel';
  
  var viewport = document.createElement('div');
  viewport.className = 'widget-carousel-viewport';
  
  var track = document.createElement('div');
  track.className = 'widget-carousel-track';
  
  items.forEach(function(item, idx) {
    var slide = document.createElement('div');
    slide.className = 'widget-carousel-slide';
    
    if (item.type === 'image' || item.image || item.url) {
      var img = document.createElement('img');
      img.src = item.url || item.image;
      img.alt = item.caption || item.title || '';
      slide.appendChild(img);
    }
    
    if (item.title || item.caption || item.description) {
      var info = document.createElement('div');
      info.className = 'widget-carousel-info';
      if (item.title) {
        var title = document.createElement('div');
        title.className = 'widget-carousel-title';
        title.textContent = item.title;
        info.appendChild(title);
      }
      if (item.caption || item.description) {
        var desc = document.createElement('div');
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
    var prevBtn = document.createElement('button');
    prevBtn.className = 'widget-carousel-arrow prev';
    prevBtn.innerHTML = '‹';
    prevBtn.addEventListener('click', function() { goTo(currentIndex - 1); });
    carousel.appendChild(prevBtn);
    
    var nextBtn = document.createElement('button');
    nextBtn.className = 'widget-carousel-arrow next';
    nextBtn.innerHTML = '›';
    nextBtn.addEventListener('click', function() { goTo(currentIndex + 1); });
    carousel.appendChild(nextBtn);
  }
  
  var dots;
  function updateDots() {
    if (!dots) return;
    var dotEls = dots.querySelectorAll('.widget-carousel-dot');
    dotEls.forEach(function(d, i) {
      d.classList.toggle('active', i === currentIndex);
    });
  }
  
  if (data.showDots !== false && items.length > 1) {
    dots = document.createElement('div');
    dots.className = 'widget-carousel-dots';
    items.forEach(function(_, idx) {
      var dot = document.createElement('button');
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
    case 'buttons':
      // Highlight the selected button
      var buttons = container.querySelectorAll('.widget-btn');
      buttons.forEach(function(btn) {
        if (btn.dataset.value === response.value || 
            (Array.isArray(response.value) && response.value.includes(btn.dataset.value))) {
          btn.classList.add('selected');
        }
      });
      break;
    case 'confirm':
      // Show which option was chosen
      var btns = container.querySelectorAll('.widget-btn');
      btns.forEach(function(btn) {
        if ((response.value && btn.classList.contains('primary')) ||
            (!response.value && btn.classList.contains('secondary'))) {
          btn.classList.add('selected');
        }
      });
      break;
    case 'form':
      // Fill in the form values
      if (response.value && typeof response.value === 'object') {
        Object.keys(response.value).forEach(function(key) {
          var input = container.querySelector('[data-field-name="' + key + '"]');
          if (input) {
            if (input.type === 'checkbox') {
              input.checked = !!response.value[key];
            } else if (input._isRadioGroup) {
              var radio = input.querySelector('input[value="' + response.value[key] + '"]');
              if (radio) radio.checked = true;
            } else {
              input.value = response.value[key] || '';
            }
          }
        });
      }
      break;
    case 'datepicker':
      var dateInput = container.querySelector('.widget-datepicker-input');
      if (dateInput && response.value) {
        dateInput.value = response.value;
      }
      break;
    case 'carousel':
      if (response.value && typeof response.value.index === 'number') {
        var slides = container.querySelectorAll('.widget-carousel-slide');
        if (slides[response.value.index]) {
          slides[response.value.index].style.outline = '3px solid var(--accent)';
        }
      }
      break;
    // code and progress don't need special response handling
  }
}

function updateProgressWidget(container, data) {
  var fill = container.querySelector('.widget-progress-fill');
  if (fill) {
    if (data.percent != null) {
      fill.style.width = data.percent + '%';
      fill.classList.remove('indeterminate');
    } else {
      fill.classList.add('indeterminate');
    }
  }
  
  var label = container.querySelector('.widget-progress-label');
  if (label && data.label) label.textContent = data.label;
  
  var status = container.querySelector('.widget-progress-status');
  if (status && data.status) status.textContent = data.status;
  
  var pct = container.querySelector('.widget-progress-percent');
  if (pct && data.percent != null) pct.textContent = data.percent + '%';
}

function renderFormWidget(container, id, data) {
  if (data.title) {
    var title = document.createElement('div');
    title.className = 'widget-title';
    title.textContent = data.title;
    container.appendChild(title);
  }
  
  var form = document.createElement('div');
  form.className = 'widget-form-fields';
  
  var fields = data.fields || [];
  fields.forEach(function(field) {
    var fieldDiv = document.createElement('div');
    fieldDiv.className = 'widget-form-field';
    
    if (field.label) {
      var label = document.createElement('label');
      label.className = 'widget-form-label';
      label.textContent = field.label;
      if (field.required) {
        var req = document.createElement('span');
        req.className = 'widget-form-required';
        req.textContent = ' *';
        label.appendChild(req);
      }
      fieldDiv.appendChild(label);
    }
    
    var input;
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
          var option = document.createElement('option');
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
      case 'checkbox':
        var checkWrap = document.createElement('div');
        checkWrap.className = 'widget-form-checkbox-wrap';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'widget-form-checkbox';
        var checkLabel = document.createElement('span');
        checkLabel.textContent = field.checkLabel || '';
        checkWrap.appendChild(input);
        checkWrap.appendChild(checkLabel);
        fieldDiv.appendChild(checkWrap);
        input._isCheckbox = true;
        break;
      case 'radio':
        var radioGroup = document.createElement('div');
        radioGroup.className = 'widget-form-radio-group';
        (field.options || []).forEach(function(opt, idx) {
          var radioWrap = document.createElement('label');
          radioWrap.className = 'widget-form-radio-wrap';
          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'field-' + field.name;
          radio.value = typeof opt === 'string' ? opt : opt.value;
          var radioLabel = document.createElement('span');
          radioLabel.textContent = typeof opt === 'string' ? opt : (opt.label || opt.value);
          radioWrap.appendChild(radio);
          radioWrap.appendChild(radioLabel);
          radioGroup.appendChild(radioWrap);
        });
        fieldDiv.appendChild(radioGroup);
        input = radioGroup;
        input._isRadioGroup = true;
        break;
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
  
  var btnGroup = document.createElement('div');
  btnGroup.className = 'widget-btn-group widget-form-buttons';
  
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'widget-btn secondary';
  cancelBtn.textContent = data.cancelLabel || 'Cancel';
  cancelBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    container.classList.add('disabled');
    sendWidgetResponse(id, 'form', null, 'cancel');
  });
  
  var submitBtn = document.createElement('button');
  submitBtn.className = 'widget-btn primary';
  submitBtn.textContent = data.submitLabel || 'Submit';
  submitBtn.addEventListener('click', function() {
    if (container.classList.contains('disabled')) return;
    
    var values = {};
    var valid = true;
    
    fields.forEach(function(field) {
      var el = form.querySelector('[data-field-name="' + field.name + '"]');
      if (!el) return;
      
      if (el._isCheckbox) {
        values[field.name] = el.checked;
      } else if (el._isRadioGroup) {
        var checked = el.querySelector('input:checked');
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
var speechPreviewEl = null;

function showSpeechPreview(text) {
  // Show in messages area as pending bubble (real-time transcript)
  if (!speechPreviewEl) {
    var div = document.createElement('div');
    div.className = 'message user speech-preview';

    var bubble = document.createElement('div');
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
  var welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  var div = document.createElement('div');
  div.className = 'message bot';

  var avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = CFG.botEmoji;

  var typing = document.createElement('div');
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
var e2eKey = null; // CryptoKey for AES-GCM
var e2eReady = false;
var e2ePendingOutbound = [];

async function e2eInit(serverPubKeyB64) {
  try {
    // Generate client ECDH keypair
    var keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveBits']
    );
    // Import server public key (raw format from base64 uncompressed point)
    var serverPubRaw = Uint8Array.from(atob(serverPubKeyB64), function(c) { return c.charCodeAt(0); });
    var serverPubKey = await crypto.subtle.importKey(
      'raw', serverPubRaw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );
    // Derive shared secret bits
    var sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverPubKey },
      keyPair.privateKey, 256
    );
    // HKDF: import shared secret as key material
    var hkdfKey = await crypto.subtle.importKey(
      'raw', sharedBits, 'HKDF', false, ['deriveKey']
    );
    var salt = new TextEncoder().encode('clawtime-e2e-salt');
    var info = new TextEncoder().encode('clawtime-e2e-key');
    e2eKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
    // Export client public key and send to server
    var clientPubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    var clientPubB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(clientPubRaw)));
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
  var chunks = [];
  for (var i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

async function e2eEncrypt(plaintext) {
  if (!e2eKey) return plaintext;
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    e2eKey,
    new TextEncoder().encode(plaintext)
  );
  // AES-GCM output includes tag appended to ciphertext
  var encBytes = new Uint8Array(enc);
  var ciphertext = encBytes.slice(0, encBytes.length - 16);
  var tag = encBytes.slice(encBytes.length - 16);
  return JSON.stringify({
    _e2e: true,
    iv: uint8ToBase64(iv),
    tag: uint8ToBase64(tag),
    data: uint8ToBase64(ciphertext),
  });
}

async function e2eDecrypt(raw) {
  try {
    var msg = JSON.parse(raw);
    if (!msg._e2e || !e2eKey) return raw;
    var iv = Uint8Array.from(atob(msg.iv), function(c) { return c.charCodeAt(0); });
    var tag = Uint8Array.from(atob(msg.tag), function(c) { return c.charCodeAt(0); });
    var data = Uint8Array.from(atob(msg.data), function(c) { return c.charCodeAt(0); });
    // Reassemble ciphertext + tag for Web Crypto (AES-GCM expects them concatenated)
    var combined = new Uint8Array(data.length + tag.length);
    combined.set(data);
    combined.set(tag, data.length);
    var dec = await crypto.subtle.decrypt(
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

async function flushE2ePending() {
  for (var i = 0; i < e2ePendingOutbound.length; i++) {
    ws.send(await e2eEncrypt(e2ePendingOutbound[i]));
  }
  e2ePendingOutbound = [];
}

// ─── WebSocket ───
function connectWs() {
  console.log('[WS] connectWs called, sessionToken:', sessionToken?.slice(0, 8) + '...');
  if (ws) { ws.close(); ws = null; }
  // Reset E2E state on reconnect
  e2eKey = null;
  e2eReady = false;
  e2ePendingOutbound = [];

  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  console.log('[WS] Connecting to', protocol + '//' + location.host);
  ws = new WebSocket(protocol + '//' + location.host);

  // Heartbeat to detect dead connections
  var heartbeatInterval = null;
  var heartbeatTimeout = null;
  var HEARTBEAT_INTERVAL = 30000; // 30 seconds
  var HEARTBEAT_TIMEOUT = 10000;  // 10 seconds to respond
  
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
    console.log('[WS] Connected, sending auth with token:', sessionToken?.slice(0, 8) + '...');
    ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
    startHeartbeat();
  };

  ws.onmessage = async function(e) {
    try {
      // Decrypt if E2E is active, or pass through for handshake messages
      var rawData = e.data;
      var decrypted = rawData;
      try {
        var peek = JSON.parse(rawData);
        if (peek._e2e && e2eKey) {
          decrypted = await e2eDecrypt(rawData);
        }
      } catch(pe) { /* not JSON or not encrypted */ }
      var msg = JSON.parse(decrypted);

      if (msg.type === 'auth_ok') {
        console.log('[WS] auth_ok received, starting E2E');
        setStatus('connecting');
        // Start E2E key exchange if server sent its public key
        if (msg.serverPublicKey) {
          e2eInit(msg.serverPublicKey);
        }
        return;
      }
      
      if (msg.type === 'auth_fail') {
        console.log('[WS] auth_fail received');
        return;
      }

      // E2E key exchange complete
      if (msg.type === 'e2e_ready') {
        console.log('[WS] e2e_ready received, E2E encryption active');
        e2eReady = true;
        // E2E active — no title change (favicon only)
        flushE2ePending();
        // Re-send voice mode state after reconnection
        if (window.callActive) {
          console.log('[Voice] Re-sending voice_mode:true after reconnect');
          secureSend(JSON.stringify({ type: 'voice_mode', enabled: true }));
        }
        return;
      }

      // E2E resource response — set blob URL on all matching images
      if (msg.type === 'resource_data' && msg.url && msg.data) {
        var bytes = atob(msg.data);
        var arr = new Uint8Array(bytes.length);
        for (var ri = 0; ri < bytes.length; ri++) arr[ri] = bytes.charCodeAt(ri);
        var blob = new Blob([arr], { type: msg.mimeType || 'application/octet-stream' });
        var blobUrl = URL.createObjectURL(blob);
        // Cache for future re-renders
        if (!window._e2eBlobCache) window._e2eBlobCache = {};
        window._e2eBlobCache[msg.url] = blobUrl;
        if (window._e2ePendingFetches) delete window._e2ePendingFetches[msg.url];
        // Preserve scroll position when images load
        var prevScrollTop = messagesEl.scrollTop;
        var prevScrollHeight = messagesEl.scrollHeight;
        var wasAtBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 50;
        // Find all img elements waiting for this URL
        var imgs = document.querySelectorAll('img[data-e2e-url="' + msg.url + '"]');
        for (var ii = 0; ii < imgs.length; ii++) {
          imgs[ii].src = blobUrl;
          imgs[ii].removeAttribute('data-e2e-url');
        }
        // After image loads, stabilize scroll
        requestAnimationFrame(function() {
          if (wasAtBottom) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else {
            // Keep scroll position stable — adjust for height change
            var heightDiff = messagesEl.scrollHeight - prevScrollHeight;
            messagesEl.scrollTop = prevScrollTop + heightDiff;
          }
        });
        return;
      }

      // Server-side TTS audio — base64 data through encrypted WS
      if (msg.type === 'tts_audio' && msg.audioData) {
        // Decode base64 directly to ArrayBuffer — skip blob URLs (iOS compat)
        try {
          var audioBytes = atob(msg.audioData);
          var audioArr = new Uint8Array(audioBytes.length);
          for (var ai = 0; ai < audioBytes.length; ai++) audioArr[ai] = audioBytes.charCodeAt(ai);
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
        console.log('[WS] connected received, going online');
        setStatus('online');
        secureSend(JSON.stringify({ type: 'get_history' }));
        // Restore exact avatar state from server
        if (msg.avatarState && window.setAvatarState) {
          // Use original function to avoid re-sending to server
          var origFn = window.setAvatarState._original || window.setAvatarState;
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
        var errorText = msg.data || '';
        addMessage('Error: ' + errorText, 'bot', { timestamp: Date.now() });
        if (window.setAvatarState) {
          if (/rate.?limit|rate_limit|429/i.test(errorText)) {
            setAvatarState('sleeping');
          } else {
            setAvatarState('error');
            setTimeout(function() { setAvatarState('idle'); }, 2000);
          }
        }
        return;
      }

      if (msg.type === 'transcription') {
        hideTyping();
        // Remove transcribing placeholder
        if (window._whisperPlaceholder) {
          try { window._whisperPlaceholder.remove(); } catch(e) {}
          window._whisperPlaceholder = null;
        }
        if (msg.text) {
          addMessage(msg.text, 'user', { timestamp: Date.now() });
          showTyping();
          setCallStatus('thinking');
          if (window.setAvatarState) setAvatarState('thinking');
        } else if (sttActive && callActive) {
          // Empty transcription — restart recording
          startRecordingChunk();
        }
        return;
      }

      if (msg.type === 'stt_error') {
        hideTyping();
        // Remove transcribing placeholder
        if (window._whisperPlaceholder) {
          try { window._whisperPlaceholder.remove(); } catch(e) {}
          window._whisperPlaceholder = null;
        }
        addMessage('🎤 ' + (msg.error || 'Voice transcription failed'), 'bot', { timestamp: Date.now() });
        if (window.setAvatarState) setAvatarState('idle');
        return;
      }

      // ── Re-verify request from bot ──
      if (msg.type === 'reverify_request') {
        (function() {
          var reqId = msg.requestId || '';
          var reason = msg.reason || 'Sensitive operation requested';

          // Show confirmation dialog with context
          var modal = document.createElement('div');
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
        var rawMessages = msg.messages || [];
        
        // Check if we already have messages displayed (reconnect scenario)
        var existingMsgCount = messagesEl.querySelectorAll('.message').length;
        var isReconnect = existingMsgCount > 0;
        
        if (isReconnect) {
          // Reconnect — don't re-render, just update historyMessages for "load more"
          // This preserves any in-flight streaming messages
          historyMessages = [];
          for (var hi = 0; hi < rawMessages.length; hi++) {
            var hm = rawMessages[hi];
            var text = hm.text || (typeof hm.content === 'string' ? hm.content : '');
            if (text.trim()) {
              historyMessages.push({ role: hm.role === 'user' ? 'user' : 'bot', text: text, timestamp: hm.timestamp });
            }
          }
          historyIndex = Math.max(0, historyMessages.length - HISTORY_PAGE_SIZE);
          historyLoaded = true;
          return;
        }
        
        // First load — clear welcome and render history
        historyMessages = [];
        var welcome = messagesEl.querySelector('.welcome');
        if (welcome) welcome.remove();
        botMessagesByRunId.clear();
        hideTyping();
        
        for (var hi = 0; hi < rawMessages.length; hi++) {
          var historyMsg = rawMessages[hi];
          // Store format: { role: 'user'|'bot', text, images?, timestamp }
          // Also handle legacy gateway format (content blocks) for backwards compat
          var role = historyMsg.role === 'user' ? 'user' : 'bot';
          var text = '';
          var images = [];

          // Check for widget in history
          if (historyMsg.widget) {
            historyMessages.push({ role: 'bot', widget: historyMsg.widget, timestamp: historyMsg.timestamp || null });
            continue;
          }

          if (historyMsg.text !== undefined) {
            // New store format — simple text field
            text = historyMsg.text || '';
            images = historyMsg.images || [];
          } else if (Array.isArray(historyMsg.content)) {
            // Legacy gateway format — content blocks
            for (var ci = 0; ci < historyMsg.content.length; ci++) {
              var block = historyMsg.content[ci];
              if (block.type === 'text') {
                text += block.text || '';
              } else if (block.type === 'image' && block.source && block.source.data) {
                images.push('data:' + (block.source.media_type || 'image/jpeg') + ';base64,' + block.source.data);
              }
            }
          } else if (typeof historyMsg.content === 'string') {
            text = historyMsg.content;
          }

          if (text.trim() || images.length > 0) {
            historyMessages.push({ role: role, text: text, timestamp: historyMsg.timestamp || null, images: images });
          }
        }

        historyIndex = Math.max(0, historyMessages.length - HISTORY_PAGE_SIZE);
        var welcome = messagesEl.querySelector('.welcome');
        if (welcome) welcome.remove();

        if (historyMessages.length > HISTORY_PAGE_SIZE) {
          showLoadMoreIndicator();
        }

        for (var i = historyIndex; i < historyMessages.length; i++) {
          var m = historyMessages[i];
          if (m.widget) {
            // Check if widget already rendered (dedup live vs history)
            var existingWidget = document.querySelector('[data-widget-id="' + m.widget.id + '"]');
            if (existingWidget) {
              // Widget exists - but apply response if it has one and widget isn't disabled
              if (m.widget.response && !existingWidget.classList.contains('disabled')) {
                applyWidgetResponse(existingWidget, m.widget.widget, m.widget.data, m.widget.response);
              }
              continue;
            }
            // Render widget from history (pass full widget object, renderWidget handles both formats)
            var widgetEl = renderWidget(m.widget);
            // If already responded, show response state and disable
            if (m.widget.response && widgetEl) {
              applyWidgetResponse(widgetEl, m.widget.widget, m.widget.data, m.widget.response);
            }
          } else if (m.images && m.images.length > 0) {
            addImageMessage(m.text, m.role, m.images[0], { timestamp: m.timestamp, noScroll: true });
          } else {
            addMessage(m.text, m.role, { timestamp: m.timestamp, noScroll: true });
          }
        }

        historyLoaded = true;
        for (var pi = 0; pi < pendingChatEvents.length; pi++) {
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

      // Handle avatar state updates from server (during tool calls)
      if (msg.type === 'avatar_state' && window.setAvatarState) {
        setAvatarState(msg.state);
      }

      // Handle widget messages
      if (msg.type === 'widget') {
        console.log('[Widget] Received widget:', msg);
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
    } catch (err) {
      console.error('[WS] Message processing error:', err);
    }
  };

  ws.onclose = function(e) {
    console.log('[WS] Connection closed, code:', e.code, 'reason:', e.reason);
    stopHeartbeat();
    connected = false;
    
    if (chatUi.classList.contains('active')) {
      setStatus('offline');
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      
      // Don't reconnect if page is hidden (will reconnect on visibility change)
      if (document.visibilityState !== 'visible') {
        console.log('[WS] Page hidden, deferring reconnect');
        return;
      }
      
      // Don't reconnect if offline (will reconnect when online)
      if (!navigator.onLine) {
        console.log('[WS] Offline, deferring reconnect');
        return;
      }
      
      // Exponential backoff with jitter
      var attempts = 0;
      var maxAttempts = 15;
      var baseDelay = 1000;
      var maxDelay = 60000;
      
      function tryReconnect() {
        if (connected) return; // Already reconnected
        if (document.visibilityState !== 'visible') return; // Page hidden
        if (!navigator.onLine) return; // Offline
        
        attempts++;
        // Exponential backoff: 1s, 2s, 4s, 8s... capped at 60s
        var delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
        // Add jitter: ±25% to prevent thundering herd
        var jitter = delay * 0.25 * (Math.random() * 2 - 1);
        delay = Math.round(delay + jitter);
        
        console.log('[WS] Reconnect attempt', attempts + '/' + maxAttempts, 'in', delay + 'ms');
        setStatus('reconnecting');
        
        reconnectTimer = setTimeout(function() {
          reconnectTimer = null;
          if (connected) return;
          
          console.log('[WS] Attempting reconnect...');
          connectWs();
          
          // Check if reconnect succeeded after connection timeout
          setTimeout(function() {
            if (!connected && attempts < maxAttempts) {
              tryReconnect();
            } else if (!connected) {
              console.log('[WS] Max reconnect attempts reached');
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
var lastActiveTime = Date.now();
var visibilityReconnectScheduled = false;

// Track last activity to detect page freeze (iOS/mobile tab sleeping)
setInterval(function() {
  lastActiveTime = Date.now();
}, 5000);

// Detect page freeze: if gap between intervals is too large, page was frozen
function checkPageFreeze() {
  var now = Date.now();
  var gap = now - lastActiveTime;
  if (gap > 8000) { // More than 8s gap = page was frozen (interval is 5s)
    console.log('[WS] Page was frozen for', Math.round(gap / 1000) + 's, checking connection...');
    return true;
  }
  return false;
}

// Handle visibility changes (tab switching, screen off, etc.)
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    console.log('[WS] Page became visible');
    var wasFrozen = checkPageFreeze();
    lastActiveTime = Date.now();
    
    // If we're supposed to be connected but might have lost connection
    if (sessionToken && chatUi.classList.contains('active')) {
      // Check if WebSocket is still healthy
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[WS] Connection dead after visibility change, reconnecting...');
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
        console.log('[WS] Verifying connection after visibility change...');
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
          // Set a timeout - if no pong received, connection is dead
          var healthCheckTimeout = setTimeout(function() {
            console.log('[WS] Health check pong timeout - connection dead, reconnecting...');
            if (ws) ws.close();
            connectWs();
          }, 5000);
          // Store timeout so pong handler can clear it
          ws._healthCheckTimeout = healthCheckTimeout;
        } catch (e) {
          console.log('[WS] Health check failed, reconnecting...');
          connectWs();
        }
      }
    }
  } else {
    console.log('[WS] Page became hidden');
  }
});

// Handle online/offline events
window.addEventListener('online', function() {
  console.log('[WS] Network came online');
  if (sessionToken && chatUi.classList.contains('active') && !connected) {
    console.log('[WS] Reconnecting after coming online...');
    setTimeout(connectWs, 1000);
  }
});

window.addEventListener('offline', function() {
  console.log('[WS] Network went offline');
  setStatus('offline');
});

// Periodic connection health check (catches zombie connections)
setInterval(function() {
  if (sessionToken && chatUi.classList.contains('active') && document.visibilityState === 'visible') {
    if (ws && ws.readyState === WebSocket.OPEN && connected) {
      // All good - connection is healthy
    } else if (!connected && !reconnectTimer && !visibilityReconnectScheduled) {
      // Should be connected but isn't, and no reconnect in progress
      console.log('[WS] Health check: not connected, triggering reconnect');
      connectWs();
    }
  }
}, 60000); // Check every minute

function send() {
  if (pendingAttachments.length > 0) {
    sendWithAttachments();
    return;
  }
  var text = inputEl.value.trim();
  if (!text || !connected) return;

  var msgOpts = { timestamp: Date.now() };
  if (replyTarget) {
    msgOpts.replyTo = { sender: replyTarget.sender, text: replyTarget.text, bubbleEl: replyTarget.bubbleEl };
  }
  addMessage(text, 'user', msgOpts);
  showTyping();
  if (window.setAvatarState) setAvatarState('thinking');

  var sendText = text;
  if (replyTarget) {
    var quoteSender = replyTarget.sender === 'bot' ? CFG.botName : 'You';
    var quoteSnippet = replyTarget.text.length > 150 ? replyTarget.text.slice(0, 150) + '…' : replyTarget.text;
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
var DRAFT_KEY = 'clawtime_draft';

function saveDraft() {
  var text = inputEl.value;
  if (text) {
    localStorage.setItem(DRAFT_KEY, text);
  } else {
    localStorage.removeItem(DRAFT_KEY);
  }
}

function restoreDraft() {
  var draft = localStorage.getItem(DRAFT_KEY);
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
var attachBtn = document.getElementById('attachBtn');
var attachMenu = document.getElementById('attachMenu');
var attachFileBtn = document.getElementById('attachFile');
var attachCameraBtn = document.getElementById('attachCamera');
var fileInput = document.getElementById('fileInput');
var cameraFileInput = document.getElementById('cameraFileInput');
var imagePreview = document.getElementById('imagePreview');
var previewImg = document.getElementById('previewImg');
var previewInfo = document.getElementById('previewInfo');
var previewCancel = document.getElementById('previewCancel');
var dragOverlay = document.getElementById('dragOverlay');
var cameraModal = document.getElementById('cameraModal');
var cameraVideo = document.getElementById('cameraVideo');
var cameraPreviewImg = document.getElementById('cameraPreviewImg');
var cameraControls = document.getElementById('cameraControls');
var cameraReviewControls = document.getElementById('cameraReviewControls');
var camCloseBtn = document.getElementById('camCloseBtn');
var camCaptureBtn = document.getElementById('camCaptureBtn');
var camRetakeBtn = document.getElementById('camRetakeBtn');
var camUseBtn = document.getElementById('camUseBtn');

var cameraStream = null;
var capturedImageBase64 = null;

function processFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result;
      var base64 = dataUrl.split(',')[1];
      var type = file.type || 'application/octet-stream';
      
      // For images, optionally resize large ones
      if (type.startsWith('image/')) {
        var img = new Image();
        img.onload = function() {
          var MAX = 1920;
          var w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else { w = Math.round(w * MAX / h); h = MAX; }
            var canvas = document.createElement('canvas');
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
    var isImage = att.type && att.type.startsWith('image/');
    var preview = isImage 
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
  var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
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
  var files = e.target.files;
  if (!files || files.length === 0) return;
  for (var i = 0; i < files.length; i++) {
    try {
      var result = await processFile(files[i]);
      addAttachment(result);
    } catch (err) { console.error('Failed to process file:', err); }
  }
  fileInput.value = '';
});

previewCancel.addEventListener('click', clearAttachments);

var dragCounter = 0;

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
  var files = e.dataTransfer.files;
  if (!files || files.length === 0) return;
  for (var i = 0; i < files.length; i++) {
    try {
      var result = await processFile(files[i]);
      addAttachment(result);
    } catch (err) { console.error('Failed to process file:', err); }
  }
});

cameraFileInput.addEventListener('change', async function(e) {
  var file = e.target.files[0];
  if (!file) return;
  try {
    var result = await processFile(file);
    addAttachment(result);
  } catch (err) {}
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
  var canvas = document.createElement('canvas');
  canvas.width = cameraVideo.videoWidth;
  canvas.height = cameraVideo.videoHeight;
  canvas.getContext('2d').drawImage(cameraVideo, 0, 0);

  var MAX = 1920;
  var w = canvas.width, h = canvas.height;
  if (w > MAX || h > MAX) {
    var resized = document.createElement('canvas');
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
  var text = inputEl.value.trim();
  var hasAttachments = pendingAttachments.length > 0;
  var hasText = !!text;

  if (!connected || (!hasText && !hasAttachments)) return;

  var msgOpts = { timestamp: Date.now() };
  if (replyTarget) {
    msgOpts.replyTo = { sender: replyTarget.sender, text: replyTarget.text, bubbleEl: replyTarget.bubbleEl };
  }

  // Show user message with attachments
  if (hasAttachments) {
    var firstImage = pendingAttachments.find(function(a) { return a.type && a.type.startsWith('image/'); });
    if (firstImage) {
      addImageMessage(text, 'user', firstImage.dataUrl);
    } else {
      addMessage(text + ' [' + pendingAttachments.length + ' attachment(s)]', 'user', msgOpts);
    }
  } else {
    addMessage(text, 'user', msgOpts);
  }

  showTyping();
  if (window.setAvatarState) setAvatarState('thinking');

  var sendText = text;
  if (replyTarget) {
    var quoteSender = replyTarget.sender === 'bot' ? CFG.botName : 'You';
    var quoteSnippet = replyTarget.text.length > 150 ? replyTarget.text.slice(0, 150) + '…' : replyTarget.text;
    sendText = '> ' + quoteSender + ': ' + quoteSnippet + '\n\n' + text;
  }

  if (hasAttachments) {
    // Send attachments with message
    var attachmentData = pendingAttachments.map(function(a) {
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

function addImageMessage(caption, sender, imageDataUrl, opts) {
  opts = opts || {};
  var welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  var div = document.createElement('div');
  div.className = 'message ' + sender;

  var avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = sender === 'bot' ? CFG.botEmoji : '👤';

  var bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (caption) {
    var textNode = document.createElement('div');
    textNode.textContent = caption;
    bubble.appendChild(textNode);
  }

  var img = document.createElement('img');
  img.className = 'chat-image';
  img.src = imageDataUrl;
  img.alt = 'Shared image';
  img.onclick = function() { window.open(imageDataUrl, '_blank'); };
  bubble.appendChild(img);

  var timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  var ts = opts.timestamp ? new Date(opts.timestamp) : new Date();
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
var fileViewer = document.getElementById('fileViewer');
var fvFrame = document.getElementById('fvFrame');
var fvTitle = document.getElementById('fvTitle');
var fvClose = document.getElementById('fvClose');
var fvDownload = document.getElementById('fvDownload');
var fvCurrentUrl = '';

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
  var a = document.createElement('a');
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
var pttBtn = document.createElement('div'); // dummy element
var pttRecording = false;
var pttCancelled = false;
var pttStartX = 0;
var pttStartY = 0;
var PTT_CANCEL_DIST = 80; // pixels to drag before cancelling
var pttRecognition = null;
var pttBubble = null;
var pttFinalText = '';
var pttLastTranscript = '';

var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var pttMicStream = null; // Keep mic stream alive to persist permission

// ── Adaptive STT: Browser vs Whisper based on noise level ──
// DECISION: Measure ambient noise for ~200ms when PTT starts. If noise RMS
// exceeds threshold, record audio and send to server-side Whisper (more
// accurate in noise). Otherwise, use browser SpeechRecognition (faster,
// real-time feedback). This gives best of both worlds automatically.
var pttUsingWhisper = false;
var pttMediaRecorder = null;
var pttAudioChunks = [];
var pttAudioContext = null;
var pttAnalyser = null;
var PTT_NOISE_THRESHOLD = 1.0; // RMS threshold — set to 1.0 to always use browser Web Speech API (no Whisper)
var PTT_NOISE_SAMPLE_MS = 150; // How long to sample noise before deciding

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
      var source = pttAudioContext.createMediaStreamSource(stream);
      pttAnalyser = pttAudioContext.createAnalyser();
      pttAnalyser.fftSize = 2048;
      source.connect(pttAnalyser);
      
      var samples = [];
      var dataArray = new Float32Array(pttAnalyser.fftSize);
      var sampleInterval = 50; // sample every 50ms
      var elapsed = 0;
      
      var sampler = setInterval(function() {
        pttAnalyser.getFloatTimeDomainData(dataArray);
        // Calculate RMS (root mean square) of the signal
        var sum = 0;
        for (var i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        var rms = Math.sqrt(sum / dataArray.length);
        samples.push(rms);
        elapsed += sampleInterval;
        
        if (elapsed >= durationMs) {
          clearInterval(sampler);
          source.disconnect();
          // Return average RMS across samples
          var avgRms = samples.reduce(function(a, b) { return a + b; }, 0) / samples.length;
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
  var options = { mimeType: 'audio/webm;codecs=opus' };
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
    var interim = '';
    var final = '';
    for (var i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        final += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    pttFinalText = final;
    var display = (final + interim).trim() || '🎤 Listening...';
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
      try { pttRecognition.start(); } catch(e) {}
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
  var welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();
  var div = document.createElement('div');
  div.className = 'message user';
  var avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = '👤';
  var bubble = document.createElement('div');
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
      try { pttRecognition.stop(); } catch(e) {}
      pttRecognition = null;
    }
    if (pttMediaRecorder && pttMediaRecorder.state !== 'inactive') {
      try { pttMediaRecorder.stop(); } catch(e) {}
      pttMediaRecorder = null;
    }
    pttAudioChunks = [];
    if (pttBubble) { pttBubble.div.remove(); pttBubble = null; }
    pttLastTranscript = '';
    pttUsingWhisper = false;
    return;
  }

  var savedBubble = pttBubble;
  pttBubble = null;

  if (pttUsingWhisper) {
    // ── Whisper path: stop recording, send audio to server ──
    if (pttMediaRecorder && pttMediaRecorder.state !== 'inactive') {
      pttMediaRecorder.onstop = function() {
        var blob = new Blob(pttAudioChunks, { type: pttMediaRecorder.mimeType || 'audio/webm' });
        pttAudioChunks = [];
        pttMediaRecorder = null;
        
        if (blob.size < 1000) {
          // Too short, probably just noise
          console.log('PTT: Audio too short, discarding');
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
        var reader = new FileReader();
        reader.onloadend = function() {
          var base64data = reader.result.split(',')[1];
          secureSend(JSON.stringify({ type: 'audio', data: base64data }));
        };
        reader.readAsDataURL(blob);
        
        // Listen for transcription result
        var transcriptionHandler = function(e) {
          try {
            var rawStr = e.data;
            // Decrypt if E2E is active
            if (window._e2eReady && window._e2eDecrypt) {
              rawStr = window._e2eDecrypt(rawStr);
            }
            var msg = JSON.parse(rawStr);
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
          } catch(err) {}
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
      try { pttMediaRecorder.stop(); } catch(e) {}
    } else {
      if (savedBubble) savedBubble.div.remove();
      pttUsingWhisper = false;
    }
  } else {
    // ── Browser recognition path: wait for final result ──
    if (pttRecognition) {
      pttRecognition.onend = null;
      try { pttRecognition.stop(); } catch(e) {}
    }

    // Wait briefly for final result to arrive
    setTimeout(function() {
      pttRecognition = null;
      var text = pttLastTranscript || '';
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
  var dx = pttStartX - clientX; // positive = swiped left
  if (dx > PTT_CANCEL_DIST && pttRecording) {
    // Immediately cancel on swipe
    pttCancelled = true;
    pttStop();
  }
}

// Touch events (mobile)
pttBtn.addEventListener('touchstart', function(e) {
  e.preventDefault();
  var touch = e.touches[0];
  pttStartX = touch.clientX;
  pttStartY = touch.clientY;
  pttCancelled = false;
  pttStart();
}, { passive: false });
document.addEventListener('touchmove', function(e) {
  if (!pttRecording) return;
  var touch = e.touches[0];
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
var avatarPanel = document.getElementById('avatarPanel');
var dragSeparator = document.getElementById('dragSeparator');
var MOBILE_BP = 768;

function isMobileLayout() { return window.innerWidth <= MOBILE_BP; }

function initSeparator() {
  if (!CFG.enableAvatar) return;
  if (isMobileLayout()) {
    var saved = localStorage.getItem('clawtime_avatar_height');
    var h = saved ? parseInt(saved) : 200;
    avatarPanel.style.height = Math.max(80, Math.min(h, window.innerHeight * 0.6)) + 'px';
  } else {
    var saved = localStorage.getItem('clawtime_avatar_width');
    var w = saved ? parseFloat(saved) : 40;
    avatarPanel.style.width = Math.max(20, Math.min(w, 60)) + '%';
  }

  setTimeout(function() {
    if (window.adjustAvatarCamera) window.adjustAvatarCamera();
  }, 100);
}

var sepDragging = false;
var sepStartPos = 0;
var sepStartSize = 0;

function sepStartDrag(e) {
  if (!CFG.enableAvatar) return;
  e.preventDefault();
  sepDragging = true;
  document.body.style.cursor = isMobileLayout() ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
  document.body.style.webkitUserSelect = 'none';

  var pos = e.touches ? e.touches[0] : e;
  sepStartPos = isMobileLayout() ? pos.clientY : pos.clientX;
  sepStartSize = isMobileLayout() ? avatarPanel.offsetHeight : avatarPanel.offsetWidth;

  document.addEventListener('mousemove', sepOnDrag);
  document.addEventListener('mouseup', sepEndDrag);
  document.addEventListener('touchmove', sepOnDrag, { passive: false });
  document.addEventListener('touchend', sepEndDrag);
}

var sepRafPending = false;
function sepOnDrag(e) {
  if (!sepDragging) return;
  e.preventDefault();

  var pos = e.touches ? e.touches[0] : e;
  var current = isMobileLayout() ? pos.clientY : pos.clientX;
  var delta = current - sepStartPos;

  if (isMobileLayout()) {
    var newH = Math.max(80, Math.min(sepStartSize + delta, window.innerHeight * 0.6));
    avatarPanel.style.height = newH + 'px';
    localStorage.setItem('clawtime_avatar_height', Math.round(newH));
  } else {
    var containerW = chatUi.offsetWidth;
    var newW = ((sepStartSize + delta) / containerW) * 100;
    var clamped = Math.max(20, Math.min(newW, 60));
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
var callRecognition = null;
var callPlaying = false;

// Echo detection threshold for barge-in during TTS
var ECHO_CONFIDENCE_THRESHOLD = 0.88; // Balance between barge-in sensitivity and echo rejection

// Check browser support for SpeechRecognition
var SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

// ── Create call overlay UI ──
var callOverlay = document.createElement('div');
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
var callUseWhisper = false; // Browser STT by default (set true for server-side Whisper)

// Element references for avatar panel interactions
var avatarPanelEl = document.getElementById('avatarPanel');
var chatMainEl = document.querySelector('.chat-main');
var dragSeparatorEl = document.getElementById('dragSeparator');

// Append overlay to avatar panel (positioned at bottom)
if (avatarPanelEl) avatarPanelEl.appendChild(callOverlay);

// ── Call button (overlaid on avatar) ──
// Call button removed — voice mode uses the 🔊 button in avatar-buttons

// ── Start call ──
// Web Audio API — unlocked on user gesture, used for TTS playback
var audioCtx = null;

function unlockAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  // Play silent buffer to fully unlock
  var buf = audioCtx.createBuffer(1, 1, 22050);
  var src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start(0);
}

var activeTTSSource = null;
var activeTTSRunId = null; // Track which runId is currently being spoken

function playTTSAudio(data, onDone) {
  // data can be an ArrayBuffer (from E2E WS) or a URL string (legacy)
  // Stop any currently playing
  if (activeTTSSource) {
    try { activeTTSSource.stop(); } catch(e) {}
    activeTTSSource = null;
  }
  if (window._ttsAudioEl) {
    window._ttsAudioEl.pause();
    window._ttsAudioEl = null;
  }

  var isBuffer = data instanceof ArrayBuffer;

  // Ensure AudioContext exists
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(function() {});
  }

  if (audioCtx && isBuffer) {
    // Direct ArrayBuffer → decodeAudioData (no fetch needed, iOS-safe)
    audioCtx.decodeAudioData(data.slice(0), function(buffer) {
      var source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      activeTTSSource = source;
      source.onended = function() { activeTTSSource = null; if (onDone) onDone(); };
      source.start(0);
    }, function(err) {
      console.error('[TTS] decode failed:', err);
      // Fallback: create blob URL and use Audio element
      var blob = new Blob([new Uint8Array(data)], { type: 'audio/mpeg' });
      playTTSFallback(URL.createObjectURL(blob), onDone);
    });
  } else if (audioCtx && audioCtx.state === 'running' && !isBuffer) {
    fetch(data)
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(ab) { return audioCtx.decodeAudioData(ab); })
      .then(function(buffer) {
        var source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        activeTTSSource = source;
        source.onended = function() { activeTTSSource = null; if (onDone) onDone(); };
        source.start(0);
      })
      .catch(function() { playTTSFallback(data, onDone); });
  } else if (isBuffer) {
    // No AudioContext — fallback with blob URL
    var blob = new Blob([new Uint8Array(data)], { type: 'audio/mpeg' });
    playTTSFallback(URL.createObjectURL(blob), onDone);
  } else {
    playTTSFallback(data, onDone);
  }
}

function playTTSFallback(url, onDone) {
  var audio = new Audio(url);
  window._ttsAudioEl = audio;
  audio.onended = function() { window._ttsAudioEl = null; if (onDone) onDone(); };
  audio.onerror = function() { window._ttsAudioEl = null; if (onDone) onDone(); };
  audio.play().catch(function() { window._ttsAudioEl = null; if (onDone) onDone(); });
}

// ─── Server-side STT fallback (MediaRecorder) ───
var mediaRecorder = null;
var mediaStream = null;
var recordingChunks = [];
var analyserNode = null;
var sttActive = false;

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
    var source = audioCtx.createMediaStreamSource(stream);
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
  if (!sttActive || !mediaStream || !callActive) return;
  recordingChunks = [];
  var mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
                 MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' :
                 MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType: mimeType } : {});
  mediaRecorder.ondataavailable = function(e) {
    if (e.data.size > 0) recordingChunks.push(e.data);
  };
  mediaRecorder.onstop = function() {
    if (recordingChunks.length === 0 || !callActive) return;
    // Discard audio if TTS was playing (avoid echo) — but barge-in already stopped TTS
    if (callPlaying) {
      if (sttActive && callActive) setTimeout(startRecordingChunk, 300);
      return;
    }
    var blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (blob.size < 500) {
      // Too small — restart
      if (sttActive && callActive) setTimeout(startRecordingChunk, 300);
      return;
    }
    setCallStatus('transcribing');
    // Update placeholder to show transcribing
    if (window._whisperPlaceholder) {
      var bubble = window._whisperPlaceholder.querySelector('.msg-bubble');
      if (bubble) bubble.textContent = '⏳ Transcribing...';
    } else {
      window._whisperPlaceholder = addMessage('⏳ Transcribing...', 'user', { timestamp: Date.now(), placeholder: true });
    }
    var reader = new FileReader();
    reader.onload = function() {
      var b64 = reader.result.split(',')[1];
      secureSend(JSON.stringify({ type: 'audio', data: b64 }));
      // Restart recording for next utterance
      if (sttActive && callActive && !callPlaying) {
        setTimeout(startRecordingChunk, 300);
      }
    };
    reader.readAsDataURL(blob);
  };

  // Record in chunks with voice activity detection
  mediaRecorder.start();
  setCallStatus('listening');

  // Use simple energy-based VAD
  var dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  var speechStarted = false;
  var silenceCount = 0;
  var totalFrames = 0;

  var vadInterval = setInterval(function() {
    if (!sttActive || !callActive || !mediaRecorder || mediaRecorder.state !== 'recording') {
      clearInterval(vadInterval);
      return;
    }
    totalFrames++;
    analyserNode.getByteTimeDomainData(dataArray);

    // Calculate RMS energy
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) {
      var val = (dataArray[i] - 128) / 128;
      sum += val * val;
    }
    var rms = Math.sqrt(sum / dataArray.length);

    if (rms > 0.07) { // Balanced: responsive but filters noise
      // Barge-in: stop TTS if user starts speaking
      if (callPlaying && !speechStarted) {
        console.log('[VAD] Barge-in detected, stopping TTS');
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
      try { mediaRecorder.stop(); } catch(e) {}
      return;
    }

    // Max 10s recording
    if (totalFrames > 100) {
      clearInterval(vadInterval);
      if (speechStarted) {
        try { mediaRecorder.stop(); } catch(e) {}
      } else {
        // No speech detected in 10s — restart
        try { mediaRecorder.stop(); } catch(e) {}
      }
    }
  }, 100);
}

function stopMediaRecorderSTT() {
  sttActive = false;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch(e) {}
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
  var micReady = micPermissionGranted
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
    console.log('[Voice] Sending voice_mode:true to server');
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
  var statusEl = document.getElementById('callStatus');
  var waveform = document.getElementById('callWaveform');
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
var CALL_CONFIDENCE_THRESHOLD = 0.5; // Lowered to accept more barge-in speech
var CALL_MIN_LENGTH = 2;
// Common noise / filler transcriptions to discard
var CALL_NOISE_WORDS = /^(um+|uh+|hm+|hmm+|ah+|oh+|er+|huh+|mhm+|mm+|shh+|tsk|psst|ha(ha)*|he(he)*|ho(ho)*)$/i;
// Single repeated letter like "aaa", "sss"
var CALL_REPEATED_LETTER = /^(.)\1*$/;

/**
 * Returns true if the transcript should be discarded as noise.
 * Checks: empty, too short, low confidence, filler words, repeated letters.
 */
function isNoisyTranscript(text, confidence) {
  if (!text) return true;
  var t = text.trim();
  if (t.length < CALL_MIN_LENGTH) return true;
  if (typeof confidence === 'number' && confidence < CALL_CONFIDENCE_THRESHOLD) return true;
  if (CALL_NOISE_WORDS.test(t)) return true;
  if (t.length <= 4 && CALL_REPEATED_LETTER.test(t)) return true;
  return false;
}

// ── Speech Recognition ──
var micPermissionGranted = false;
var _sttRestartTimer = null;
var _sttStarting = false;
var _sttBargeInActive = false;
var _sttErrorHandled = false;

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
  var _bargeInBuffer = '';
  
  callRecognition.onresult = function(event) {
    if (!callActive) return;
    
    // If TTS is playing, buffer high-confidence speech for after barge-in
    if (callPlaying) {
      for (var k = event.resultIndex; k < event.results.length; k++) {
        if (event.results[k][0].confidence > 0.75) {
          _bargeInBuffer = event.results[k][0].transcript;
        }
      }
      return;
    }
    
    // After barge-in, prepend buffered speech if any
    var bargeInPrefix = '';
    if (_bargeInBuffer) {
      console.log('[Barge-in] Using buffered speech:', _bargeInBuffer);
      bargeInPrefix = _bargeInBuffer;
      _bargeInBuffer = '';
    }
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var transcript = event.results[i][0].transcript;
      var confidence = event.results[i][0].confidence;

      if (event.results[i].isFinal) {
        if (isNoisyTranscript(transcript, confidence)) {
          console.log('[STT] Filtered as noisy:', transcript, 'conf:', confidence);
          hideSpeechPreview();
          continue;
        }
        // Include any buffered barge-in speech
        var text = (bargeInPrefix ? bargeInPrefix + ' ' : '') + transcript.trim();
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
      console.log('[STT] Interim:', interim);
      showSpeechPreview(interim);
    } else {
      hideSpeechPreview();
    }
  };

  callRecognition.onerror = function(event) {
    _sttStarting = false;
    if (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network') {
      _sttErrorHandled = true;
      if (callActive && !callPlaying) {
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
      if (callActive && !callPlaying) {
        scheduleRecognitionRestart(300);
      }
      return;
    }
    if (callActive && !callPlaying) {
      scheduleRecognitionRestart(800);
    }
  };
}

// ── VAD for barge-in during browser STT ──
var bargeInVADInterval = null;
var bargeInStream = null;
var bargeInAnalyser = null;

function startBargeInVAD() {
  if (bargeInVADInterval) return; // Already running
  console.log('[VAD] Starting barge-in VAD monitor');
  
  navigator.mediaDevices.getUserMedia({ 
    audio: { echoCancellation: true, noiseSuppression: true }
  }).then(function(stream) {
    bargeInStream = stream;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var source = audioCtx.createMediaStreamSource(stream);
    bargeInAnalyser = audioCtx.createAnalyser();
    bargeInAnalyser.fftSize = 512;
    source.connect(bargeInAnalyser);
    
    var dataArray = new Uint8Array(bargeInAnalyser.fftSize);
    
    bargeInVADInterval = setInterval(function() {
      if (!callActive) { stopBargeInVAD(); return; }
      if (!callPlaying) return; // Only check during TTS playback
      
      bargeInAnalyser.getByteTimeDomainData(dataArray);
      var sum = 0;
      for (var i = 0; i < dataArray.length; i++) {
        var val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      var rms = Math.sqrt(sum / dataArray.length);
      
      // Log all RMS values during TTS for debugging
      if (rms > 0.05) {
        console.log('[VAD] RMS:', rms.toFixed(3), 'playing:', callPlaying);
      }
      // Lower threshold for barge-in
      if (rms > 0.08) {
        console.log('[VAD Barge-in] Triggered! RMS:', rms.toFixed(3));
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
          } catch(e) {}
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
  if (!SpeechRecognitionAPI || !callActive) return;
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
      try { callRecognition.abort(); } catch (e2) {}
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
    try { callRecognition.abort(); } catch (e) {}
    callRecognition = null; // destroy on full stop (endCall)
  }
}

// ── Browser TTS (speechSynthesis) ──
var synth = window.speechSynthesis;

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
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(function() {});
  }
  var queue = window._ttsQueue || [];
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
        console.log('[Barge-in] Restarted recognition during TTS');
      }
    } catch(e) {
      console.log('[Barge-in] Recognition already running:', e.message);
    }
  }
  if (window.setAvatarState) setAvatarState('talking');
  setCallStatus('speaking');
  var url = queue.shift();
  playTTSAudio(url, function() {
    // Play next chunk or finish
    playNextTTSChunk();
  });
}

function stopCallAudio() {
  if (synth) synth.cancel();
  if (activeTTSSource) {
    try { activeTTSSource.onended = null; activeTTSSource.stop(); } catch(e) {}
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
// Tap avatar panel to start call (but not when clicking buttons)
if (avatarPanelEl) {
  avatarPanelEl.addEventListener('click', function(e) {
    if (e.target.closest('.avatar-buttons') || e.target.closest('.avatar-action-btn') ||
        e.target.closest('#callEndBtn') || e.target.closest('#callOverlay') ||
        e.target.closest('.avatar-menu')) return;
    if (callActive) { endCall(); } else { startCall(); }
  });
}

// Voice toggle in input area (if present) — toggles server TTS replies
var voiceToggle = document.getElementById('voiceToggle');
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

var callEndBtnEl = document.getElementById('callEndBtn');
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
  var taskBtn = document.getElementById('taskBtn');
  var taskBtnHeader = document.getElementById('taskBtnHeader');
  var taskPanel = document.getElementById('taskPanel');
  var taskList = document.getElementById('taskList');
  var taskCancel = document.getElementById('taskCancel');
  var taskClose = document.getElementById('taskPanelClose');
  var taskBadgeHeader = document.getElementById('taskBadgeHeader');
  var rawLines = [];

  function parseTasks(content) {
    rawLines = content.split('\n');
    var sections = [];
    var currentSection = { title: '', items: [] };
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i].trim();
      if (line.startsWith('## ') && line !== '## Priority Guide') {
        if (currentSection.title || currentSection.items.length) sections.push(currentSection);
        currentSection = { title: line.replace('## ', ''), items: [] };
      } else if (line.startsWith('- ')) {
        var text = line.slice(2);
        var done = text.startsWith('[x] ') || text.startsWith('✅');
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
        var h = document.createElement('div');
        h.className = 'task-section-title';
        h.textContent = section.title;
        taskList.appendChild(h);
      }
      if (section.items.length === 0 && section.title) {
        var empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-dim);font-size:13px;padding:6px 12px;';
        empty.textContent = 'No tasks';
        taskList.appendChild(empty);
      }
      section.items.forEach(function(item) {
        var row = document.createElement('div');
        row.className = 'task-item';
        var txt = document.createElement('span');
        txt.className = 'task-text' + (item.done ? ' done' : '');
        txt.textContent = item.text.replace(/^\[x\] /, '').replace(/^\[ \] /, '');
        var rm = document.createElement('button');
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
    var addRow = document.createElement('div');
    addRow.className = 'task-add-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a task...';
    input.id = 'taskAddInput';
    var addBtn = document.createElement('button');
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
    var insertAt = -1;
    for (var i = 0; i < rawLines.length; i++) {
      if (rawLines[i].trim() === '## Active') { insertAt = i + 1; break; }
    }
    if (insertAt === -1) {
      // Find first ## section with items
      for (var j = 0; j < rawLines.length; j++) {
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
    var content = rawLines.join('\n');
    fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + sessionToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: content })
    }).then(function() {
      var sections = parseTasks(content);
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
      var sections = parseTasks(data.content || '');
      renderTasks(sections);
      updateBadge(data.content);
    })
    .catch(function() {
      taskList.innerHTML = '<div style="padding:20px;color:#e53935">Error loading tasks</div>';
    });
  }

  function closeTasks() { taskPanel.classList.remove('active'); }

  function updateBadge(content) {
    var badge = document.getElementById('taskBadge');
    var badgeHeader = document.getElementById('taskBadgeHeader');
    var lines = (content || '').split('\n');
    var count = 0;
    var inDone = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
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
  var menuBtn = document.getElementById('menuBtn');
  var avatarMenu = document.getElementById('avatarMenu');
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
  var passkeysBtn = document.getElementById('passkeysBtn');
  var passkeysModal = document.getElementById('passkeysModal');
  var passkeysList = document.getElementById('passkeysList');
  var addPasskeyBtn = document.getElementById('addPasskeyBtn');
  var passkeysClose = document.getElementById('passkeysClose');

  function loadPasskeys() {
    fetch('/auth/passkeys', {
      headers: { 'Authorization': 'Bearer ' + sessionToken }
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.passkeys) return;
      passkeysList.innerHTML = '';
      data.passkeys.forEach(function(pk) {
        var div = document.createElement('div');
        div.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:var(--surface2); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;';
        var info = document.createElement('div');
        var transports = (pk.transports || []).join(', ') || 'unknown';
        var date = pk.createdAt ? new Date(pk.createdAt).toLocaleDateString() : 'unknown';
        info.innerHTML = '<div style="font-size:14px; font-weight:600;">' +
          (pk.deviceType === 'multiDevice' ? '☁️' : '💻') + ' ' +
          (pk.deviceType === 'multiDevice' ? 'Synced' : 'Device-bound') +
          (pk.backedUp ? ' ✓' : '') + '</div>' +
          '<div style="font-size:12px; color:var(--text-dim);">' + transports + ' · ' + date + '</div>';
        div.appendChild(info);
        if (data.passkeys.length > 1) {
          var del = document.createElement('button');
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
  var voiceTipBtn = document.getElementById('voiceTipBtn');
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
  var copyUrlBtn = document.getElementById('copyUrlBtn');
  if (copyUrlBtn) {
    copyUrlBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var cleanUrl = window.location.origin + window.location.pathname;
      navigator.clipboard.writeText(cleanUrl).then(function() {
        copyUrlBtn.innerHTML = copyUrlBtn.innerHTML.replace('Copy App URL', 'Copied!');
        setTimeout(function() {
          copyUrlBtn.innerHTML = copyUrlBtn.innerHTML.replace('Copied!', 'Copy App URL');
        }, 1500);
      }).catch(function() {
        // Fallback for older browsers
        var input = document.createElement('input');
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
  var logoutBtn = document.getElementById('logoutBtn');
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
        var optRes = await fetch('/auth/register-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        var optData = await optRes.json();
        if (!optData.options) throw new Error('No options from server: ' + JSON.stringify(optData));
        var cred = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: optData.options });
        var verRes = await fetch('/auth/register-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challengeId: optData.challengeId, response: cred })
        });
        var verData = await verRes.json();
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
  var avatarManagerBtn = document.getElementById('avatarManagerBtn');
  var avatarManagerModal = document.getElementById('avatarManagerModal');
  var avatarList = document.getElementById('avatarList');
  var selectAvatarBtn = document.getElementById('selectAvatarBtn');
  var deleteAvatarBtn = document.getElementById('deleteAvatarBtn');
  var avatarManagerClose = document.getElementById('avatarManagerClose');

  var availableAvatars = [];  // Populated from server via /api/avatar/list
  
  // Fetch avatar list from server (includes cloud only if file exists)
  function refreshAvatarList() {
    return fetch('/api/avatar/list').then(function(r) { return r.json(); }).then(function(data) {
      if (data.avatars) availableAvatars = data.avatars;
    }).catch(function() {});
  }
  refreshAvatarList();
  // Prefer server's avatar selection (from pre-fetch), fall back to localStorage
  var currentAvatar = (window.CLAWTIME_THEME && window.CLAWTIME_THEME.id) || localStorage.getItem('selectedAvatar');
  var previewingAvatar = null;
  var previewAnimationId = null;

  function getAvatarData(id) {
    var found = availableAvatars.find(function(a) { return a.id === id; }) || availableAvatars[0];
    return found || { id: id || 'unknown', emoji: '🎭', color: 'f97316', name: 'Loading...' };
  }

  // Apply avatar theme (emoji + color)
  function applyAvatarTheme(avatarId) {
    var av = getAvatarData(avatarId);
    console.log('[Theme] Applying:', avatarId, av.emoji, av.color);
    
    // Update favicon emoji (remove+create to defeat caching)
    var oldLink = document.querySelector('link[rel="icon"]');
    if (oldLink) oldLink.remove();
    var newLink = document.createElement('link');
    newLink.rel = 'icon';
    newLink.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>" + encodeURIComponent(av.emoji) + "</text></svg>";
    document.head.appendChild(newLink);
    
    // Update theme accent color
    document.documentElement.style.setProperty('--accent', '#' + av.color);
    
    // Update auth screen emoji if visible
    var authEmoji = document.getElementById('authEmoji');
    if (authEmoji) authEmoji.textContent = av.emoji;
    
    // Update welcome emoji in chat panel
    var welcomeEmoji = document.getElementById('welcomeEmoji');
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
      console.log('[Avatar] Loading:', avatarId);
      
      // Clear existing avatar scene completely
      var canvas = document.getElementById('avatarCanvas');
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
      var script = document.createElement('script');
      script.src = '/avatar.js?avatar=' + avatarId + '&t=' + Date.now();
      script.onload = function() {
        console.log('[Avatar] Script loaded, initializing...');
        // Give browser time to parse and execute
        setTimeout(function() {
          if (window.initAvatarScene) {
            window.initAvatarScene();
            console.log('[Avatar] Initialized:', avatarId);
            // Wrap setAvatarState to sync with server
            if (window.setAvatarState) {
              var originalSetState = window.setAvatarState;
              window.setAvatarState = function(state) {
                originalSetState(state);
                // Notify server of state change (for reconnect accuracy)
                if (window.secureSend) {
                  try { secureSend(JSON.stringify({ type: 'avatar_state', state: state })); } catch(e) {}
                }
              };
              window.setAvatarState._original = originalSetState;
            }
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
    var states = ['idle', 'thinking', 'talking', 'happy', 'working', 'sleeping', 'error'];
    var i = 0;
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
    var av = getAvatarData(previewingAvatar);
    if (selectAvatarBtn) {
      selectAvatarBtn.style.display = (previewingAvatar !== currentAvatar) ? 'inline-block' : 'none';
    }
    if (deleteAvatarBtn) {
      deleteAvatarBtn.style.display = (av.custom && previewingAvatar !== currentAvatar) ? 'inline-block' : 'none';
    }
  }

  function renderAvatarList() {
    if (!avatarList) return;
    avatarList.innerHTML = '';
    availableAvatars.forEach(function(av) {
      var isSelected = currentAvatar === av.id;
      var isPreviewing = previewingAvatar === av.id;
      var card = document.createElement('div');
      card.className = 'avatar-card' + (isSelected ? ' selected' : '') + (isPreviewing ? ' previewing' : '');
      
      var html = '<div class="avatar-card-emoji">' + av.emoji + '</div>' +
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
      var av = getAvatarData(previewingAvatar);
      if (!av.custom) return;
      if (!confirm('Delete "' + av.name + '" avatar?')) return;
      fetch('/api/avatar/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: previewingAvatar })
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) {
          var deletedAvatar = previewingAvatar;
          var wasCurrentAvatar = (deletedAvatar === currentAvatar);
          
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
})();

// ─── Start ───
init();

// ─── Service Worker Registration ───
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function(){});
}
