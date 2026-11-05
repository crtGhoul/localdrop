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

/* ---------- copy a chat message out (PC + phone) ----------
   Text goes to the clipboard as text. Images go as PNG — browsers only
   accept text and PNG on the clipboard, so anything else (video, audio,
   documents) has no copy path: the Download link is the way out for those.
   The canvas step converts JPEG/WebP/etc. to PNG; blob: URLs are
   same-origin, so the canvas is never tainted. Animated images copy as
   their first frame. Returns true when the clipboard actually took it. */
async function copyTextToClipboard(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}
async function copyImageBlob(blob) {
  try {
    if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)) return false;
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const png = await new Promise((res) => c.toBlob(res, 'image/png'));
      if (!png) return false;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return true;
    } finally { URL.revokeObjectURL(url); }
  } catch (e) { return false; }
}
function copyBtn(label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cbtn';
  b.textContent = '📋 Copy';
  b.setAttribute('aria-label', label || 'Copy');
  return b;
}
function flashCopy(btn, ok) {
  const orig = btn.textContent;
  btn.textContent = ok ? '✓ Copied' : '✕ Copy failed';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1600);
}
function addCopyImageBtn(cardEl, blob) {
  const body = cardEl.querySelector('.fbody');
  if (!body) return;
  const b = copyBtn('Copy image');
  b.addEventListener('click', async () => flashCopy(b, await copyImageBlob(blob)));
  body.appendChild(b);
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
   hanging on "connecting…" forever — and release the call state so a
   later tap doesn't get auto-declined as "busy". */
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
const APP_V = 11; // protocol: hello, file-ask approval, file-cancel, clip, sha-256 checksums (v10), app-layer E2EE (v11)
const LS_TURN = 'ld_turn';
/* Default ICE servers: public STUN + the free Open Relay TURN as a fallback
   for networks where no direct path exists. The data channel stays
   end-to-end (DTLS) encrypted either way; a relay can only see metadata.
   Users can add their own TURN server in settings (stored locally). */
const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  // v21.2: TURN over TCP/TLS as well as UDP. On networks that block UDP,
  // or where the public relay credentials have changed, a TCP relay is
  // the only path left when direct host candidates fail (e.g. mDNS
  // host candidates that the other side cannot resolve). Additive only.
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
function buildIceServers() {
  const out = DEFAULT_ICE.slice();
  try {
    const t = JSON.parse(storeGet(LS_TURN) || 'null');
    if (t && typeof t.urls === 'string' && t.urls) {
      const e = { urls: t.urls };
      if (t.username) e.username = String(t.username);
      if (t.credential) e.credential = String(t.credential);
      out.push(e);
    }
  } catch (e) { /* noop */ }
  return out;
}
/* Optional custom TURN server fields (home settings) — stored locally,
   applied to every new connection. */
function initTurnSettings() {
  const turnInp = [$('turnUrl'), $('turnUser'), $('turnPass')];
  if (!turnInp[0]) return;
  try {
    const t = JSON.parse(storeGet(LS_TURN) || 'null');
    if (t) {
      turnInp[0].value = t.urls || '';
      turnInp[1].value = t.username || '';
      turnInp[2].value = t.credential || '';
    }
  } catch (e) { /* noop */ }
  const saveTurn = () => {
    const urls = turnInp[0].value.trim();
    if (!urls) { storeSet(LS_TURN, ''); return; }
    storeSet(LS_TURN, JSON.stringify({
      urls,
      username: turnInp[1].value.trim(),
      credential: turnInp[2].value,
    }));
  };
  turnInp.forEach((i) => i && i.addEventListener('change', saveTurn));
}
let pc = null;
let dc = null;
let peerV = 0;            // protocol version of the connected peer (0 = unknown/legacy)
let incoming = null;          // file currently being received
const sendQueue = [];
let sending = false;
let activeSend = null;        // {id, cancelled} — transfer currently on the wire
const approvalWaiters = {};   // id -> resolve fn for file-ask approval
const pendingAsks = {};       // id -> {meta, el} — incoming files awaiting our verdict
let txBytes = 0, rxBytes = 0; // session byte counters (transfer HUD speed graph)
let drainWaiter = null;       // resolves when the channel's send buffer drains

function setStatus(state, text) {
  $('status').className = 'status ' + state;
  $('statusText').textContent = text;
}

function teardown() {
  if (dc) {
    dc.onopen = null; dc.onmessage = null; dc.onclose = null;
    try { dc.close(); } catch (e) { /* noop */ }
  }
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.ondatachannel = null;
    pc.onicecandidate = null;
    try { pc.close(); } catch (e) { /* noop */ }
  }
  dc = null; pc = null; incoming = null;
  e2eReset();
  clearTimeout(connectTimer);
  stopConnStats();
  sendQueue.length = 0; sending = false;
  receivedFiles.length = 0; updateFileActions();
  activeSend = null; peerV = 0;
  Object.keys(approvalWaiters).forEach((id) => { try { approvalWaiters[id]('gone'); } catch (e) {} delete approvalWaiters[id]; });
  Object.keys(pendingAsks).forEach((id) => delete pendingAsks[id]);
  setStatus('idle', 'not connected');
  const pl = $('peerLabel');
  if (pl) pl.textContent = '…';
}

function newPC() {
  teardown();
  pc = new RTCPeerConnection({ iceServers: buildIceServers() });
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.connectionState;
    if (s === 'connected') setStatus('ok', 'connected');
    else if (s === 'failed') setStatus('bad', 'connection failed — try fresh codes');
    else if (s === 'disconnected' || s === 'closed') setStatus('bad', 'disconnected');
    else setStatus('idle', 'connecting…');
  };
  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    if (nbDiag) { nbDiag.ice = pc.iceConnectionState; nbDiagRender(); }
    if (pc.iceConnectionState === 'failed') {
      setStatus('bad', 'connection failed — try fresh codes');
    }
  };
  pc.onicegatheringstatechange = () => {
    if (!pc || !nbDiag) return;
    if (pc.iceGatheringState === 'complete') nbDiagRender();
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
  renderQRInto($('qr'), text);
}
function renderQRInto(el, text) {
  if (!el) return;
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
  if (!code) {
    setStatus('bad', 'code needed');
    alert("Paste the sharer's code first.\n\n• Open LocalDrop on the other device and tap Share\n• Copy the FULL share code (tap its Copy button) or scan its QR\n• Paste it here, then tap “Create my reply code”");
    return;
  }
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
    renderQRInto($('qrReply'), $('joinReply').value);
    setStatus('idle', 'waiting for host…');
    watchConnect(60000);
  } catch (e) {
    setStatus('bad', 'bad code');
    alert("That code didn't work — double-check it and try again.");
  }
});

/* ---------- data channel ---------- */
function wireDC() {
  dc.binaryType = 'arraybuffer';
  try { dc.bufferedAmountLowThreshold = 262144; } catch (e) { /* older browsers */ }
  dc.onbufferedamountlow = () => { if (drainWaiter) drainWaiter(); };
  dc.onopen = () => {
    clearTimeout(connectTimer);
    $('messages').innerHTML = '';
    $('peerLabel').textContent = 'connected';
    // protocol handshake: announce our version so the peer knows which
    // frames we understand (file-ask approval, file-cancel, clip).
    peerV = 0;
    try { dc.send(JSON.stringify({ t: 'hello', v: APP_V })); } catch (e) { /* noop */ }
    e2eStart(); // v11: offer end-to-end encryption (ephemeral ECDH)
    go('chat');
    setStatus('ok', 'connected');
    sysMsg('Connected 🔗 — send photos, files, folders, text, links, or your clipboard (📋).');
    startConnStats();
  };
  dc.onmessage = onData;
  dc.onclose = () => {
    stopConnStats();
    e2eReset();
    setStatus('bad', 'disconnected');
    sysMsg('Partner disconnected.');
  };
}

function onData(e) {
  if (typeof e.data === 'string') {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'enc') {
      // v11 encrypted envelope: decrypt, then dispatch the plaintext frame
      if (!e2eKey) return;
      decFrameStr(m).then((plain) => handleFrame(plain)).catch(() => {});
      return;
    }
    handleFrame(e.data);
  } else if (incoming) {
    feedChunk(e.data);
  }
}

function handleFrame(str) {
  let m;
  try { m = JSON.parse(str); } catch (err) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'msg') addText(false, m.text);
  else if (m.t === 'hello') { peerV = Math.max(0, m.v | 0); }
  else if (m.t === 'e2e-hello') onE2eHello(m.k);
  else if (m.t === 'clip' && typeof m.text === 'string') {
    addText(false, m.text);
    sysMsg('📋 Clipboard received');
  }
  else if (m.t === 'file-meta') {
    // legacy path (peer < v9): files arrive unannounced, auto-accepted
    incoming = { meta: m, parts: [], got: 0, el: fileCard(false, dispName(m), m.size, null, m.mime) };
    prepareIncoming(incoming);
  } else if (m.t === 'file-ask') onFileAsk(m);
  else if ((m.t === 'file-ok' || m.t === 'file-no') && approvalWaiters[m.id]) {
    approvalWaiters[m.id](m.t === 'file-ok' ? 'ok' : 'no');
  }
  else if (m.t === 'file-cancel' && m.id) onFileCancel(m.id);
  else if (m.t === 'file-end' && incoming && incoming.meta.id === m.id) {
    finishFile();
  }
}

/* One received chunk, in wire order: decrypt if this transfer is encrypted,
   then stream to device storage (large files) or accumulate in memory.
   Everything runs on the transfer's promise chain so order is preserved
   even though decryption and storage writes are async. */
function feedChunk(data) {
  const cur = incoming;
  if (!cur) return;
  const step = async () => {
    if (incoming !== cur) return; // cancelled or replaced while queued
    let buf = data;
    if (cur.enc) {
      try {
        buf = await decChunk(data, cur.eiv, cur.ctr);
      } catch (e) {
        incoming = null;
        setCardNote(cur.el, 'failed — decryption error (wrong key or corrupted data)');
        markDone(cur.el);
        closeIncomingStream(cur);
        if (cur.meta.id) sendFrame({ t: 'file-cancel', id: cur.meta.id });
        return;
      }
      cur.ctr++;
    }
    cur.got += buf.byteLength;
    rxBytes += buf.byteLength;
    if (cur.got > (cur.meta.size || 0) + 1048576) {
      const el = cur.el;
      const id = cur.meta && cur.meta.id;
      incoming = null;
      setCardNote(el, 'failed — size limit exceeded');
      markDone(el);
      closeIncomingStream(cur);
      if (id) sendFrame({ t: 'file-cancel', id });
      return;
    }
    if (cur.stream) {
      try {
        await cur.stream.w.write(buf);
      } catch (e) {
        incoming = null;
        setCardNote(cur.el, 'failed — device storage write error');
        markDone(cur.el);
        closeIncomingStream(cur);
        if (cur.meta.id) sendFrame({ t: 'file-cancel', id: cur.meta.id });
        return;
      }
    } else {
      cur.parts.push(buf);
    }
    setProg(cur.el, cur.got / (cur.meta.size || 1));
  };
  // run the step even if a previous link rejected — a poisoned chain would
  // otherwise silently swallow every later chunk
  cur.chain = (cur.chain || Promise.resolve()).then(step, step);
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
  const cb = copyBtn('Copy message');
  cb.addEventListener('click', async () => flashCopy(cb, await copyTextToClipboard(text)));
  d.querySelector('.meta').appendChild(cb);
  $('messages').appendChild(d);
  scrollDown();
}
function basename(p) {
  const clean = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return (clean && clean !== '.' && clean !== '..') ? clean : 'file';
}
function dispName(m) {
  return (m && (m.path || m.name)) || 'file';
}
function iconFor(mime) {
  mime = String(mime || '');
  if (mime.indexOf('image/') === 0) return '🖼️';
  if (mime.indexOf('video/') === 0) return '🎬';
  if (mime.indexOf('audio/') === 0) return '🎵';
  if (mime === 'application/pdf') return '📕';
  if (/zip|rar|7z|tar|gzip/.test(mime)) return '🗜️';
  return '📄';
}
function fmtSpeed(bps) {
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}
function fileCard(mine, name, size, id, mime) {
  const d = document.createElement('div');
  d.className = 'bubble ' + (mine ? 'mine' : 'theirs');
  d.innerHTML =
    '<div class="fbody"><div class="frow">' +
    '<span class="fic">' + iconFor(mime) + '</span>' +
    '<div class="finfo"><div class="fname">' + esc(name) + '</div>' +
    '<div class="fsize">' + fmtSize(size) + '</div></div>' +
    '<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="ringbg" cx="18" cy="18" r="15.5"></circle><circle class="ringfg" cx="18" cy="18" r="15.5"></circle></svg>' +
    (id ? '<button class="xbtn" title="Cancel transfer" aria-label="Cancel transfer">✕</button>' : '') +
    '</div>' +
    '<div class="fnote"></div>' +
    '<div class="track"><div class="bar busy"></div></div>' +
    '<div class="spd"></div></div>';
  $('messages').appendChild(d);
  scrollDown();
  return d;
}
const RING_C = 97.4; // 2π × 15.5 — progress ring circumference
function setProg(el, p) {
  const bar = el.querySelector('.bar');
  if (bar) {
    bar.style.width = Math.min(100, p * 100) + '%';
    bar.classList.toggle('busy', p < 1);
  }
  const fg = el.querySelector('.ringfg');
  if (fg) fg.style.strokeDashoffset = (RING_C * (1 - Math.min(1, Math.max(0, p)))).toFixed(1);
}
function setCardNote(el, t) {
  const n = el.querySelector('.fnote');
  if (!n) return;
  n.textContent = t || '';
  n.style.display = t ? 'block' : 'none';
}
function setSpeed(el, bps) {
  const s = el.querySelector('.spd');
  if (!s) return;
  s.textContent = bps > 0 ? fmtSpeed(bps) : '';
}
function markDone(el) {
  setProg(el, 1);
  setSpeed(el, 0);
  const x = el.querySelector('.xbtn');
  if (x) x.style.display = 'none';
}
/* ---------- receiving: storage streaming (large files) ----------
   Files ≥ 64 MB stream chunk-by-chunk into the browser's private device
   storage (OPFS FileSystemWritableFileStream) instead of accumulating in
   RAM — that's what makes 10 GB-class transfers possible on a phone.
   Anything smaller, or any browser without OPFS, uses the memory path.
   If the stream can't open, the memory path silently continues; if a
   write fails mid-stream the transfer aborts with an honest note. */
const STREAM_MIN = 67108864; // 64 MB
function prepareIncoming(cur) {
  cur.chain = cur.chain || Promise.resolve();
  if (!cur.parts) cur.parts = [];
  cur.enc = !!cur.meta.enc;
  if (cur.enc) { cur.eiv = b64dec(cur.meta.eiv || ''); cur.ctr = 0; }
  if ((cur.meta.size || 0) < STREAM_MIN) return;
  if (!(navigator.storage && navigator.storage.getDirectory)) return;
  (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('localdrop', { create: true });
      const fh = await dir.getFileHandle('rx-' + cur.meta.id + '.bin', { create: true });
      const w = await fh.createWritable();
      // switch over inside the chunk chain, flushing anything buffered;
      // if the flush fails the memory path simply continues (parts intact)
      const switchOver = async () => {
        if (incoming !== cur) { try { await w.abort(); } catch (e) {} return; }
        try {
          for (const p of cur.parts) await w.write(p);
          cur.parts = [];
          cur.stream = { dir, fh, w };
        } catch (e) {
          try { await w.abort(); } catch (err) { /* noop */ }
        }
      };
      cur.chain = cur.chain.then(switchOver, switchOver);
    } catch (e) { /* OPFS unavailable after all — memory path continues */ }
  })();
}
function closeIncomingStream(cur) {
  if (!cur || !cur.stream) return;
  const s = cur.stream;
  cur.stream = null;
  (async () => {
    try { await s.w.abort(); } catch (e) { /* noop */ }
    try { await s.dir.removeEntry('rx-' + cur.meta.id + '.bin'); } catch (e) { /* noop */ }
  })();
}
/* Received files live in OPFS only for the session that received them
   (their download links die with the page), so stale ones from earlier
   sessions are safe to sweep. Active transfers are never this old. */
(function sweepStaleOpfs() {
  try {
    if (!(navigator.storage && navigator.storage.getDirectory)) return;
    navigator.storage.getDirectory().then(async (root) => {
      const dir = await root.getDirectoryHandle('localdrop');
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for await (const [name, handle] of dir.entries()) {
        try {
          const f = await handle.getFile();
          if (f.lastModified < cutoff) await dir.removeEntry(name);
        } catch (e) { /* per-file best effort */ }
      }
    }).catch(() => {});
  } catch (e) { /* noop */ }
})();

async function finishFile() {
  const cur = incoming;
  if (!cur) return;
  // drain the chunk chain BEFORE detaching `incoming` — queued chunk steps
  // check they still belong to the active transfer, so detaching first
  // would silently drop the tail of the file
  if (cur.chain) { try { await cur.chain; } catch (e) { /* chain steps handle their own errors */ } }
  if (incoming === cur) incoming = null;
  if (cur.got < cur.meta.size) {
    setCardNote(cur.el, 'incomplete file received');
    markDone(cur.el);
    closeIncomingStream(cur);
    return;
  }
  let blob;
  if (cur.stream) {
    try {
      await cur.stream.w.close();
      blob = await cur.stream.fh.getFile();
    } catch (e) {
      setCardNote(cur.el, 'failed — could not read back the saved file');
      markDone(cur.el);
      return;
    }
  } else {
    blob = new Blob(cur.parts, { type: cur.meta.mime });
  }
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
  // images also get a Copy button (video and other files can't go on the
  // clipboard in any browser — Download is their way out)
  if (cur.meta.mime.indexOf('image/') === 0) addCopyImageBtn(cur.el, blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(cur.meta.name);
  a.className = 'dl';
  a.textContent = '⬇ Download';
  body.appendChild(a);
  scrollDown();
  markDone(cur.el);
  // v10 checksum: prove the received bytes match the sender's SHA-256
  if (cur.meta.sha) {
    const el = cur.el, want = String(cur.meta.sha).toLowerCase();
    sha256Hex(blob).then((got) => {
      if (!got) return;
      setCardNote(el, got === want
        ? '✓ checksum verified (SHA-256) — byte-identical'
        : '⚠ checksum mismatch — file may be corrupted');
    });
  } else if (cur.stream) {
    setCardNote(cur.el, 'streamed straight to device storage (low-memory mode) — ' +
      'no checksum for files this size');
  }
  // track for Download-all / Share
  receivedFiles.push({ name: basename(cur.meta.name), path: dispName(cur.meta), blob });
  updateFileActions();
}

/* ---------- download-all (ZIP) + share ---------- */
const receivedFiles = []; // [{name, path, blob}] — completed incoming files this session

function updateFileActions() {
  const n = receivedFiles.length;
  const wrap = $('fileActions');
  const dl = $('btnDlAll');
  const sh = $('btnShareAll');
  if (!wrap || !dl || !sh) return;
  const canShare = !!(navigator.share);
  dl.classList.toggle('hidden', n < 2);
  sh.classList.toggle('hidden', !(canShare && n >= 1));
  wrap.classList.toggle('hidden', n < 2 && !(canShare && n >= 1));
  dl.textContent = '⬇ All (' + n + ')';
}

function uniqueZipPath(p, used) {
  if (!used.has(p)) { used.add(p); return p; }
  const i = p.lastIndexOf('.');
  const base = i > 0 ? p.slice(0, i) : p;
  const ext = i > 0 ? p.slice(i) : '';
  let k = 2, q;
  do { q = base + ' (' + (k++) + ')' + ext; } while (used.has(q));
  used.add(q);
  return q;
}

async function downloadAll() {
  const btn = $('btnDlAll');
  if (!receivedFiles.length || !btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Zipping…';
  try {
    if (typeof ZipWriter === 'undefined') throw new Error('zip unavailable');
    const used = new Set();
    const files = [];
    for (const f of receivedFiles) {
      const buf = new Uint8Array(await f.blob.arrayBuffer());
      files.push({ path: uniqueZipPath(ZipWriter.sanitizePath(f.path || f.name), used), data: buf });
    }
    const bytes = ZipWriter.zipStore(files);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'localdrop-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    btn.textContent = 'Failed — try again';
    await new Promise((r) => setTimeout(r, 1500));
  }
  btn.disabled = false;
  btn.textContent = orig;
}

async function shareAll() {
  if (!receivedFiles.length || !navigator.share) return;
  try {
    const files = receivedFiles.map((f) =>
      new File([f.blob], f.name, { type: f.blob.type || 'application/octet-stream' }));
    const data = { files, title: 'LocalDrop files' };
    if (navigator.canShare && !navigator.canShare(data)) return;
    await navigator.share(data);
  } catch (e) { /* user cancelled or share failed — ignore */ }
}

/* ---------- sending ---------- */
function sendText() {
  const inp = $('textInput');
  const t = inp.value.trim();
  if (!t || !dc || dc.readyState !== 'open') return;
  sendFrame({ t: 'msg', text: t, ts: Date.now() });
  addText(true, t);
  inp.value = '';
}

function enqueueFile(file) {
  if (!file) return;
  if (!file._ldId) file._ldId = uid();
  sendQueue.push(file);
  pumpQueue();
}

/* Wait for the peer's verdict on a file-ask. Resolves 'ok', 'no', 'timeout'
   or 'gone' (connection dropped mid-wait). */
function waitForApproval(id, ms) {
  return new Promise((res) => {
    const to = setTimeout(() => { delete approvalWaiters[id]; res('timeout'); }, ms);
    approvalWaiters[id] = (r) => { clearTimeout(to); delete approvalWaiters[id]; res(r); };
  });
}

function dcSendRaw(str) {
  if (dc && dc.readyState === 'open') {
    try { dc.send(str); } catch (e) { /* noop */ }
  }
}

/* ---------- end-to-end encryption (v11) ----------
   WebRTC already encrypts the transport (DTLS). On top of that, v11 peers
   exchange ephemeral ECDH (P-256) public keys as the first channel frames
   and derive one AES-GCM-256 key per connection (HKDF, salted with a hash
   of the two connection codes — the SDPs both sides already hold). Every
   later frame and file chunk is encrypted with that key before it touches
   the channel. Keys live in memory only and die with the connection —
   chat is ephemeral, nothing is stored. Peers without e2e-hello (v10 and
   older) simply stay on transport encryption, and the UI says which mode
   a connection is in. */
let e2eKey = null;         // derived AES-GCM key for this connection
let e2eSafety = '';        // human-comparable safety code for this session
let e2eMyPair = null;      // our ephemeral ECDH keypair (never persisted)
let e2eMyRaw = null;       // our raw public key bytes
let e2ePeerRawB64 = null;  // peer's public key, as received
let e2eDeriving = false;
let sendChain = Promise.resolve(); // serializes encrypted sends (order matters)

function b64enc(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function b64dec(str) {
  const s = atob(String(str || ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function e2eReset() {
  e2eKey = null;
  e2eSafety = '';
  e2eMyPair = null;
  e2eMyRaw = null;
  e2ePeerRawB64 = null;
  e2eDeriving = false;
  sendChain = Promise.resolve();
}
/* Salt binds the key to this connection's codes: both sides hold both
   SDPs, so both derive the same salt without exchanging anything extra. */
async function e2eSalt() {
  try {
    const a = (pc && pc.localDescription && pc.localDescription.sdp) || '';
    const b = (pc && pc.remoteDescription && pc.remoteDescription.sdp) || '';
    if (a && b) {
      const dig = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode([a, b].sort().join('\n')));
      return new Uint8Array(dig);
    }
  } catch (e) { /* fall through to a fixed salt */ }
  return new Uint8Array(32);
}
async function e2eStart() {
  e2eReset();
  if (!crypto || !crypto.subtle) return;
  try {
    e2eMyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    e2eMyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', e2eMyPair.publicKey));
    dcSendRaw(JSON.stringify({ t: 'e2e-hello', k: b64enc(e2eMyRaw) }));
    tryDeriveE2e();
  } catch (e) { e2eMyPair = null; }
}
function onE2eHello(kB64) {
  if (typeof kB64 !== 'string' || !kB64) return;
  e2ePeerRawB64 = kB64;
  tryDeriveE2e();
}
async function tryDeriveE2e() {
  if (e2eKey || e2eDeriving || !e2eMyPair || !e2ePeerRawB64) return;
  e2eDeriving = true;
  try {
    const peerRaw = b64dec(e2ePeerRawB64);
    const peerPub = await crypto.subtle.importKey('raw', peerRaw,
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPub }, e2eMyPair.privateKey, 256);
    const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    e2eKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: await e2eSalt(),
        info: new TextEncoder().encode('localdrop-e2e-v1') },
      hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const pair = [b64enc(e2eMyRaw), e2ePeerRawB64].sort().join('.');
    const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair));
    const hex = Array.from(new Uint8Array(dig).slice(0, 6))
      .map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    e2eSafety = hex.slice(0, 6) + '-' + hex.slice(6);
    sysMsg('🔐 End-to-end encryption on (AES-GCM) — safety code ' + e2eSafety +
      '. It matches on the other device; compare it if you want proof.');
  } catch (e) { /* derivation failed: stay on transport encryption */ }
  e2eDeriving = false;
}
async function encFrameStr(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, e2eKey,
    new TextEncoder().encode(plain));
  return JSON.stringify({ t: 'enc', iv: b64enc(iv), d: b64enc(new Uint8Array(ct)) });
}
async function decFrameStr(m) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(m.iv) },
    e2eKey, b64dec(m.d));
  return new TextDecoder().decode(pt);
}
/* Per-chunk AES-GCM: IV = 8-byte per-transfer base || 32-bit chunk counter */
function chunkIv(base, ctr) {
  const iv = new Uint8Array(12);
  iv.set(base, 0);
  new DataView(iv.buffer).setUint32(8, ctr);
  return iv;
}
function encChunk(buf, base, ctr) {
  return crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(base, ctr) }, e2eKey, buf);
}
function decChunk(buf, base, ctr) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(base, ctr) }, e2eKey, buf);
}

function sendFrame(o) {
  const plain = JSON.stringify(o);
  if (!e2eKey || o.t === 'hello' || o.t === 'e2e-hello') { dcSendRaw(plain); return; }
  sendChain = sendChain.then(async () => {
    try { dcSendRaw(await encFrameStr(plain)); } catch (e) { /* frame dropped, never sent in plaintext */ }
  });
}

/* SHA-256 of a Blob/File as hex, or '' when unavailable. Used to prove a
   received file is byte-identical to what the sender hashed (v10). */
async function sha256Hex(blob) {
  try {
    if (!crypto || !crypto.subtle) return '';
    const buf = await blob.arrayBuffer();
    const dig = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}
const SHA_MAX = 512 * 1048576; // skip hashing very large files (memory)

/* Cancel an outgoing transfer — the one on the wire or one still queued. */
function cancelSend(id) {
  if (activeSend && activeSend.id === id) {
    activeSend.cancelled = true;
    const w = approvalWaiters[id];
    if (w) w('no'); // release a transfer stuck waiting for approval
  } else {
    const i = sendQueue.findIndex((f) => f._ldId === id);
    if (i >= 0) { sendQueue.splice(i, 1); sysMsg('Removed from the send queue.'); }
  }
  sendFrame({ t: 'file-cancel', id });
}

/* Cancel an incoming transfer (v9 ask-flow only — legacy peers can't abort). */
function cancelReceive(id) {
  if (incoming && incoming.meta.id === id) {
    const el = incoming.el;
    const cur = incoming;
    incoming = null;
    setCardNote(el, 'cancelled');
    markDone(el);
    closeIncomingStream(cur);
  }
  sendFrame({ t: 'file-cancel', id });
}

/* The peer aborted a transfer (or withdrew a pending ask). */
function onFileCancel(id) {
  if (activeSend && activeSend.id === id) {
    activeSend.cancelled = true; // the pump loop marks the card
    const w = approvalWaiters[id];
    if (w) w('no');
    return;
  }
  if (incoming && incoming.meta.id === id) {
    const el = incoming.el;
    const cur = incoming;
    incoming = null;
    setCardNote(el, 'cancelled by sender');
    markDone(el);
    closeIncomingStream(cur);
    return;
  }
  const p = pendingAsks[id];
  if (p) {
    delete pendingAsks[id];
    const row = p.el.querySelector('.askrow');
    if (row) row.remove();
    setCardNote(p.el, 'withdrawn by sender');
  }
}

/* Flow control: pause the pump while more than ~1 MB sits unsent in the
   channel buffer; resume on bufferedamountlow (with a timed fallback —
   some browsers are shy about firing it). Keeps memory flat on huge
   files: the sender never queues more than ~1 MB ahead of the wire. */
function waitDrain() {
  if (!dc || dc.bufferedAmount <= 1048576) return Promise.resolve();
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (drainWaiter === finish) drainWaiter = null;
      res();
    };
    drainWaiter = finish;
    setTimeout(finish, 200);
  });
}

async function pumpQueue() {
  if (sending || !sendQueue.length) return;
  if (!dc || dc.readyState !== 'open') return;
  sending = true;
  const file = sendQueue.shift();
  const id = file._ldId || uid();
  const meta = {
    t: 'file-meta', id,
    name: file.name, size: file.size,
    mime: file.type || 'application/octet-stream',
  };
  if (file._ldPath) meta.path = file._ldPath;
  // v10: hash the file up front so the receiver can verify byte-identity
  if (peerV >= 10 && file.size > 0 && file.size <= SHA_MAX) {
    const h = await sha256Hex(file);
    if (h) meta.sha = h;
  }
  // v11: when end-to-end encryption is active, chunks go out AES-GCM
  // encrypted under a per-transfer IV base the receiver derives counters from
  let encBase = null;
  if (e2eKey) {
    encBase = crypto.getRandomValues(new Uint8Array(8));
    meta.enc = 1;
    meta.eiv = b64enc(encBase);
  }
  const el = fileCard(true, dispName(meta), file.size, id, meta.mime);
  const xb = el.querySelector('.xbtn');
  if (xb) xb.addEventListener('click', () => cancelSend(id));
  const transfer = { id, cancelled: false };
  activeSend = transfer;
  try {
    if (peerV >= APP_V) {
      // v9 approval flow: ask first, stream only on Accept
      setCardNote(el, '⏳ waiting for approval…');
      sendFrame(Object.assign({}, meta, { t: 'file-ask' }));
      const verdict = await waitForApproval(id, 90000);
      if (transfer.cancelled) {
        setCardNote(el, 'cancelled');
      } else if (verdict === 'ok') {
        setCardNote(el, '');
      } else {
        setCardNote(el, verdict === 'no' ? 'declined' : 'no answer — not sent');
        markDone(el);
        activeSend = null; sending = false; pumpQueue();
        return;
      }
      if (transfer.cancelled) { markDone(el); activeSend = null; sending = false; pumpQueue(); return; }
    } else {
      sendFrame(meta); // legacy peer: classic unannounced send
    }
    const CHUNK = file.size > 33554432 ? 65536 : 16384;
    let off = 0, lastT = Date.now(), lastOff = 0, ctr = 0;
    while (off < file.size) {
      if (transfer.cancelled) break;
      while (dc.bufferedAmount > 1048576) {
        await waitDrain();
        if (transfer.cancelled) break;
      }
      if (transfer.cancelled) break;
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      if (encBase) {
        const ct = await encChunk(buf, encBase, ctr++);
        dc.send(ct);
        txBytes += ct.byteLength;
      } else {
        dc.send(buf);
        txBytes += buf.byteLength;
      }
      off += buf.byteLength;
      setProg(el, off / file.size);
      const now = Date.now();
      if (now - lastT >= 500) {
        setSpeed(el, (off - lastOff) / ((now - lastT) / 1000));
        lastT = now; lastOff = off;
      }
    }
    if (transfer.cancelled) {
      setCardNote(el, 'cancelled');
    } else {
      sendFrame({ t: 'file-end', id });
    }
    // sent images get a Copy button too (the File is just a handle to the
    // user's disk file — keeping the reference costs no memory)
    if (!transfer.cancelled && (file.type || '').indexOf('image/') === 0) addCopyImageBtn(el, file);
    markDone(el);
  } catch (err) {
    el.querySelector('.fname').textContent += ' — failed';
    markDone(el);
  }
  activeSend = null;
  sending = false;
  pumpQueue();
}

/* ---------- incoming file approval (v9) ---------- */
function onFileAsk(m) {
  if (!m || !m.id || pendingAsks[m.id]) return;
  if (typeof m.size !== 'number' || m.size < 0 || !Number.isFinite(m.size)) {
    sendFrame({ t: 'file-no', id: m.id });
    return;
  }
  if (incoming) { sendFrame({ t: 'file-no', id: m.id }); return; } // busy: don't clobber the active transfer
  const d = document.createElement('div');
  d.className = 'bubble theirs ask';
  d.innerHTML =
    '<div class="fbody"><div class="frow">' +
    '<span class="fic">' + iconFor(m.mime) + '</span>' +
    '<div class="finfo"><div class="fname">' + esc(dispName(m)) + '</div>' +
    '<div class="fsize">' + fmtSize(m.size) + '</div></div></div>' +
    '<div class="fnote">wants to send you this file</div>' +
    '<div class="askrow"><button class="btn small okbtn">✓ Accept</button>' +
    '<button class="btn small nobtn">✕ Decline</button></div></div>';
  $('messages').appendChild(d);
  scrollDown();
  pendingAsks[m.id] = { meta: m, el: d };
  const ok = d.querySelector('.okbtn');
  const no = d.querySelector('.nobtn');
  if (ok) ok.addEventListener('click', () => acceptAsk(m.id));
  if (no) no.addEventListener('click', () => declineAsk(m.id));
}

function acceptAsk(id) {
  const p = pendingAsks[id];
  if (!p) return;
  delete pendingAsks[id];
  const m = p.meta;
  if (incoming) {
    // Another transfer became active after this card appeared — accepting
    // now would overwrite `incoming` and corrupt both transfers. Decline
    // this one cleanly instead; the sender can retry when we're free.
    if (p.el && p.el.remove) p.el.remove();
    sendFrame({ t: 'file-no', id });
    sysMsg('Busy with another file — declined ' + dispName(m) + ' (sender can retry).');
    return;
  }
  if (p.el && p.el.remove) p.el.remove();
  incoming = { meta: m, parts: [], got: 0, el: fileCard(false, dispName(m), m.size, m.id, m.mime) };
  prepareIncoming(incoming);
  const xb = incoming.el.querySelector('.xbtn');
  if (xb) xb.addEventListener('click', () => cancelReceive(m.id));
  sendFrame({ t: 'file-ok', id });
  scrollDown();
}

function declineAsk(id) {
  const p = pendingAsks[id];
  if (!p) return;
  delete pendingAsks[id];
  const row = p.el.querySelector('.askrow');
  if (row) row.remove();
  setCardNote(p.el, 'declined');
  sendFrame({ t: 'file-no', id });
}

/* ---------- clipboard sync ---------- */
async function sendClipboard() {
  if (!dc || dc.readyState !== 'open') {
    sysMsg('Connect first, then tap 📋 to share your clipboard.');
    return;
  }
  const clip = navigator.clipboard;
  if (!clip) {
    alert("Clipboard access isn't available here.\n\nIt needs a secure (https) page and a browser that allows clipboard access.");
    return;
  }
  try {
    let text = '';
    try { text = await clip.readText(); } catch (e) { /* denied or empty */ }
    if (text && text.trim()) {
      sendFrame({ t: 'clip', text, ts: Date.now() });
      addText(true, text);
      sysMsg('📋 Clipboard sent' + (peerV > 0 && peerV < APP_V ? ' — their app looks outdated, ask them to refresh the page if nothing arrives.' : ''));
      return;
    }
    // no text — look for an image (e.g. a screenshot)
    if (clip.read) {
      const items = await clip.read();
      for (const it of items) {
        const imgType = (it.types || []).find((t) => t.indexOf('image/') === 0);
        if (imgType) {
          const blob = await it.getType(imgType);
          const ext = (imgType.split('/')[1] || 'png').split('+')[0];
          const f = new File([blob], 'clipboard-' + Date.now() + '.' + ext, { type: imgType });
          enqueueFile(f);
          sysMsg('📋 Clipboard image queued');
          return;
        }
      }
    }
    sysMsg('Clipboard is empty — copy some text or an image first.');
  } catch (err) {
    alert("Couldn't read the clipboard.\n\nYour browser may need permission — allow clipboard access for this site and try again.");
  }
}

/* ---------- folder send: walk a dropped / picked directory ---------- */
async function filesFromEntry(entry, base) {
  const out = [];
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: base ? base + '/' + file.name : file.name });
  } else if (entry.isDirectory) {
    const dirPath = base ? base + '/' + entry.name : entry.name;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) {
        const sub = await filesFromEntry(child, dirPath);
        out.push.apply(out, sub);
      }
    }
  }
  return out;
}

function entryOf(item) {
  if (!item) return null;
  if (item.webkitGetAsEntry) return item.webkitGetAsEntry();
  if (item.getAsEntry) return item.getAsEntry(); // newer Firefox
  return null;
}

async function handleFolderDrop(items) {
  const collected = [];
  for (const it of items) {
    let entry = null;
    try { entry = entryOf(it); } catch (e) { /* noop */ }
    if (!entry) continue;
    try {
      const found = await filesFromEntry(entry, '');
      collected.push.apply(collected, found);
    } catch (e) { /* skip unreadable entries */ }
  }
  if (!collected.length) {
    sysMsg('Nothing sendable in that drop.');
    return;
  }
  if (collected.length > 500) {
    sysMsg('Big drop — sending the first 500 files.');
    collected.length = 500;
  }
  collected.forEach(({ file, path }) => { file._ldPath = path; enqueueFile(file); });
  sysMsg('Sending ' + collected.length + (collected.length === 1 ? ' file' : ' files') + '…');
}

function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } }

/* Stable per-device id, created once and kept in localStorage. */
/* ---------- service worker update prompter ----------
   If a newer version shipped while this tab runs the old one, offer a
   one-tap refresh instead of silently staying stale. */
function watchForUpdates() {
  const sw = navigator.serviceWorker;
  if (!sw || !sw.getRegistration) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdateToast();
    }
    const check = () => { try { const p = reg.update(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* noop */ } };
    check(); // ask for a fresh sw.js now, not whenever the browser feels like it
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast();
      });
    });
    setInterval(check, 30 * 60 * 1000); // re-check every 30 min on long-lived tabs
    // also check whenever the tab becomes visible again (e.g. phone unlocked)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  }).catch(() => {});
}
function showUpdateToast() {
  let t = document.getElementById('updateToast');
  if (t) { t.classList.add('show'); return; }
  t = document.createElement('div');
  t.id = 'updateToast';
  const s = document.createElement('span');
  s.textContent = '✨ New version available';
  const b = document.createElement('button');
  b.textContent = 'Refresh';
  b.addEventListener('click', () => window.location.reload());
  t.appendChild(s);
  t.appendChild(b);
  document.body.appendChild(t);
  const show = () => t.classList.add('show');
  if (window.requestAnimationFrame) window.requestAnimationFrame(show); else show();
}

/* ---------- connection quality (real getStats data) + transfer HUD ----------
   The badge and graph only ever show measured values: the selected ICE
   candidate pair's types (host/srflx/relay) and its round-trip time, and
   byte counters sampled twice a second. Nothing is estimated or faked. */
let statsTimer = null;
function connPathLabel(localType, remoteType) {
  if (localType === 'relay' || remoteType === 'relay') return 'via relay';
  if (localType === 'host' && remoteType === 'host') return 'direct · same network';
  if (!localType && !remoteType) return '';
  return 'direct · internet';
}
function encLabel() {
  return e2eKey ? '🔐 E2E-encrypted (AES-GCM)' : '🔒 DTLS-encrypted';
}
async function sampleConnStats() {
  if (!pc || pc.connectionState !== 'connected') return;
  const el = $('connInfo');
  if (!el) return;
  try {
    const stats = await pc.getStats();
    let pair = null;
    const locals = {}, remotes = {};
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.nominated)) pair = s;
      else if (s.type === 'local-candidate') locals[s.id] = s;
      else if (s.type === 'remote-candidate') remotes[s.id] = s;
    });
    if (!pair) { el.textContent = encLabel(); return; }
    const lt = (locals[pair.localCandidateId] || {}).candidateType;
    const rt = (remotes[pair.remoteCandidateId] || {}).candidateType;
    const path = connPathLabel(lt, rt);
    const rtt = typeof pair.currentRoundTripTime === 'number'
      ? ' · ' + Math.round(pair.currentRoundTripTime * 1000) + ' ms' : '';
    el.textContent = encLabel() + (path ? ' · ' + path : '') + rtt;
  } catch (e) { /* getStats unsupported — badge stays as-is */ }
}
function startConnStats() {
  stopConnStats();
  sampleConnStats();
  statsTimer = setInterval(sampleConnStats, 2000);
  startHud();
}
function stopConnStats() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  const el = $('connInfo');
  if (el) el.textContent = '';
  stopHud();
}

let hudTimer = null, hudLast = null;
const hudSamples = [];
function startHud() {
  if (hudTimer) clearInterval(hudTimer);
  hudLast = { t: Date.now(), tx: txBytes, rx: rxBytes };
  hudTimer = setInterval(sampleHud, 500);
}
function stopHud() {
  if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
  hudSamples.length = 0;
  const h = $('hud');
  if (h) h.classList.add('hidden');
}
function sampleHud() {
  if (!hudLast) return;
  const now = Date.now();
  const dt = (now - hudLast.t) / 1000;
  if (dt <= 0) return;
  const up = (txBytes - hudLast.tx) / dt;
  const dn = (rxBytes - hudLast.rx) / dt;
  hudLast = { t: now, tx: txBytes, rx: rxBytes };
  hudSamples.push({ up, dn });
  if (hudSamples.length > 48) hudSamples.shift();
  const hud = $('hud');
  if (!hud) return;
  const busy = up > 0 || dn > 0 || sending || !!incoming;
  hud.classList.toggle('hidden', !busy);
  if (!busy) return;
  const txt = $('hudText');
  if (txt) txt.textContent = '↑ ' + fmtSpeed(up) + '   ↓ ' + fmtSpeed(dn);
  drawHud();
}
function drawHud() {
  const cv = $('hudCanvas');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  let max = 1048576;
  hudSamples.forEach((s) => { max = Math.max(max, s.up, s.dn); });
  const line = (key, color) => {
    if (hudSamples.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    hudSamples.forEach((s, i) => {
      const x = (i / 47) * W;
      const y = H - 3 - (Math.min(s[key], max) / max) * (H - 8);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  line('up', '#10b981');
  line('dn', '#38bdf8');
}

/* ---------- camera QR scanner ----------
   Scans the other device's share-code QR (Join) or its reply-code QR (Host).
   Detection uses the platform BarcodeDetector — where it doesn't exist
   (Safari/Firefox today) the modal says so and pasting the code remains the
   path. The camera opens only on an explicit scan tap. */
let scanStream = null, scanTimer = null, scanMode = null, scanDetector = null;
function scanSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.BarcodeDetector);
}
async function startScan(mode) {
  scanMode = mode;
  const note = $('scanNote');
  const video = $('scanVideo');
  $('scanModal').classList.remove('hidden');
  if (!scanSupported()) {
    video.style.display = 'none';
    note.textContent = "Live camera scanning isn't supported in this browser — paste the code instead, it works the same.";
    return;
  }
  video.style.display = '';
  note.textContent = 'Point the camera at the other device’s QR code…';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    note.textContent = 'Camera unavailable — check the browser’s camera permission, or paste the code instead.';
    return;
  }
  video.srcObject = scanStream;
  try { await video.play(); } catch (e) { /* preview only */ }
  if (!scanDetector) {
    try { scanDetector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { scanDetector = null; }
  }
  if (!scanDetector) {
    note.textContent = 'QR detection is unavailable here — paste the code instead.';
    stopScanTracks();
    return;
  }
  const tick = async () => {
    if (!scanStream) return;
    try {
      const codes = await scanDetector.detect(video);
      if (codes && codes.length && codes[0].rawValue) {
        const text = codes[0].rawValue;
        stopScan();
        handleScanned(text, scanMode);
        return;
      }
    } catch (e) { /* frame not ready — keep scanning */ }
    scanTimer = setTimeout(tick, 250);
  };
  tick();
}
function stopScanTracks() {
  if (scanStream) {
    scanStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    scanStream = null;
  }
  const v = $('scanVideo');
  if (v) v.srcObject = null;
}
function stopScan() {
  clearTimeout(scanTimer);
  scanTimer = null;
  stopScanTracks();
  $('scanModal').classList.add('hidden');
}
function handleScanned(text, mode) {
  text = String(text || '').trim();
  if (!text) return;
  if (mode === 'host') {
    $('hostAnswer').value = text;
    $('btnConnect').click();
  } else {
    $('joinCode').value = text;
    $('btnMakeReply').click();
  }
}

/* ---------- Nearby devices (v21, simplified tap-to-connect) ----------
   Restores device discovery WITHOUT restoring v19 wholesale. Differences
   from v19, on purpose: no radar, no ringtone, no vibration, no known
   devices, no auto-accept, no QR invite, no private mode. The panel is
   just: a list of other devices + tap + an Accept/Decline modal.
   Protocol (matches the running matchmaker, same envelopes v19 used):
   client -> server: {t:'register', id, name}, {t:'heartbeat'},
     {t:'signal', to, payload}; server -> client: {t:'roster', devices},
     {t:'signal', from, fromName, payload}, {t:'error', msg}.
   Signal payload kinds: offer / answer / ice / declined. The server only
   introduces devices; files and messages still travel directly over
   WebRTC, exactly as in v20, and this section never touches the transfer
   code, E2EE, OPFS, checksums, TURN settings, or Share/Receive codes.
   The socket is only for introductions. If it cannot connect, the panel
   says so plainly and points at the codes below — never a fake list.
   v21.1: ICE is queued before Accept / before a remote description and
   flushed after setRemoteDescription (see nearbyPeer / nearbyIceQueue),
   and the caller status says it is waiting for Accept — discovery alone
   is never a connection, and there is no auto-connect. */
const NEARBY_SERVER = 'wss://localdrop-l8ly.onrender.com';
const NEARBY_FALLBACK = 'Nearby unavailable — use Share/Receive codes below';
const LS_NB_ID = 'ld_id', LS_NB_NAME = 'ld_name';
let nearbySocket = null, nearbyGen = 0, nearbyTimer = null, nearbyWakeTimer = null, nearbyHbTimer = null;
let nearbyBackoff = 2000, nearbyFailures = 0, nearbyRoster = [];
let nearbyMyId = null, nearbyMyName = '';
let nearbyOutgoing = null, nearbyIncoming = null;
/* v21.1: persistent peer for the whole call, plus an ICE queue.
   Bug fixed here: caller ICE used to be dropped twice — before Accept
   (no peer connection yet, and the handler required pc) and after Accept
   (Accept cleared nearbyIncoming, so the handler matched neither side).
   nearbyPeer is set at call start / at Accept and cleared only when the
   call ends, connects, fails, declines, or cancels. ICE that arrives
   before a peer connection or before its remote description is set is
   queued in order and flushed after setRemoteDescription, never dropped. */
let nearbyPeer = null;
let nearbyIceQueue = [];
/* v21.2: connection diagnostics, shown in plain words under the Nearby
   list while a call is pending or after it fails. This is the only way
   to tell the three failure modes apart from the user's side: (a) no
   remote candidates ever arrived (signalling/queue problem), (b)
   candidates arrived but ICE never completed (direct path blocked and
   no relay candidate gathered), (c) a relay candidate was gathered but
   still failed. Never a fake badge: it only reports what was observed. */
let nbDiag = null;
function nbDiagReset() {
  nbDiag = { ice: 'new', local: [], remote: 0, remoteTypes: [], failed: false };
  nbDiagRender();
}
function nbCandType(c) {
  const s = String((c && c.candidate) || c || '');
  const m = s.match(/ typ (host|srflx|prflx|relay) /);
  return m ? m[1] : 'unknown';
}
function nbRecordLocal(c) {
  if (!nbDiag) nbDiagReset();
  const t = nbCandType(c);
  if (!nbDiag.local.includes(t)) nbDiag.local.push(t);
  nbDiagRender();
}
function nbRecordRemote(c) {
  if (!nbDiag) nbDiagReset();
  nbDiag.remote += 1;
  const t = nbCandType(c);
  if (!nbDiag.remoteTypes.includes(t)) nbDiag.remoteTypes.push(t);
  nbDiagRender();
}
function nbDiagRender() {
  const el = $('nbDiag');
  if (!el) return;
  if (!nbDiag || (nbDiag.local.length === 0 && nbDiag.remote === 0 && nbDiag.ice === 'new' && !nbDiag.failed)) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const relay = nbDiag.local.includes('relay') ? 'yes' : 'no';
  el.textContent = 'Connection details: ICE ' + nbDiag.ice +
    ' · your candidates: ' + (nbDiag.local.length ? nbDiag.local.join(', ') : 'none yet') +
    ' · their candidates: ' + nbDiag.remote + (nbDiag.remoteTypes.length ? ' (' + nbDiag.remoteTypes.join(', ') + ')' : '') +
    ' · relay candidate: ' + relay;
}

function nearbyGetId() {
  let id = storeGet(LS_NB_ID);
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (uid() + uid());
    storeSet(LS_NB_ID, id);
  }
  return id;
}
function nearbySuggestName(ua) {
  ua = String(ua || '').toLowerCase();
  const base = /iphone|ipad|ipod/.test(ua) ? 'iPhone'
    : /android/.test(ua) ? 'Android' : 'Computer';
  return base + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}
/* Pure roster rule: drop ourselves and entries without an id, then
   same-network devices first, then alphabetical by name. */
function nearbySort(devices, selfId) {
  return (devices || [])
    .filter((d) => d && typeof d.id === 'string' && d.id && d.id !== selfId)
    .slice()
    .sort((a, b) => {
      if (!!a.nearby !== !!b.nearby) return a.nearby ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
}
/* Pure panel copy, so the fallback wording is one constant, not scattered. */
function nearbyStatusText(state, name) {
  if (state === 'waking') return 'Server waking up — free server sleeps, can take 30–60s the first time today';
  if (state === 'empty') return 'No other devices yet — open this page on the other device';
  if (state === 'unavailable') return NEARBY_FALLBACK;
  if (state === 'ready') return 'Tap a device to connect.';
  if (state === 'calling') return 'Calling ' + String(name || 'device') + '… — waiting for Accept on ' + String(name || 'device');
  if (state === 'connecting') return 'Connecting to ' + String(name || 'device') + '… — please wait, do not tap again';
  return 'Looking for devices…';
}
function showNearbyState(state, name) {
  const el = $('nearbyStatus');
  if (el) el.textContent = nearbyStatusText(state, name);
}
function nearbySend(o) {
  if (nearbySocket && nearbySocket.readyState === 1) {
    try { nearbySocket.send(JSON.stringify(o)); } catch (e) { /* noop */ }
  }
}
function nearbyRegister() {
  nearbySend({ t: 'register', id: nearbyMyId, name: nearbyMyName });
}
/* Route an incoming ICE candidate: add it once the peer connection has
   a remote description, otherwise queue it in order for the flush after
   setRemoteDescription. Candidates from anyone who is not the current
   peer / pending caller / pending callee are ignored, never queued. */
function nearbyAddOrQueueIce(from, candidate) {
  if (!candidate) return;
  const isPeer = (nearbyPeer && nearbyPeer.id === from) ||
    (nearbyOutgoing && nearbyOutgoing.id === from) ||
    (nearbyIncoming && nearbyIncoming.from === from);
  if (!isPeer) return;
  nbRecordRemote(candidate);
  if (pc && pc.remoteDescription) {
    pc.addIceCandidate(candidate).catch(() => {});
  } else {
    nearbyIceQueue.push({ from, candidate });
  }
}
async function nearbyFlushIceQueue() {
  const q = nearbyIceQueue;
  nearbyIceQueue = [];
  for (const item of q) {
    try { if (pc) await pc.addIceCandidate(item.candidate); } catch (e) { /* noop */ }
  }
}
function renderNearby() {
  const list = $('nearbyList');
  if (!list) return;
  // Not yet connected to the matchmaker: keep the looking/waking status
  // and show no list, rather than flashing "no devices" during connect.
  if (!nearbySocket || nearbySocket.readyState !== 1) { list.innerHTML = ''; return; }
  // v21.2: a callee that has Accepted is still in a pending call (nearbyPeer
  // set, no outgoing/incoming left). Treat it as busy, or a second tap
  // would tear down the call in progress and the user would see an
  // endless "connecting…" loop of their own making.
  const nearbyPending = !!nearbyPeer && !!pc && pc.connectionState !== 'connected';
  if (nearbyOutgoing) { showNearbyState('calling', nearbyOutgoing.name); }
  else if (nearbyIncoming) { /* modal is open; leave the panel status alone */ }
  else if (nearbyPending) { showNearbyState('connecting', nearbyPeer.name); }
  else {
    const devs = nearbySort(nearbyRoster, nearbyMyId);
    showNearbyState(devs.length ? 'ready' : 'empty');
  }
  const devs = nearbySort(nearbyRoster, nearbyMyId);
  list.innerHTML = devs.map((d) => {
    const busy = !!nearbyOutgoing || !!nearbyIncoming || nearbyPending;
    const callingThis = nearbyOutgoing && nearbyOutgoing.id === d.id;
    const disabled = busy && !callingThis ? ' disabled' : '';
    const label = callingThis ? ' — Calling… tap again to cancel' : (d.nearby ? ' · Same network' : '');
    return '<button class="devbtn" type="button" data-peer="' + esc(d.id) + '"' + disabled + '>' +
      '<span class="devname">' + esc(String(d.name || 'Unknown device').slice(0, 32)) + '</span>' +
      '<span class="devtag">' + esc(label) + '</span></button>';
  }).join('');
  list.querySelectorAll('[data-peer]').forEach((b) => {
    b.addEventListener('click', () => {
      const dev = devs.find((d) => d.id === b.getAttribute('data-peer'));
      if (dev) nearbyCall(dev.id, dev.name);
    });
  });
}
/* Clear only the call refs (used when a call connects, or when the user
   navigates back). Never closes a live peer connection. */
function nearbyClearCallRefs() {
  nearbyOutgoing = null;
  nearbyIncoming = null;
  nearbyPeer = null;
  nearbyIceQueue = [];
  const m = $('nearbyModal');
  if (m) m.classList.add('hidden');
}
/* End a pending call cleanly: release the peer connection so a second
   tap can start fresh, and say what happened instead of hanging. */
function endNearbyCall(msg) {
  if (!nearbyOutgoing && !nearbyIncoming && !nearbyPeer && !pc) return;
  if (nbDiag) { nbDiag.failed = true; nbDiag.ice = 'failed'; }
  nearbyClearCallRefs();
  teardown();
  setStatus('bad', msg);
  nbDiagRender();
}
/* Nearby-only connect timer: unlike v20's code-path timer, its message
   never mentions codes as the cause — it points at codes as the fallback.
   v20's wireDC clears connectTimer on channel open, so this timer dies
   on a successful connect without any extra wiring. */
function nearbyWatch(ms) {
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if ((nearbyPeer || nearbyOutgoing || nearbyIncoming) && pc && pc.connectionState !== 'connected') {
      endNearbyCall("couldn't connect — try again, or use a Share/Receive code below");
    }
  }, ms);
}
/* Wrap v20's connection-state handler without editing it: on 'connected'
   the call is done (clear refs); on 'failed' while a call is pending,
   release everything so the user can tap again. */
function nearbyWrapPC() {
  if (!pc) return;
  const prev = pc.onconnectionstatechange;
  pc.onconnectionstatechange = () => {
    if (prev) prev();
    if (!pc) return;
    if (pc.connectionState === 'connected') nearbyClearCallRefs();
    else if (pc.connectionState === 'failed' && (nearbyPeer || nearbyOutgoing || nearbyIncoming)) {
      endNearbyCall("couldn't connect");
    }
  };
}
function nearbyConnect() {
  nearbyGen += 1;
  const gen = nearbyGen;
  clearTimeout(nearbyTimer);
  clearTimeout(nearbyWakeTimer);
  clearInterval(nearbyHbTimer);
  try { if (nearbySocket) nearbySocket.close(); } catch (e) { /* noop */ }
  nearbySocket = null;
  nearbyRoster = [];
  renderNearby();
  showNearbyState('looking');
  // The free server sleeps when idle — say so at 8s instead of looking stuck.
  nearbyWakeTimer = setTimeout(() => {
    if (gen === nearbyGen && nearbySocket && nearbySocket.readyState === 0) {
      showNearbyState('waking');
    }
  }, 8000);
  let ws;
  try { ws = new WebSocket(NEARBY_SERVER); } catch (e) { nearbyRetry(gen); return; }
  nearbySocket = ws;
  ws.onopen = () => {
    if (gen !== nearbyGen) { try { ws.close(); } catch (e) { /* noop */ } return; }
    clearTimeout(nearbyWakeTimer);
    nearbyBackoff = 2000;
    nearbyFailures = 0;
    showNearbyState('looking');
    nearbyRegister();
    clearInterval(nearbyHbTimer);
    nearbyHbTimer = setInterval(() => nearbySend({ t: 'heartbeat' }), 25000);
  };
  ws.onmessage = (e) => { if (gen === nearbyGen) handleNearbyMessage(e.data); };
  ws.onerror = () => { /* onclose follows with the retry */ };
  ws.onclose = () => {
    if (gen !== nearbyGen) return;
    clearTimeout(nearbyWakeTimer);
    clearInterval(nearbyHbTimer);
    if (nearbyOutgoing) endNearbyCall('matchmaker disconnected');
    if (nearbyPeer && pc && pc.connectionState !== 'connected') endNearbyCall('matchmaker disconnected');
    if (nearbyIncoming) {
      nearbyIncoming = null;
      const m = $('nearbyModal');
      if (m) m.classList.add('hidden');
      setStatus('idle', 'not connected');
    }
    nearbyRoster = [];
    renderNearby();
    nearbyFailures += 1;
    if (nearbyFailures >= 3) showNearbyState('unavailable');
    nearbyRetry(gen);
  };
}
function nearbyRetry(gen) {
  clearTimeout(nearbyTimer);
  if (gen !== nearbyGen) return;
  nearbyTimer = setTimeout(() => { if (gen === nearbyGen) nearbyConnect(); }, Math.min(nearbyBackoff, 30000));
  nearbyBackoff *= 2;
}
function handleNearbyMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'roster' && Array.isArray(m.devices)) {
    nearbyRoster = m.devices;
    renderNearby();
  } else if (m.t === 'signal' && m.payload) {
    handleNearbySignal(m.from, m.fromName || 'Unknown device', m.payload);
  } else if (m.t === 'error' && m.msg) {
    if (nearbyOutgoing) {
      endNearbyCall(m.msg === 'device is offline' ? 'device is offline' : "couldn't connect");
    }
  }
}
function nearbyValidPayload(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.kind === 'declined') return true;
  if (p.kind === 'ice') return p.candidate === null || typeof p.candidate === 'object';
  if (p.kind === 'offer' || p.kind === 'answer') return nearbySdp(p.sdp).slice(0, 3) === 'v=0';
  return false;
}
function nearbySdp(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v.sdp === 'string') return v.sdp;
  return '';
}
/* Tap a device. Tapping the device you are already calling cancels the call. */
function nearbyCall(id, name) {
  if (nearbyIncoming) return;
  // v21.2: do not start a second call while an Accepted call is still
  // connecting — newPC() would tear the first call down.
  if (nearbyPeer && pc && pc.connectionState !== 'connected') return;
  if (nearbyOutgoing) {
    if (nearbyOutgoing.id === id) {
      nearbySend({ t: 'signal', to: id, payload: { kind: 'declined' } });
      endNearbyCall('cancelled');
    }
    return;
  }
  if (dc && dc.readyState === 'open') return;
  nbDiagReset();
  newPC();
  nearbyWrapPC();
  nearbyOutgoing = { id, name };
  nearbyPeer = { id, name };
  dc = pc.createDataChannel('localdrop', { ordered: true });
  wireDC();
  setStatus('idle', 'calling ' + name + '… — waiting for Accept on ' + name);
  showNearbyState('calling', name);
  renderNearby();
  pc.onicecandidate = (e) => {
    if (e.candidate) { nbRecordLocal(e.candidate); nearbySend({ t: 'signal', to: id, payload: { kind: 'ice', candidate: e.candidate } }); }
  };
  (async () => {
    try {
      await pc.setLocalDescription(await pc.createOffer());
      nearbySend({ t: 'signal', to: id, payload: { kind: 'offer', sdp: pc.localDescription.sdp } });
      nearbyWatch(20000);
    } catch (e) { endNearbyCall("couldn't start the call"); }
  })();
}
function handleNearbySignal(from, fromName, p) {
  if (!nearbyValidPayload(p)) return;
  if (p.kind === 'offer') {
    if (nearbyOutgoing || nearbyIncoming || (dc && dc.readyState === 'open')) {
      nearbySend({ t: 'signal', to: from, payload: { kind: 'declined' } }); // busy
      return;
    }
    nearbyIncoming = { from, fromName, sdp: p.sdp };
    const title = $('nearbyCaller');
    if (title) title.textContent = fromName + ' wants to connect';
    const m = $('nearbyModal');
    if (m) {
      m.classList.remove('hidden');
      const acc = $('nearbyAccept');
      if (acc && acc.focus) { try { acc.focus(); } catch (e) { /* noop */ } }
    }
  } else if (p.kind === 'answer') {
    if (nearbyOutgoing && nearbyOutgoing.id === from && pc) {
      const sdp = nearbySdp(p.sdp);
      if (!sdp) { endNearbyCall("couldn't connect"); return; }
      pc.setRemoteDescription({ type: 'answer', sdp })
        .then(() => { nearbyFlushIceQueue(); })
        .catch(() => endNearbyCall("couldn't connect"));
    }
  } else if (p.kind === 'ice') {
    nearbyAddOrQueueIce(from, p.candidate);
  } else if (p.kind === 'declined') {
    if (nearbyOutgoing && nearbyOutgoing.id === from) {
      endNearbyCall(fromName + ' declined');
    } else if (nearbyIncoming && nearbyIncoming.from === from) {
      nearbyIncoming = null;
      nearbyPeer = null;
      nearbyIceQueue = [];
      const m = $('nearbyModal');
      if (m) m.classList.add('hidden');
      setStatus('idle', 'not connected');
    }
  }
}
async function nearbyAccept() {
  const inv = nearbyIncoming;
  nearbyIncoming = null;
  const m = $('nearbyModal');
  if (m) m.classList.add('hidden');
  if (!inv) return;
  // Persistent peer BEFORE the connection starts, so ICE that arrives
  // from this caller after Accept is routed, not dropped.
  nearbyPeer = { id: inv.from, name: inv.fromName };
  nbDiagReset();
  newPC();
  nearbyWrapPC();
  setStatus('idle', 'connecting…');
  renderNearby();
  pc.onicecandidate = (e) => {
    if (e.candidate) { nbRecordLocal(e.candidate); nearbySend({ t: 'signal', to: inv.from, payload: { kind: 'ice', candidate: e.candidate } }); }
  };
  try {
    const offerSdp = nearbySdp(inv.sdp);
    if (!offerSdp) throw new Error('bad offer sdp');
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    // Flush ICE queued while the offer was waiting for Accept, in order.
    await nearbyFlushIceQueue();
    await pc.setLocalDescription(await pc.createAnswer());
    nearbySend({ t: 'signal', to: inv.from, payload: { kind: 'answer', sdp: pc.localDescription.sdp } });
    nearbyWatch(20000);
  } catch (e) { endNearbyCall("couldn't connect"); }
}
function nearbyDecline() {
  const inv = nearbyIncoming;
  nearbyIncoming = null;
  nearbyPeer = null;
  nearbyIceQueue = [];
  const m = $('nearbyModal');
  if (m) m.classList.add('hidden');
  if (inv) nearbySend({ t: 'signal', to: inv.from, payload: { kind: 'declined' } });
  setStatus('idle', 'not connected');
}
function initNearby() {
  nearbyMyId = nearbyGetId();
  nearbyMyName = storeGet(LS_NB_NAME) || '';
  if (!nearbyMyName) {
    nearbyMyName = nearbySuggestName(navigator.userAgent || '');
    storeSet(LS_NB_NAME, nearbyMyName);
  }
  const acc = $('nearbyAccept');
  if (acc) acc.addEventListener('click', nearbyAccept);
  const dec = $('nearbyDecline');
  if (dec) dec.addEventListener('click', nearbyDecline);
  const modal = $('nearbyModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) nearbyDecline(); });
  // Navigating away from a call (e.g. disconnect) must not leave a stale
  // pending call blocking the next tap. This only clears refs — it never
  // closes a live connection, because v20's own handler already tore it down.
  document.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', nearbyClearCallRefs));
  nearbyConnect();
}

/* ---------- wiring ---------- */
watchForUpdates();
// camera QR scanner buttons (scanner itself lives in its section above)
$('btnScanJoin').addEventListener('click', () => startScan('join'));
$('btnScanHost').addEventListener('click', () => startScan('host'));
$('scanCancel').addEventListener('click', stopScan);
$('scanModal').addEventListener('click', (e) => { if (e.target === $('scanModal')) stopScan(); });
initTurnSettings();
initNearby();
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
$('folderInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  files.forEach((f) => { f._ldPath = f.webkitRelativePath || f.name; enqueueFile(f); });
  if (files.length) sysMsg('Sending folder (' + files.length + ' files)…');
  e.target.value = '';
});
$('btnClip').addEventListener('click', sendClipboard);
$('btnDlAll').addEventListener('click', downloadAll);
$('btnShareAll').addEventListener('click', shareAll);
document.addEventListener('paste', (e) => {
  if ($('view-chat').classList.contains('hidden')) return;
  const files = (e.clipboardData && e.clipboardData.files) || [];
  Array.from(files).forEach(enqueueFile);
});

/* ---------- drag & drop send (desktop: drag files onto the chat) ---------- */
(function initDropSend() {
  const chatView = $('view-chat');
  const overlay = $('dropOverlay');
  let dragDepth = 0;

  const chatVisible = () => !chatView.classList.contains('hidden');
  const live = () => dc && dc.readyState === 'open';
  const hasFiles = (e) =>
    !!(e.dataTransfer && e.dataTransfer.types &&
       Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1);

  // Never let a dropped file navigate the browser away — even outside chat.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!chatVisible()) e.preventDefault();
  });

  chatView.addEventListener('dragenter', (e) => {
    if (!chatVisible() || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (live()) overlay.classList.remove('hidden');
  });
  chatView.addEventListener('dragover', (e) => {
    if (chatVisible()) e.preventDefault(); // must cancel to allow the drop
  });
  chatView.addEventListener('dragleave', (e) => {
    if (!chatVisible() || !hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add('hidden');
  });
  chatView.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    if (!chatVisible()) return;
    if (!live()) {
      sysMsg('Not connected — connect first, then drop files here to send them.');
      return;
    }
    const dt = e.dataTransfer;
    const items = dt && dt.items ? Array.from(dt.items) : [];
    // Folders (and files) via the FileSystem API — preserves folder structure
    if (items.length && items.some((it) => entryOf(it))) {
      handleFolderDrop(items);
      return;
    }
    const files = Array.from((dt && dt.files) || []);
    if (!files.length) return;
    files.forEach(enqueueFile);
    sysMsg('Sending ' + files.length + (files.length === 1 ? ' file' : ' files') + '…');
  });
})();

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
