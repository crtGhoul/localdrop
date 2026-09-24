'use strict';
/* LocalDrop — LocalSend-style sharing for the web.
   Manual-signaling WebRTC: no server, no account. Open this page on two devices. */

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function linkify(s) {
  // Note: the match `u` comes from the already-escaped string, so it is safe
  // to use verbatim in both the href and the link text (no double-escaping).
  return esc(s).replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (u) => {
    const href = /^https?:\/\//i.test(u) ? u : 'https://' + u;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + u + '</a>';
  });
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
  } else {
    fallbackCopy(t);
  }
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* noop */ }
  ta.remove();
}

/* ---------- signaling codec (SDP <-> short text code) ---------- */
function encodeSDP(desc) {
  const json = JSON.stringify({ t: desc.type, s: desc.sdp });
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeSDP(code) {
  let b64 = code.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
  return { type: o.t, sdp: o.s };
}

/* Validate a pasted code: right shape AND right kind (offer vs answer). */
function parseCode(code, wantType) {
  let d;
  try { d = decodeSDP(code); } catch (e) { return { error: 'unreadable' }; }
  if (!d || d.type !== wantType || typeof d.sdp !== 'string' || d.sdp.slice(0, 3) !== 'v=0')
    return { error: 'wrong-kind' };
  return { desc: d };
}

/* If the connection isn't up within `ms`, say so plainly instead of
   hanging on "connecting…" forever. */
let connectTimer = null;
function watchConnect(ms) {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    const open = dc && dc.readyState === 'open';
    if (!open && pc && pc.connectionState !== 'connected') {
      setStatus('bad', "couldn't connect");
      alert("Couldn't establish the connection.\n\n" +
        "• Keep both devices on the same Wi-Fi\n" +
        "• Codes are single-use: go back and generate fresh codes\n" +
        "• Make sure the FULL code was copied (they're long)");
    }
  }, ms);
}

/* ---------- views ---------- */
const VIEWS = ['home', 'host', 'join', 'chat'];
function go(name) {
  VIEWS.forEach((v) => $('view-' + v).classList.toggle('hidden', v !== name));
  window.scrollTo(0, 0);
}

/* ---------- webrtc state ---------- */
const RTC_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    // Fallback TURN (Open Relay Project — free public relay) for networks
    // where a direct peer-to-peer path can't be established. The data
    // channel stays end-to-end encrypted; the relay can't read it.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};
let pc = null;
let dc = null;
let incoming = null;          // file currently being received
const sendQueue = [];
let sending = false;

function setStatus(state, text) {
  $('status').className = 'status ' + state;
  $('statusText').textContent = text;
}

function teardown() {
  try { if (dc) dc.close(); } catch (e) { /* noop */ }
  try { if (pc) pc.close(); } catch (e) { /* noop */ }
  dc = null; pc = null; incoming = null;
  clearTimeout(connectTimer);
  sendQueue.length = 0; sending = false;
  setStatus('idle', 'not connected');
}

function newPC() {
  teardown();
  pc = new RTCPeerConnection(RTC_CFG);
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') setStatus('ok', 'connected');
    else if (s === 'failed') setStatus('bad', 'connection failed — try fresh codes');
    else if (s === 'disconnected' || s === 'closed') setStatus('bad', 'disconnected');
    else setStatus('idle', 'connecting…');
  };
  pc.ondatachannel = (e) => { dc = e.channel; wireDC(); };
}

function waitGathering() {
  return new Promise((res) => {
    if (!pc || pc.iceGatheringState === 'complete') return res();
    const to = setTimeout(res, 6000);
    const h = () => {
      if (pc && pc.iceGatheringState === 'complete') {
        clearTimeout(to);
        pc.removeEventListener('icegatheringstatechange', h);
        res();
      }
    };
    pc.addEventListener('icegatheringstatechange', h);
  });
}

/* ---------- host flow ---------- */
async function hostStart() {
  newPC();
  $('hostCode').value = '';
  $('hostAnswer').value = '';
  $('qr').innerHTML = '';
  dc = pc.createDataChannel('localdrop', { ordered: true });
  wireDC();
  setStatus('idle', 'generating code…');
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitGathering();
    const code = encodeSDP(pc.localDescription);
    $('hostCode').value = code;
    renderQR(code);
    setStatus('idle', 'waiting for partner…');
  } catch (err) {
    setStatus('bad', 'failed to start');
  }
}

function renderQR(text) {
  const el = $('qr');
  el.innerHTML = '';
  try {
    new QRCode(el, { text, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  } catch (e) {
    el.innerHTML = '<p class="hint">Code is too long for a QR — copy it instead.</p>';
  }
}

$('btnConnect').addEventListener('click', async () => {
  const code = $('hostAnswer').value.trim();
  if (!code || !pc) return;
  const parsed = parseCode(code, 'answer');
  if (parsed.error) {
    alert("That doesn't look like a reply code.\n\nCopy the FULL reply code from the other device's Receive screen (tap its Copy button) and paste it here.");
    return;
  }
  try {
    await pc.setRemoteDescription(parsed.desc);
    setStatus('idle', 'connecting…');
    watchConnect(20000);
  } catch (e) {
    alert("That reply code didn't work — double-check it and try again.");
  }
});

/* ---------- join flow ---------- */
$('btnMakeReply').addEventListener('click', async () => {
  const code = $('joinCode').value.trim();
  if (!code) return;
  const parsed = parseCode(code, 'offer');
  if (parsed.error) {
    setStatus('bad', 'bad code');
    alert("That doesn't look like a LocalDrop share code.\n\n• Open LocalDrop on the other device and tap Share\n• Copy the FULL share code (tap its Copy button) or scan its QR\n• Paste it here and try again");
    return;
  }
  newPC();
  setStatus('idle', 'generating reply…');
  try {
    await pc.setRemoteDescription(parsed.desc);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitGathering();
    $('joinReply').value = encodeSDP(pc.localDescription);
    $('replyWrap').classList.remove('hidden');
    setStatus('idle', 'waiting for host…');
  } catch (e) {
    setStatus('bad', 'bad code');
    alert("That code didn't work — double-check it and try again.");
  }
});

/* ---------- data channel ---------- */
function wireDC() {
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    clearTimeout(connectTimer);
    $('messages').innerHTML = '';
    go('chat');
    setStatus('ok', 'connected');
    sysMsg('Connected 🔗 — send photos, files, text or links.');
  };
  dc.onmessage = onData;
  dc.onclose = () => {
    setStatus('bad', 'disconnected');
    sysMsg('Partner disconnected.');
  };
}

function onData(e) {
  if (typeof e.data === 'string') {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.t === 'msg') addText(false, m.text);
    else if (m.t === 'file-meta') {
      incoming = { meta: m, parts: [], got: 0, el: fileCard(false, m.name, m.size) };
    } else if (m.t === 'file-end' && incoming && incoming.meta.id === m.id) {
      finishFile();
    }
  } else if (incoming) {
    incoming.parts.push(e.data);
    incoming.got += e.data.byteLength;
    setProg(incoming.el, incoming.got / incoming.meta.size);
  }
}

/* ---------- chat UI ---------- */
function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}
function sysMsg(t) {
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = t;
  $('messages').appendChild(d);
  scrollDown();
}
function timeNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function addText(mine, text) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (mine ? 'mine' : 'theirs');
  d.innerHTML = '<div class="text">' + linkify(text) + '</div><div class="meta">' + timeNow() + '</div>';
  $('messages').appendChild(d);
  scrollDown();
}
function fileCard(mine, name, size) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (mine ? 'mine' : 'theirs');
  d.innerHTML =
    '<div class="fbody"><div class="fname">' + esc(name) + '</div>' +
    '<div class="fsize">' + fmtSize(size) + '</div>' +
    '<div class="track"><div class="bar"></div></div></div>';
  $('messages').appendChild(d);
  scrollDown();
  return d;
}
function setProg(el, p) {
  el.querySelector('.bar').style.width = Math.min(100, p * 100) + '%';
}
function finishFile() {
  const cur = incoming;
  incoming = null;
  const blob = new Blob(cur.parts, { type: cur.meta.mime });
  const url = URL.createObjectURL(blob);
  setProg(cur.el, 1);
  const body = cur.el.querySelector('.fbody');
  if (cur.meta.mime.indexOf('image/') === 0) {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'preview';
    img.loading = 'lazy';
    img.alt = cur.meta.name;
    body.appendChild(img);
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = cur.meta.name;
  a.className = 'dl';
  a.textContent = '⬇ Download';
  body.appendChild(a);
  scrollDown();
}

/* ---------- sending ---------- */
function sendText() {
  const inp = $('textInput');
  const t = inp.value.trim();
  if (!t || !dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify({ t: 'msg', text: t, ts: Date.now() }));
  addText(true, t);
  inp.value = '';
}

function enqueueFile(file) {
  if (!file) return;
  sendQueue.push(file);
  pumpQueue();
}

async function pumpQueue() {
  if (sending || !sendQueue.length) return;
  if (!dc || dc.readyState !== 'open') return;
  sending = true;
  const file = sendQueue.shift();
  const id = uid();
  const el = fileCard(true, file.name, file.size);
  try {
    dc.send(JSON.stringify({
      t: 'file-meta', id,
      name: file.name, size: file.size,
      mime: file.type || 'application/octet-stream',
    }));
    const CHUNK = 16384;
    let off = 0;
    while (off < file.size) {
      while (dc.bufferedAmount > 512 * 1024) await sleep(60);
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      dc.send(buf);
      off += buf.byteLength;
      setProg(el, off / file.size);
    }
    dc.send(JSON.stringify({ t: 'file-end', id }));
    setProg(el, 1);
  } catch (err) {
    el.querySelector('.fname').textContent += ' — failed';
  }
  sending = false;
  pumpQueue();
}

/* ---------- wiring ---------- */
$('btnHost').addEventListener('click', () => { go('host'); hostStart(); });
$('btnJoin').addEventListener('click', () => {
  $('replyWrap').classList.add('hidden');
  $('joinCode').value = '';
  $('joinReply').value = '';
  go('join');
});
document.querySelectorAll('[data-go]').forEach((b) =>
  b.addEventListener('click', () => { teardown(); go(b.getAttribute('data-go')); })
);
$('copyHost').addEventListener('click', () => copyText($('hostCode').value));
$('copyJoin').addEventListener('click', () => copyText($('joinReply').value));
$('hostCode').addEventListener('focus', function () { this.select(); });
$('joinReply').addEventListener('focus', function () { this.select(); });
$('btnSend').addEventListener('click', sendText);
$('textInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
$('fileInput').addEventListener('change', (e) => {
  Array.from(e.target.files).forEach(enqueueFile);
  e.target.value = '';
});
document.addEventListener('paste', (e) => {
  if ($('view-chat').classList.contains('hidden')) return;
  const files = (e.clipboardData && e.clipboardData.files) || [];
  Array.from(files).forEach(enqueueFile);
});

/* ---------- PWA: service worker + install prompt ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').classList.remove('hidden');
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch (err) { /* noop */ }
  deferredPrompt = null;
  $('installBtn').classList.add('hidden');
});
(function showIOSHint() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  if (isIOS && !window.navigator.standalone) {
    $('iosHint').classList.remove('hidden');
  }
})();

setStatus('idle', 'not connected');
