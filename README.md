# 📡 LocalDrop

A LocalSend-style web app: send **photos, files, text messages and links** between
nearby devices. No signup, no server, no app install — just open the page on both
devices. Everything travels peer-to-peer and encrypted over WebRTC.

## How pairing works

GitHub Pages only hosts static files, so there's no server to do automatic
device discovery like the native LocalSend app. Instead, pairing uses a quick
code exchange (one time per session):

1. Device A taps **Share** → gets a code + QR code.
2. Device B taps **Receive**, scans/pastes A's code → gets a reply code.
3. Device A pastes B's reply code → **connected**. Chat away.

## Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `localdrop`).
2. Upload all files (`index.html`, `styles.css`, `app.js`, `manifest.json`, `sw.js`, and the `.png` icons) to the repo root.
3. Repo **Settings → Pages** → Source: **Deploy from a branch**,
   Branch: `main`, Folder: `/ (root)` → Save.
4. Open `https://<your-username>.github.io/<repo>/` on both devices.

That's it — no build step, it's pure static HTML/CSS/JS.

### The site doesn't update instantly

After you push new files, GitHub Pages has to rebuild and deploy the site —
this usually takes **a minute or two**, but can be longer when GitHub is busy.
To check progress: open your repo → **Actions** tab → the latest
*pages build and deployment* run, or **Settings → Pages** shows the last
deployed commit. Wait for it to finish, then refresh the page on your devices.

If the old version hangs around after a deploy:

- **Hard-refresh:** hold the refresh icon on mobile Safari, or Ctrl/Cmd+Shift+R
  on desktop.
- **Service worker cache:** this app caches itself for offline use. If a hard
  refresh doesn't work, close every LocalDrop tab/window on the device and
  reopen — that lets the new service worker take over.

## Install as an app (PWA)

LocalDrop is installable, so it feels like the real store app:

- **Android (Chrome):** open the site → tap the **⬇ Install app** button
  (or ⋮ menu → Install / Add to Home screen).
- **iPhone (Safari):** Share → **Add to Home Screen**.
- Once installed it opens fullscreen from your home screen, and the service
  worker caches the app shell — it keeps working on your local network even
  if the internet drops.

## Notes

- Both devices need to be able to reach each other (same Wi-Fi is the easy case).
- The page itself needs internet once to load (it's hosted on GitHub Pages);
  the actual file/message transfer then goes direct between devices.
- Files are streamed in 16 KB chunks over an ordered, reliable data channel with
  backpressure, so large files are fine.

## Tap-to-connect server

Tired of copying codes? Run the tiny **matchmaker server** in `server/` and
the app shows a **Nearby & ready** list — tap a device to connect. Devices
you've connected to are remembered under **Known devices**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/crtGhoul/localdrop)

1. Click **Deploy to Render** above.
2. Create (or sign in to) a free Render account — it builds and starts the
   server automatically.
3. Copy your service URL (looks like
   `https://localdrop-signaling.onrender.com`), change `https://` to `wss://`,
   and paste it into the **Matchmaker server** field in the app's settings.

Heads-up: free-tier servers sleep after ~15 minutes idle, so the first
connection of the day can take ~30 seconds while it wakes up. After that,
pairing is instant.

**Keeping the server updated:** the app on GitHub Pages updates itself, but
the server on Render only picks up new code when Render redeploys it. If you
connected the Render service to this GitHub repo, it redeploys automatically
on every push — check the Render dashboard to confirm the latest deploy
finished. If it didn't, use **Manual Deploy → Deploy latest commit**. You can
check the app side any time under ⚙️ Matchmaker server → **App version** at
the bottom of the settings.

**Privacy:** the server never sees your messages or files — it only passes
along the connection setup (like exchanging phone numbers). The actual
transfer goes directly between your devices, end-to-end encrypted.

No server? The manual Share / Receive code flow keeps working exactly as
before.

## If connecting fails

- **"Matchmaker: offer/answer needs sdp"?** Your Render server is running old
  code — redeploy it (see "Keeping the server updated" above), then try the
  call again.
- **Calls never arrive on the other device?** Make sure both devices show the
  same **App version** (⚙️ Matchmaker server → bottom of the settings). If one
  is behind, close all its LocalDrop tabs and reopen it.
- **Both devices on the same Wi-Fi** — that's the fast, reliable path.
- **Codes are single-use.** If you tap Share again, the old codes stop working —
  generate fresh ones on both sides.
- **Copy the FULL code.** They're long; use the Copy button rather than
  retyping. If a code doesn't look right, the app will tell you instead of
  hanging.
- If one device is on mobile data and the other on Wi-Fi, the app falls back
  to a relay server automatically — it may just take a few seconds longer.
