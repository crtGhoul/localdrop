#!/usr/bin/env node
/* LocalDrop real-browser transfer rig (Prompt 13 proof tool).
 *
 * Two real browser pages, the real app, manual code pairing, one real file
 * transfer over a real RTCDataChannel. Logs wall-clock throughput and the
 * sender page's peak JS heap (Chromium).
 *
 *   node test/webrtc-rig.mjs [sizeMB] [browser]
 *     sizeMB   file size to transfer (default 1024; use 10240 for 10 GB)
 *     browser  'chromium' (default) or 'firefox'
 *
 * Needs: npm i playwright-core, and a browser binary:
 *   CHROME_BIN=/path/to/chrome   (or FIREFOX_BIN=/path/to/firefox)
 * On a normal machine (home PC, VPS with UDP) loopback WebRTC works and
 * this prints real numbers. In sandboxes that block UDP it will report
 * the ICE failure instead — that's the environment, not the app.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_MB = Number(process.argv[2] || 1024);
const BROWSER = process.argv[3] || 'chromium';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const srv = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise((r) => srv.listen(8901, r));

const launcher = BROWSER === 'firefox' ? firefox : chromium;
const bin = BROWSER === 'firefox'
  ? (process.env.FIREFOX_BIN || 'firefox')
  : (process.env.CHROME_BIN || '/opt/meta-chromium/chrome');
const browser = await launcher.launch({
  executablePath: bin,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const mk = async (name) => {
  const ctx = await browser.newContext();
  return ctx.newPage();
};
const A = await mk('Rig-A');
const B = await mk('Rig-B');
await A.goto('http://127.0.0.1:8901/');
await B.goto('http://127.0.0.1:8901/');

const waitFor = async (page, fn, ms, label) => {
  try {
    await page.waitForFunction(fn, null, { timeout: ms, polling: 250 });
    return true;
  } catch (e) {
    console.log('TIMEOUT waiting for:', label);
    return false;
  }
};

await A.click('#btnHost');
await waitFor(A, () => document.getElementById('hostCode').value.length > 20, 30000, 'host code');
const code = await A.evaluate(() => document.getElementById('hostCode').value);
await B.click('#btnJoin');
await B.fill('#joinCode', code);
await B.click('#btnMakeReply');
await waitFor(B, () => document.getElementById('joinReply').value.length > 20, 30000, 'reply code');
const reply = await B.evaluate(() => document.getElementById('joinReply').value);
await A.fill('#hostAnswer', reply);
await A.click('#btnConnect');
const connected = await waitFor(A,
  () => document.getElementById('statusText').textContent === 'connected',
  60000, 'RTCDataChannel open (ICE)');
if (!connected) {
  const state = await A.evaluate(() => (window.__pcState || 'unknown'));
  console.log(JSON.stringify({
    ok: false,
    stage: 'ice-connect',
    detail: 'DataChannel never opened in 60s. On machines with working UDP this connects in <1s. ' +
      'If this box blocks UDP (many CI sandboxes do), no browser WebRTC can run here.',
    pcState: state,
  }, null, 1));
  await browser.close();
  srv.close();
  process.exit(3);
}
console.log('connected; E2E key derived:', await A.evaluate(() => { try { return !!e2eKey; } catch (e) { return 'unknown'; } }));

const bytes = crypto.randomBytes(SIZE_MB * 1024 * 1024);
const truth = crypto.createHash('sha256').update(bytes).digest('hex');
await A.evaluate(([buf]) => {
  window.__file = new File([new Uint8Array(buf)], 'rig.bin', { type: 'application/octet-stream' });
}, [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)]);
let peakHeap = 0;
const heapTimer = setInterval(async () => {
  try {
    const h = await A.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
    if (h > peakHeap) peakHeap = h;
  } catch (e) {}
}, 500);
const t0 = Date.now();
await A.evaluate(() => enqueueFile(window.__file));
await waitFor(B, () => !!document.querySelector('.ask .okbtn'), 30000, 'file-ask card');
await B.click('.ask .okbtn');
const done = await waitFor(B,
  () => { try { return receivedFiles.length > 0 &&
    Array.from(document.querySelectorAll('.fnote')).some((n) => /checksum/.test(n.textContent)); } catch (e) { return false; } },
  Math.max(120000, SIZE_MB * 2000), 'transfer complete');
const secs = (Date.now() - t0) / 1000;
clearInterval(heapTimer);
let gotHash = null;
if (done) {
  gotHash = await B.evaluate(async () => {
    const b = receivedFiles[receivedFiles.length - 1].blob;
    return sha256Hex(b);
  });
}
console.log(JSON.stringify({
  ok: !!done && gotHash === truth,
  sizeMB: SIZE_MB,
  seconds: Math.round(secs * 10) / 10,
  throughputMBs: Math.round(SIZE_MB / secs * 10) / 10,
  sha256Match: gotHash === truth,
  senderPeakHeapMB: BROWSER === 'chromium' ? Math.round(peakHeap / 1048576) : 'n/a (Firefox has no performance.memory)',
}, null, 1));
await browser.close();
srv.close();
process.exit(0);
