# 📡 LocalDrop

**Current version: v21.3**

A LocalSend-style web app: send **photos, files, text messages and links** between
nearby devices. No signup, no account, no app install — just open the page on both
devices. Everything travels peer-to-peer and encrypted over WebRTC.

Live: [GitHub Pages](https://crtghoul.github.io/localdrop/) · [Cloudflare mirror](https://localdrop-mirror.pages.dev)

## Screenshots

_Coming soon — annotated screenshots and a short pairing walkthrough clip._

## How pairing works

GitHub Pages only hosts static files, so there's no server to do automatic
device discovery like the native LocalSend app. Pairing uses a quick
code exchange (one time per session) — **this is the proven path**:

1. Device A taps **Share** → gets a code + QR code.
2. Device B taps **Receive**, scans/pastes A's code → gets a reply code (+ its own QR).
3. Device A pastes B's reply code — or scans B's reply QR → **connected**. Chat away.

Scanning works two ways: your phone's camera app can read the QRs, and on
browsers with built-in QR detection (Chrome on Android/desktop) the
**📷 Scan** buttons inside LocalDrop use the camera directly. On browsers
without it (Safari, Firefox for now) the scan button says so and pasting the
code works exactly the same.

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
- Files are streamed in small chunks over an ordered, reliable data channel
  with event-driven backpressure (the sender never queues more than ~1 MB
  ahead of the wire), so large files are fine.
- **Huge files (10 GB+):** on the receiving side, files of 64 MB and up are
  streamed straight into the browser's private device storage (OPFS)
  chunk-by-chunk instead of accumulating in RAM — memory stays flat no
  matter the file size. Browsers without OPFS use the memory path instead,
  and if a storage write fails mid-transfer the file aborts with a clear
  note rather than corrupting silently. (A checksum is shown for files up
  to 512 MB; larger files skip it.)
- **End-to-end encrypted (v19):** on top of WebRTC's transport encryption,
  two current-version devices exchange ephemeral ECDH keys when the channel
  opens and encrypt every message and file chunk with AES-GCM before it
  touches the channel. The key is derived with a hash of the connection
  codes mixed in, lives only in memory, and dies with the connection —
  chats are ephemeral and never stored. Both devices display the same
  safety code so you can compare them out loud. Older versions connect
  exactly as before (transport encryption only) and the chat header says
  which mode you're in.
- **Prove it:** `node test/webrtc-rig.mjs 10240 chromium` runs two real
  browser pages through a real 10 GB transfer and prints measured
  throughput and peak sender memory (needs `npm i playwright-core` and a
  browser binary; on machines where UDP is blocked it reports the ICE
  failure instead of inventing numbers).
- **Drag & drop:** on a computer, drag files straight onto the chat while
  connected — they send immediately. You can also use the 📎 button or paste
  images from the clipboard.
- **Clipboard sync:** tap 📋 in the chat to shoot your clipboard (text, or an
  image like a screenshot) to the other device.
- **Folder send:** drag a whole folder onto the chat, or tap 📁 — every file
  inside is sent with its folder structure shown.
- **Approve incoming files:** the other side gets an Accept / Decline prompt
  before a file starts transferring (both devices on the latest version).
- **Cancel & speed:** transfers show live MB/s and can be cancelled mid-flight
  with the ✕ on the file card. While connected, the chat shows a live speed
  graph plus the real connection path (direct / relayed) and latency, read
  from WebRTC's own stats — nothing is estimated.
- **Checksum verified:** on the current version both sides compute a
  SHA-256 of each file; the receiver's card shows "✓ checksum verified"
  only when the bytes are identical to what the sender hashed.
- **Download all & share:** when you've received 2+ files, a **⬇ All** button
  in the chat header downloads everything at once as a single ZIP (folder
  structure preserved, no extra libraries). The **📤** button hands the files
  to your phone's share sheet instead — AirDrop, WhatsApp, whatever you use.

## Pairing — codes only (since v20)

LocalDrop pairs with the Share / Receive codes above — that is the whole
pairing story, and it needs no server at all. Chat and files still go
directly between your devices, end-to-end encrypted; if a direct connection
fails, traffic may relay via a public TURN server — still encrypted, but the
relay operator can see metadata (IPs, timing, volume).

(An experimental tap-to-connect matchmaker shipped in v17–v19 and was
removed in v20 — it never proved itself on real hardware the way the codes
did. Its code, including the tiny signaling server, remains in this repo's
history at tag `v19`.)

## If connecting fails

- **Both devices on the same Wi-Fi** — that's the fast, reliable path.
- **Codes are single-use.** If you tap Share again, the old codes stop working —
  generate fresh ones on both sides.
- **Copy the FULL code.** They're long; use the Copy button rather than
  retyping. If a code doesn't look right, the app will tell you instead of
  hanging.
- If one device is on mobile data and the other on Wi-Fi, the app falls back
  to a relay server automatically — it may just take a few seconds longer.

## License

GPL-3.0 — see [LICENSE](LICENSE).

---

## Velazquez Lab

More free tools from Cesar Velazquez: [Velazquez Lab](https://velazquez-lab.pages.dev)

- GitHub: https://github.com/crtGhoul
- Codeberg: https://codeberg.org/crtGhoul
- YouTube: https://www.youtube.com/@VelazquezLabs
- Reddit: https://www.reddit.com/user/Manteqaada/

> Have you used Muse? If not, you can earn a free 1B tokens when you sign up with my code: 0NS5DG — redeem it in Muse Settings > Redeem token within 48 hours of joining. Joining alone does not count.
