/* LocalDrop signaling server — the "matchmaker" for tap-to-connect.
 *
 * What it does:
 *  - keeps a registry of online devices (id, name, public IP, last heartbeat)
 *  - pushes each client a roster of who's online, marking devices on the
 *    same public IP as "nearby"
 *  - forwards WebRTC handshake envelopes (offer / answer / ICE / declined)
 *    between two devices so they can connect without manual codes
 *
 * What it NEVER sees: message text, file bytes, or anything sent over the
 * WebRTC data channel. That traffic goes directly between the two devices,
 * end-to-end encrypted (DTLS). This server only routes the introduction.
 */
'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const HEARTBEAT_MS = 25 * 1000;
const TIMEOUT_MS = 75 * 1000;   // drop clients silent longer than this
const SWEEP_MS = 30 * 1000;
const MAX_NAME = 32;
const MAX_CLIENTS = 500;

/* ---------- pure helpers (unit-tested) ---------- */

/* Strip the ::ffff: prefix Node adds for IPv4-mapped IPv6 addresses. */
function normalizeIp(ip) {
  if (!ip) return '';
  return String(ip).replace(/^::ffff:/, '');
}

/* Best-effort client IP: first entry of x-forwarded-for (set by proxies
   like Render), else the raw socket address. */
function clientIp(req, socket) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return normalizeIp(String(fwd).split(',')[0].trim());
  return normalizeIp(socket && socket.remoteAddress);
}

/* A device is "nearby" another when both arrive from the same public IP
   (i.e. behind the same home/office router). */
function isNearby(aIp, bIp) {
  return !!aIp && aIp === bIp;
}

/* Roster for one recipient: everyone except self, with a per-recipient
   `nearby` flag. `registry` maps id -> {id, name, ip, lastSeen}. */
function buildRoster(registry, selfId, selfIp) {
  const out = [];
  for (const [id, d] of registry) {
    if (id === selfId) continue;
    out.push({ id, name: d.name, nearby: isNearby(d.ip, selfIp), lastSeen: d.lastSeen });
  }
  return out;
}

/* SDP may arrive as a bare string or as a serialized RTCSessionDescription
   ({type, sdp}) — accept either as long as it looks like real SDP. */
function sdpText(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v.sdp === 'string') return v.sdp;
  return '';
}

/* Validate an inbound {t:'signal'} message. Returns an error string or ''. */
function validateSignal(msg) {
  if (!msg || typeof msg !== 'object') return 'bad message';
  if (typeof msg.to !== 'string' || !msg.to) return 'missing recipient';
  const p = msg.payload;
  if (!p || typeof p !== 'object') return 'missing payload';
  const kinds = ['offer', 'answer', 'ice', 'declined'];
  if (!kinds.includes(p.kind)) return 'unknown signal kind';
  if ((p.kind === 'offer' || p.kind === 'answer') && sdpText(p.sdp).slice(0, 3) !== 'v=0')
    return 'offer/answer needs sdp';
  if (p.kind === 'ice' && p.candidate !== null && typeof p.candidate !== 'object')
    return 'ice needs a candidate';
  return '';
}

/* ---------- server ---------- */

function startServer(port) {
  const clients = new Map(); // id -> {id, name, ip, ws, lastSeen}

  function broadcastRoster() {
    for (const [id, c] of clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      c.ws.send(JSON.stringify({ t: 'roster', devices: buildRoster(clients, id, c.ip) }));
    }
  }

  function dropIdle() {
    const now = Date.now();
    let changed = false;
    for (const [id, c] of clients) {
      if (now - c.lastSeen > TIMEOUT_MS) {
        try { c.ws.close(); } catch (e) { /* noop */ }
        clients.delete(id);
        changed = true;
      }
    }
    if (changed) broadcastRoster();
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: clients.size }));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('LocalDrop signaling server — connect over WebSocket.');
    }
  });

  const wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req, ws._socket);
    let myId = null;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'register') {
        if (typeof msg.id !== 'string' || !msg.id || clients.size >= MAX_CLIENTS) {
          ws.send(JSON.stringify({ t: 'error', msg: 'registration rejected' }));
          return;
        }
        myId = msg.id;
        const name = String(msg.name || 'Unknown device').slice(0, MAX_NAME) || 'Unknown device';
        clients.set(myId, { id: myId, name, ip, ws, lastSeen: Date.now() });
        ws.send(JSON.stringify({ t: 'registered', id: myId }));
        broadcastRoster();
      } else if (msg.t === 'heartbeat') {
        const c = myId && clients.get(myId);
        if (c) c.lastSeen = Date.now();
      } else if (msg.t === 'signal') {
        const err = validateSignal(msg);
        if (err || !myId) {
          ws.send(JSON.stringify({ t: 'error', msg: err || 'register first' }));
          return;
        }
        const target = clients.get(msg.to);
        if (!target || target.ws.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'error', msg: 'device is offline' }));
          return;
        }
        const me = clients.get(myId);
        target.ws.send(JSON.stringify({
          t: 'signal',
          from: myId,
          fromName: me ? me.name : 'Unknown device',
          payload: msg.payload,
        }));
      }
    });

    ws.on('close', () => {
      if (myId && clients.get(myId) && clients.get(myId).ws === ws) {
        clients.delete(myId);
        broadcastRoster();
      }
    });
  });

  const sweep = setInterval(dropIdle, SWEEP_MS);
  httpServer.listen(port, () => {
    console.log('LocalDrop signaling on :' + port);
  });

  return {
    close(cb) { clearInterval(sweep); httpServer.close(cb); },
    _clients: clients,
    _http: httpServer,
  };
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = { normalizeIp, clientIp, isNearby, buildRoster, validateSignal, startServer };
