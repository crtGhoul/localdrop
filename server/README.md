# LocalDrop signaling server

The matchmaker behind LocalDrop's **tap-to-connect**. Devices check in over a
WebSocket, the server tracks who's online, and it forwards the WebRTC
handshake (offer / answer / ICE) between two devices so they can pair without
copying codes by hand.

## Privacy

This server **never sees your messages or files**. It only routes the
introduction — the equivalent of passing a phone number. The actual
conversation (data channel) goes directly between the two devices,
end-to-end encrypted with DTLS. The server holds no message history and
stores nothing on disk; the device registry lives in memory and entries
expire after ~75 seconds without a heartbeat.

## Run it locally

```bash
cd server
npm install
npm start        # listens on :3000 (or $PORT)
```

Health check: `GET /health` → `{ ok: true, clients: N }`.

## Deploy (free)

Easiest is Render's free tier — one click, no config:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/crtGhoul/localdrop)

1. Click the button above (or this one in the main README).
2. Create / sign in to a free Render account.
3. Render builds and starts the service from `server/` automatically.
4. Copy your service URL (e.g. `https://localdrop-signaling.onrender.com`),
   change `https://` to `wss://`, and paste it into the **Matchmaker server**
   field in the LocalDrop app's settings.

Note: free-tier services sleep after ~15 minutes idle, so the very first
connection of the day can take ~30 seconds while it wakes up. After that,
pairing is instant.

## Protocol (JSON over WebSocket)

Client → server:

| message | purpose |
|---|---|
| `{t:'register', id, name}` | check in (id is a per-device UUID, name ≤ 32 chars) |
| `{t:'heartbeat'}` | keep-alive, every 25 s |
| `{t:'signal', to, payload}` | forward `payload` to device `to`; `payload.kind` is `offer` / `answer` / `ice` / `declined` |

Server → client:

| message | purpose |
|---|---|
| `{t:'registered', id}` | registration confirmed |
| `{t:'roster', devices:[{id, name, nearby, lastSeen}]}` | who's online; `nearby` = same public IP as you. Pushed on every change |
| `{t:'signal', from, fromName, payload}` | forwarded handshake from another device |
| `{t:'error', msg}` | e.g. `device is offline` |
