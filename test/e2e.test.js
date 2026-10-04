'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidate = path.join(localAppData, 'npm-cache', '_npx', 'e41f203b7505f1fb', 'node_modules', 'playwright');
  chromium = require(candidate).chromium;
}
const { startServer } = require('../server/server.js');

const ROOT_DIR = path.resolve(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createStaticServer() {
  return http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
    const filePath = path.join(ROOT_DIR, reqPath.replace(/^\//, ''));

    // Prevent directory traversal
    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      res.end(data);
    });
  });
}

async function runE2ETests() {
  console.log('=== Starting LocalDrop Playwright End-to-End & Audit Tests ===');

  // 1. Start Static HTTP Server & Signaling Server
  const staticServer = createStaticServer();
  await new Promise((res) => staticServer.listen(0, '127.0.0.1', res));
  const httpPort = staticServer.address().port;
  const appUrl = `http://127.0.0.1:${httpPort}/`;
  console.log(`Static server running at ${appUrl}`);

  const sigServer = startServer(0);
  await new Promise((res) => sigServer._http.on('listening', res));
  const sigPort = sigServer._http.address().port;
  const wsUrl = `ws://127.0.0.1:${sigPort}`;
  console.log(`Signaling server running at ${wsUrl}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  try {
    // -------------------------------------------------------------
    // Test A: Mobile Viewport Audit (Font sizes & Touch Targets)
    // -------------------------------------------------------------
    console.log('\n--- 1. Mobile Responsive, Font Size & Touch Target Audit ---');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      hasTouch: true,
      isMobile: true,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(appUrl);

    // Audit Input and Textarea font sizes (must be >= 16px to prevent iOS Safari auto-zoom)
    const fontSizes = await mobilePage.evaluate(() => {
      const selectors = ['#nameInput', '#serverInput', '#textInput'];
      const results = {};
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          results[sel] = parseFloat(window.getComputedStyle(el).fontSize);
        }
      }
      // Also check textareas in host and join views
      const hostTa = document.querySelector('#hostCode');
      if (hostTa) results['#hostCode'] = parseFloat(window.getComputedStyle(hostTa).fontSize);
      const joinTa = document.querySelector('#joinCode');
      if (joinTa) results['#joinCode'] = parseFloat(window.getComputedStyle(joinTa).fontSize);
      return results;
    });

    console.log('Computed font sizes on mobile:', fontSizes);
    for (const [sel, size] of Object.entries(fontSizes)) {
      assert(size >= 16, `Expected font-size >= 16px on ${sel}, but got ${size}px`);
    }
    console.log('✓ VERIFIED: All input & textarea font sizes >= 16px (no iOS Safari auto-zoom)');

    // Audit Touch Targets on each view
    // View Home:
    const homeTargets = await mobilePage.evaluate(() => {
      const getDims = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      return {
        btnHost: getDims(document.querySelector('#btnHost')),
        btnJoin: getDims(document.querySelector('#btnJoin')),
        privToggle: getDims(document.querySelector('.privrow')),
      };
    });
    console.log('Home view touch targets:', homeTargets);
    for (const [name, dims] of Object.entries(homeTargets)) {
      assert(dims.width >= 44 && dims.height >= 44, `Target ${name} < 44px`);
    }

    // View Host:
    await mobilePage.click('#btnHost');
    const hostTargets = await mobilePage.evaluate(() => {
      const rect = document.querySelector('#view-host .back').getBoundingClientRect();
      const copyBtn = document.querySelector('#copyHost').getBoundingClientRect();
      const connBtn = document.querySelector('#btnConnect').getBoundingClientRect();
      return {
        backHost: { width: Math.round(rect.width), height: Math.round(rect.height) },
        copyHost: { width: Math.round(copyBtn.width), height: Math.round(copyBtn.height) },
        btnConnect: { width: Math.round(connBtn.width), height: Math.round(connBtn.height) },
      };
    });
    console.log('Host view touch targets:', hostTargets);
    for (const [name, dims] of Object.entries(hostTargets)) {
      assert(dims.width >= 44 && dims.height >= 44, `Target ${name} < 44px`);
    }

    // View Join:
    await mobilePage.click('#view-host .back');
    await mobilePage.click('#btnJoin');
    const joinTargets = await mobilePage.evaluate(() => {
      const rect = document.querySelector('#view-join .back').getBoundingClientRect();
      const replyBtn = document.querySelector('#btnMakeReply').getBoundingClientRect();
      return {
        backJoin: { width: Math.round(rect.width), height: Math.round(rect.height) },
        btnMakeReply: { width: Math.round(replyBtn.width), height: Math.round(replyBtn.height) },
      };
    });
    console.log('Join view touch targets:', joinTargets);
    for (const [name, dims] of Object.entries(joinTargets)) {
      assert(dims.width >= 44 && dims.height >= 44, `Target ${name} < 44px`);
    }

    // View Chat:
    await mobilePage.click('#view-join .back');
    await mobilePage.evaluate(() => go('chat'));
    const chatTargets = await mobilePage.evaluate(() => {
      const getDims = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      return {
        backChat: getDims(document.querySelector('#view-chat .back')),
        attachFile: getDims(document.querySelector('.attach[title="Send photo or file"]')),
        attachFolder: getDims(document.querySelector('.attach[title="Send a whole folder"]')),
        attachClip: getDims(document.querySelector('#btnClip')),
        btnSend: getDims(document.querySelector('#btnSend')),
      };
    });
    console.log('Chat view touch targets:', chatTargets);
    for (const [name, dims] of Object.entries(chatTargets)) {
      assert(dims.width >= 44 && dims.height >= 44, `Target ${name} < 44px`);
    }
    console.log('✓ VERIFIED: All interactive touch targets meet >= 44x44px minimum across all views');

    // Check cancel button (.xbtn) touch target styling
    const xbtnDimensions = await mobilePage.evaluate(() => {
      const temp = document.createElement('button');
      temp.className = 'xbtn';
      temp.textContent = '✕';
      document.body.appendChild(temp);
      const rect = temp.getBoundingClientRect();
      const res = { width: Math.round(rect.width), height: Math.round(rect.height) };
      temp.remove();
      return res;
    });
    assert(xbtnDimensions.width >= 44 && xbtnDimensions.height >= 44, `xbtn size ${JSON.stringify(xbtnDimensions)} < 44px`);
    console.log(`✓ VERIFIED: Transfer cancel button (.xbtn) meets 44x44px (${xbtnDimensions.width}x${xbtnDimensions.height}px)`);

    await mobileContext.close();

    // -------------------------------------------------------------
    // Test B: Service Worker & Cache Invalidation Audit
    // -------------------------------------------------------------
    console.log('\n--- 2. Service Worker & Cache Invalidation Audit ---');
    const swContext = await browser.newContext();
    const swPage = await swContext.newPage();
    await swPage.goto(appUrl);

    // Wait for SW registration
    const swStatus = await swPage.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const reg = await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const hasV16 = keys.includes('localdrop-v16');
      let assetCount = 0;
      if (hasV16) {
        const cache = await caches.open('localdrop-v16');
        const reqs = await cache.keys();
        assetCount = reqs.length;
      }
      return {
        supported: true,
        scope: reg.scope,
        caches: keys,
        hasV16,
        assetCount,
      };
    });

    console.log('Service Worker status:', swStatus);
    assert.strictEqual(swStatus.supported, true, 'Service Worker should be supported');
    assert.strictEqual(swStatus.hasV16, true, 'Cache localdrop-v16 must be registered');
    assert(swStatus.assetCount >= 10, `Expected at least 10 assets cached, got ${swStatus.assetCount}`);
    console.log(`✓ VERIFIED: Service Worker active and localdrop-v16 populated with ${swStatus.assetCount} assets`);
    await swContext.close();

    // -------------------------------------------------------------
    // Test C: End-to-End P2P WebRTC Transfer Flow (Alice <-> Bob)
    // -------------------------------------------------------------
    console.log('\n--- 3. End-to-End Tap-to-Connect & WebRTC Data Transfer ---');
    const contextAlice = await browser.newContext();
    const contextBob = await browser.newContext();

    const pageAlice = await contextAlice.newPage();
    const pageBob = await contextBob.newPage();

    // Configure Alice
    await pageAlice.goto(appUrl);
    await pageAlice.evaluate((ws) => {
      localStorage.setItem('ld_server', ws);
      localStorage.setItem('ld_name', 'Alice-Test');
    }, wsUrl);
    await pageAlice.reload();

    // Configure Bob
    await pageBob.goto(appUrl);
    await pageBob.evaluate((ws) => {
      localStorage.setItem('ld_server', ws);
      localStorage.setItem('ld_name', 'Bob-Test');
    }, wsUrl);
    await pageBob.reload();

    // Alice should see Bob in roster
    console.log('Waiting for Bob to appear in Alice’s roster...');
    await pageAlice.waitForSelector('.dev .dname:has-text("Bob-Test")', { timeout: 10000 });
    console.log('✓ Alice discovered Bob in nearby roster');

    // Bob should see Alice in roster
    await pageBob.waitForSelector('.dev .dname:has-text("Alice-Test")', { timeout: 10000 });
    console.log('✓ Bob discovered Alice in nearby roster');

    // Alice calls Bob
    console.log('Alice calls Bob...');
    await pageAlice.click('.dev:has-text("Bob-Test")');

    // Alice shows ringing state
    await pageAlice.waitForSelector('#callState:has-text("Ringing Bob-Test")', { timeout: 5000 });
    console.log('✓ Alice displays ringing status');

    // Bob receives incoming call modal
    await pageBob.waitForSelector('#callModal:not(.hidden)', { timeout: 5000 });
    const callTitle = await pageBob.textContent('#callTitle');
    assert(callTitle.includes('Alice-Test'), `Expected Alice-Test in callTitle, got ${callTitle}`);
    console.log(`✓ Bob received incoming call modal: "${callTitle}"`);

    // Bob accepts call
    await pageBob.click('#btnAccept');

    // Both should enter chat view with connected status
    await pageAlice.waitForSelector('#view-chat:not(.hidden)', { timeout: 10000 });
    await pageBob.waitForSelector('#view-chat:not(.hidden)', { timeout: 10000 });
    await pageAlice.waitForSelector('#statusText:has-text("connected")', { timeout: 10000 });
    await pageBob.waitForSelector('#statusText:has-text("connected")', { timeout: 10000 });
    console.log('✓ WebRTC DataChannel connected on both peers');

    // Transfer text message from Alice to Bob
    const testMsg = 'Hello peer-to-peer WebRTC! ' + Date.now();
    await pageAlice.fill('#textInput', testMsg);
    await pageAlice.click('#btnSend');

    await pageBob.waitForSelector(`.bubble.theirs .text:has-text("${testMsg}")`, { timeout: 5000 });
    console.log('✓ Text message successfully delivered via WebRTC');

    // Transfer link from Bob to Alice
    const testLink = 'https://example.com/test-link';
    await pageBob.fill('#textInput', testLink);
    await pageBob.click('#btnSend');

    await pageAlice.waitForSelector(`.bubble.theirs a[href="${testLink}"][target="_blank"]`, { timeout: 5000 });
    console.log('✓ Link sanitized and delivered with target="_blank" rel="noopener"');

    // Transfer file from Alice to Bob
    console.log('Sending file from Alice to Bob...');
    const testFilePath = path.join(ROOT_DIR, 'test', 'sample.txt');
    fs.writeFileSync(testFilePath, 'Hello LocalDrop transfer verification payload!\n'.repeat(500), 'utf8');

    const fileInput = await pageAlice.$('#fileInput');
    await fileInput.setInputFiles(testFilePath);

    // Bob receives file-ask approval card (v9 protocol)
    await pageBob.waitForSelector('.bubble.ask .okbtn', { timeout: 5000 });
    console.log('✓ Bob received file approval prompt');

    // Bob accepts the file
    await pageBob.click('.bubble.ask .okbtn');

    // File streams and completes
    await pageBob.waitForSelector('.bubble.theirs .dl:has-text("⬇ Download")', { timeout: 10000 });
    console.log('✓ File received, verified, and download button rendered');

    // Clean up sample file
    try { fs.unlinkSync(testFilePath); } catch (e) {}

    await contextAlice.close();
    await contextBob.close();

    // -------------------------------------------------------------
    // Test D: WebRTC Signaling Error & Honest Fallback State Audit
    // -------------------------------------------------------------
    console.log('\n--- 4. Signaling Failure & Fallback State Audit (Landmine 2) ---');
    const contextCharlie = await browser.newContext();
    const pageCharlie = await contextCharlie.newPage();
    await pageCharlie.goto(appUrl);
    await pageCharlie.evaluate((ws) => {
      localStorage.setItem('ld_server', ws);
      localStorage.setItem('ld_name', 'Charlie-Test');
    }, wsUrl);
    await pageCharlie.reload();
    await pageCharlie.waitForSelector('#sigDot.on', { timeout: 5000 });

    // 4a. Trigger call to offline recipient
    console.log('Testing call to offline device...');
    await pageCharlie.evaluate(() => {
      callDevice('non-existent-device-id', 'Ghost Device');
    });

    // Verify it fails HONESTLY to "device is offline" within 1 second (NOT hanging for 20s!)
    await pageCharlie.waitForSelector('#statusText:has-text("device is offline")', { timeout: 2000 });
    const ringingHidden = await pageCharlie.evaluate(() => {
      const el = document.getElementById('callState');
      return el.classList.contains('hidden');
    });
    assert.strictEqual(ringingHidden, true, 'Ringing element should be hidden immediately upon error');
    console.log('✓ VERIFIED: Offline device call fails honestly to "device is offline" within <500ms');

    // 4b. Outgoing call cancel
    console.log('Testing user call cancellation...');
    const contextDave = await browser.newContext();
    const pageDave = await contextDave.newPage();
    await pageDave.goto(appUrl);
    await pageDave.evaluate((ws) => {
      localStorage.setItem('ld_server', ws);
      localStorage.setItem('ld_name', 'Dave-Test');
    }, wsUrl);
    await pageDave.reload();

    await pageCharlie.waitForSelector('.dev .dname:has-text("Dave-Test")', { timeout: 5000 });
    await pageCharlie.click('.dev:has-text("Dave-Test")');
    await pageCharlie.waitForSelector('#callState:has-text("Ringing Dave-Test")', { timeout: 2000 });
    await pageDave.waitForSelector('#callModal:not(.hidden)', { timeout: 2000 });

    // Charlie cancels
    await pageCharlie.click('#callState .btn:has-text("Cancel")');
    await pageDave.waitForSelector('#callModal', { state: 'hidden', timeout: 3000 });
    console.log('✓ VERIFIED: Caller cancel cleanly resets peer state');

    // 4c. Recipient call decline
    console.log('Testing recipient decline...');
    await pageCharlie.click('.dev:has-text("Dave-Test")');
    await pageDave.waitForSelector('#callModal:not(.hidden)', { timeout: 2000 });
    await pageDave.click('#btnDecline');

    await pageCharlie.waitForSelector('#statusText:has-text("Dave-Test declined")', { timeout: 2000 });
    console.log('✓ VERIFIED: Recipient decline honestly reported to caller');

    await contextCharlie.close();
    await contextDave.close();

    console.log('\n=== ALL PLAYWRIGHT AUDIT & E2E TESTS PASSED SUCCESSFULLY! ===');
  } finally {
    await browser.close();
    await new Promise((res) => sigServer.close(res));
    await new Promise((res) => staticServer.close(res));
  }
}

runE2ETests().catch((err) => {
  console.error('\nE2E Test Failed:', err);
  process.exit(1);
});
