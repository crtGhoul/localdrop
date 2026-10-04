# AGENTS.md — LocalDrop

Binding conventions for any agent working in this project.

## Scope & Project
- **Repo:** `crtGhoul/localdrop`
- **Path:** `C:\Users\velaz\localdrop`
- **Description:** Zero-install, peer-to-peer WebRTC file, message, and link transfer PWA for nearby devices.

## Landmines (Learned the hard way)
1. **Service Worker cache invalidation:** Any asset updates must cleanly bust cache or bump the cache version in `sw.js`. Never trap users on stale JS bundles.
2. **WebRTC connection states:** P2P signaling failures must fail honestly to a clear fallback state (no indefinite "connecting..." loops).
3. **Mobile responsive layout & touch targets:** Touch interactions must work cleanly on mobile Safari / Chrome Android viewports without pinching or zoom traps.

## Anti-Slop UI Filter
1. **Honesty first:** No fake connection badges, no fake progress bars, no invented transfer speeds.
2. **Quiet defaults:** One accent color. UI copy in plain sentences.
3. **Accessibility:** Proper labels, focus outlines, keyboard navigability.

## Your Edge (Windows Local Agent)
- You run on the real Windows PC with Playwright and local HTTP servers available.
- Launch the local server, drive transfer flows, emulate mobile viewports (iOS Safari / Android), and verify Service Worker registration for real.
- Label everything **VERIFIED** (ran and proved on this machine) vs **LOGIC-ONLY** (reasoned only, plus what would prove it).

## Operating Rules
- Laziest correct solution wins (reuse > stdlib > native > new dependency).
- Minimal diffs.
- Never cut tests, security validation, or accessibility.
- Never cut a release or git push unless explicitly instructed.
- Report: files changed + commit, VERIFIED vs LOGIC-ONLY, known gaps (<=300 words unless VERBOSE=1).
