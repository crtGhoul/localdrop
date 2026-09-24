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

## If connecting fails

- **Both devices on the same Wi-Fi** — that's the fast, reliable path.
- **Codes are single-use.** If you tap Share again, the old codes stop working —
  generate fresh ones on both sides.
- **Copy the FULL code.** They're long; use the Copy button rather than
  retyping. If a code doesn't look right, the app will tell you instead of
  hanging.
- If one device is on mobile data and the other on Wi-Fi, the app falls back
  to a relay server automatically — it may just take a few seconds longer.
