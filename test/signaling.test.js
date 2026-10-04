'use strict';

const assert = require('assert');
const http = require('http');
const WebSocket = require('../server/node_modules/ws');
const {
  normalizeIp,
  clientIp,
  isNearby,
  buildRoster,
  validateSignal,
  startServer,
} = require('../server/server.js');

async function runSignalingTests() {
  console.log('--- Running Signaling Server Tests ---');

  // 1. normalizeIp
  assert.strictEqual(normalizeIp('::ffff:192.168.1.1'), '192.168.1.1');
  assert.strictEqual(normalizeIp('192.168.1.1'), '192.168.1.1');
  assert.strictEqual(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.strictEqual(normalizeIp(''), '');
  assert.strictEqual(normalizeIp(null), '');
  console.log('✓ normalizeIp tests passed');

  // 2. clientIp
  const reqWithFwd = { headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' } };
  assert.strictEqual(clientIp(reqWithFwd, null), '203.0.113.195');
  const reqWithSocket = { socket: { remoteAddress: '::ffff:10.0.0.1' } };
  assert.strictEqual(clientIp(reqWithSocket, null), '10.0.0.1');
  console.log('✓ clientIp tests passed');

  // 3. isNearby
  assert.strictEqual(isNearby('1.2.3.4', '1.2.3.4'), true);
  assert.strictEqual(isNearby('1.2.3.4', '1.2.3.5'), false);
  // IPv6 /64 prefix comparison
  assert.strictEqual(isNearby('2001:db8:abcd:0012::1', '2001:db8:abcd:0012::2'), true);
  assert.strictEqual(isNearby('2001:db8:abcd:0012::1', '2001:db8:abcd:0013::1'), false);
  assert.strictEqual(isNearby('1.2.3.4', '2001:db8::1'), false);
  console.log('✓ isNearby tests passed');

  // 4. buildRoster
  const registry = new Map([
    ['alice', { id: 'alice', name: 'Alice', ip: '1.2.3.4', priv: false, lastSeen: 100 }],
    ['bob', { id: 'bob', name: 'Bob', ip: '1.2.3.4', priv: false, lastSeen: 101 }],
    ['charlie', { id: 'charlie', name: 'Charlie', ip: '1.2.3.4', priv: true, lastSeen: 102 }],
    ['dave', { id: 'dave', name: 'Dave', ip: '5.6.7.8', priv: false, lastSeen: 103 }],
  ]);
  const aliceRoster = buildRoster(registry, 'alice', '1.2.3.4');
  assert.strictEqual(aliceRoster.length, 2);
  const bobEntry = aliceRoster.find((d) => d.id === 'bob');
  assert.strictEqual(bobEntry.name, 'Bob');
  assert.strictEqual(bobEntry.nearby, true);
  const daveEntry = aliceRoster.find((d) => d.id === 'dave');
  assert.strictEqual(daveEntry.name, 'Dave');
  assert.strictEqual(daveEntry.nearby, false);
  const charlieEntry = aliceRoster.find((d) => d.id === 'charlie');
  assert.strictEqual(charlieEntry, undefined); // private mode: hidden
  console.log('✓ buildRoster tests passed');

  // 5. validateSignal
  assert.strictEqual(validateSignal(null), 'bad message');
  assert.strictEqual(validateSignal({}), 'missing recipient');
  assert.strictEqual(validateSignal({ to: 'a'.repeat(65) }), 'missing recipient');
  assert.strictEqual(validateSignal({ to: 'bob' }), 'missing payload');
  assert.strictEqual(validateSignal({ to: 'bob', payload: { kind: 'bad' } }), 'unknown signal kind');
  assert.strictEqual(validateSignal({ to: 'bob', payload: { kind: 'offer', sdp: 'xyz' } }), 'offer/answer needs sdp');
  assert.strictEqual(validateSignal({ to: 'bob', payload: { kind: 'offer', sdp: 'v=0\r\no=...' } }), '');
  assert.strictEqual(validateSignal({ to: 'bob', payload: { kind: 'ice', candidate: 'not an obj' } }), 'ice needs a candidate');
  assert.strictEqual(validateSignal({ to: 'bob', payload: { kind: 'ice', candidate: { candidate: 'candidate:1...' } } }), '');
  assert.strictEqual(validateSignal({ to: 'bob', payload: { kind: 'declined' } }), '');
  console.log('✓ validateSignal tests passed');

  // 6. Integration tests with live WebSocket server
  const server = startServer(0);
  await new Promise((resolve) => server._http.on('listening', resolve));
  const port = server._http.address().port;
  const wsUrl = `ws://127.0.0.1:${port}`;

  try {
    // Health check
    const health = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.clients, 0);
    console.log('✓ Health check endpoint verified');

    // Client A connect & register
    const wsA = new WebSocket(wsUrl);
    await new Promise((res) => wsA.on('open', res));
    wsA.send(JSON.stringify({ t: 'register', id: 'client-a', name: 'Alice\x00' }));
    const msgA1 = await new Promise((res) => wsA.once('message', (d) => res(JSON.parse(d))));
    assert.strictEqual(msgA1.t, 'registered');
    assert.strictEqual(msgA1.id, 'client-a');
    // Name sanitization check in server client map
    const clientAEntry = server._clients.get('client-a');
    assert.strictEqual(clientAEntry.name, 'Alice');

    // Client B connect & register
    const wsB = new WebSocket(wsUrl);
    await new Promise((res) => wsB.on('open', res));
    wsB.send(JSON.stringify({ t: 'register', id: 'client-b', name: 'Bob' }));

    // Client A receives roster update with Client B
    const rosterMsg = await new Promise((res) => wsA.once('message', (d) => res(JSON.parse(d))));
    assert.strictEqual(rosterMsg.t, 'roster');
    assert.strictEqual(rosterMsg.devices.length, 1);
    assert.strictEqual(rosterMsg.devices[0].id, 'client-b');
    assert.strictEqual(rosterMsg.devices[0].name, 'Bob');
    console.log('✓ Registration and roster broadcast verified');

    // Signal routing: A sends offer to B
    wsA.send(JSON.stringify({
      t: 'signal',
      to: 'client-b',
      payload: { kind: 'offer', sdp: 'v=0\r\no=...' },
    }));
    const sigMsg = await new Promise((res) => wsB.once('message', (d) => res(JSON.parse(d))));
    assert.strictEqual(sigMsg.t, 'signal');
    assert.strictEqual(sigMsg.from, 'client-a');
    assert.strictEqual(sigMsg.fromName, 'Alice');
    assert.strictEqual(sigMsg.payload.kind, 'offer');
    console.log('✓ Signal routing between peers verified');

    // Offline error response: A signals offline peer
    wsA.send(JSON.stringify({
      t: 'signal',
      to: 'non-existent',
      payload: { kind: 'offer', sdp: 'v=0\r\no=...' },
    }));
    const offlineErr = await new Promise((res) => wsA.once('message', (d) => res(JSON.parse(d))));
    assert.strictEqual(offlineErr.t, 'error');
    assert.strictEqual(offlineErr.msg, 'device is offline');
    console.log('✓ Offline device signaling error response verified');

    wsA.close();
    wsB.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('All signaling server tests PASSED!');
}

runSignalingTests().catch((err) => {
  console.error('Signaling test failed:', err);
  process.exit(1);
});
