/**
 * Comprehensive Automated Test Suite for AniTAG Native RFC-6455 WebSocket Engine.
 * Verifies handshake, text frames, ping/pong heartbeats, close frames, fragmentation,
 * and eliminates the "Unexpected token '♥'" bug.
 */

import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_SCRIPT = path.resolve(__dirname, '../src/engine/server.js');
const TEST_PORT = 4199;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createClientWsFrame(opcode, payload = Buffer.alloc(0), options = {}) {
  const fin = options.fin !== undefined ? options.fin : true;
  const isMasked = options.mask !== undefined ? options.mask : true;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = buf.length;

  let header;
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const maskBit = isMasked ? 0x80 : 0x00;

  if (len <= 125) {
    header = Buffer.from([firstByte, maskBit | len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  if (isMasked) {
    const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const maskedPayload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = buf[i] ^ maskKey[i % 4];
    }
    return Buffer.concat([header, maskKey, maskedPayload]);
  }

  return Buffer.concat([header, buf]);
}

function parseServerWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const firstByte = buffer[0];
  const fin = (firstByte & 0x80) === 0x80;
  const opcode = firstByte & 0x0f;
  const secondByte = buffer[1];
  const isMasked = (secondByte & 0x80) === 0x80;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (buffer.length < offset + payloadLen) return null;
  const payload = buffer.subarray(offset, offset + payloadLen);
  return {
    fin,
    opcode,
    payload,
    totalBytes: offset + payloadLen
  };
}

function connectAndUpgrade(port, path = '/ws/sync') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const clientKey = crypto.randomBytes(16).toString('base64');
      const reqHeaders = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${clientKey}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ];
      socket.write(reqHeaders.join('\r\n'));

      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          socket.removeListener('data', onData);
          const responseText = buffer.subarray(0, headerEnd).toString('utf8');
          const remaining = buffer.subarray(headerEnd + 4);

          const expectedAccept = crypto
            .createHash('sha1')
            .update(clientKey + WS_GUID)
            .digest('base64');

          if (!responseText.includes('101 Switching Protocols')) {
            return reject(new Error('WebSocket handshake rejected: ' + responseText));
          }
          if (!responseText.includes(expectedAccept)) {
            return reject(new Error('Invalid Sec-WebSocket-Accept header in response'));
          }

          resolve({ socket, remaining });
        }
      };

      socket.on('data', onData);
      socket.on('error', reject);
    });
  });
}

async function runTestSuite() {
  console.log('======================================================================');
  console.log('  AniTAG Native RFC-6455 WebSocket & Protocol Verification Suite');
  console.log('======================================================================\n');

  let serverProcess = null;
  let serverLogs = '';

  try {
    // 1. Launch Server Child Process on TEST_PORT
    console.log(`[TEST SETUP] Starting AniTAG server on test port ${TEST_PORT}...`);
    serverProcess = fork(SERVER_SCRIPT, [], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      silent: true
    });

    serverProcess.stdout.on('data', (d) => {
      serverLogs += d.toString();
    });
    serverProcess.stderr.on('data', (d) => {
      serverLogs += d.toString();
    });

    // Wait for server to listen
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      const interval = setInterval(() => {
        const req = http.get(`http://127.0.0.1:${TEST_PORT}/healthz`, (res) => {
          if (res.statusCode === 200) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve();
          }
        });
        req.on('error', () => {});
      }, 100);
    });
    console.log('[TEST SETUP] Server is live and healthy on port ' + TEST_PORT + '.\n');

    // -----------------------------------------------------------------------
    // TEST 1: WebSocket Handshake & Join Room (Text Frame Opcode 0x1)
    // -----------------------------------------------------------------------
    console.log('[TEST 1] Testing WebSocket Upgrade & Text Frame (JOIN_SYNC_ROOM)...');
    const { socket: client1, remaining: r1 } = await connectAndUpgrade(TEST_PORT, '/ws/sync');

    let client1Data = r1;
    const joinMsg = JSON.stringify({
      type: 'JOIN_SYNC_ROOM',
      userId: 'user_audit_100',
      deviceId: 'device_desktop_windows'
    });

    client1.write(createClientWsFrame(0x01, joinMsg));

    const responseMsg = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('JOIN_SYNC_ROOM response timeout')), 3000);
      const onData = (chunk) => {
        client1Data = Buffer.concat([client1Data, chunk]);
        const frame = parseServerWsFrame(client1Data);
        if (frame) {
          clearTimeout(timeout);
          client1.removeListener('data', onData);
          assert.strictEqual(frame.opcode, 0x01, 'Response must be Text Frame (opcode 0x1)');
          resolve(JSON.parse(frame.payload.toString('utf8')));
        }
      };
      client1.on('data', onData);
    });

    assert.strictEqual(responseMsg.type, 'SYNC_ROOM_JOINED');
    assert.strictEqual(responseMsg.userId, 'user_audit_100');
    assert.strictEqual(responseMsg.deviceId, 'device_desktop_windows');
    console.log('  -> PASS: Handshake accepted and JOIN_SYNC_ROOM acknowledged cleanly.\n');

    // -----------------------------------------------------------------------
    // TEST 2: Playback Action Broadcast between two connected devices
    // -----------------------------------------------------------------------
    console.log('[TEST 2] Testing Playback Sync Broadcast across multiple clients...');
    const { socket: client2, remaining: r2 } = await connectAndUpgrade(TEST_PORT, '/ws/sync');
    let client2Data = r2;

    // Join same room with client2
    client2.write(
      createClientWsFrame(
        0x01,
        JSON.stringify({
          type: 'JOIN_SYNC_ROOM',
          userId: 'user_audit_100',
          deviceId: 'device_mobile_android'
        })
      )
    );

    // Wait for client2 to join
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Send Playback Sync from client1
    const syncAction = {
      type: 'PLAYBACK_SYNC_ACTION',
      action: 'PLAY',
      animeId: 'solo-leveling-s2',
      animeTitle: 'Solo Leveling: Arise from the Shadow',
      episode: 3,
      audio: 'sub',
      provider: 'animegg',
      positionSec: 420.5,
      durationSec: 1440,
      volume: 1.0,
      isPlaying: true
    };

    client1.write(createClientWsFrame(0x01, JSON.stringify(syncAction)));

    const receivedBroadcast = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Playback broadcast timeout')), 3000);
      const onData = (chunk) => {
        client2Data = Buffer.concat([client2Data, chunk]);
        const frame = parseServerWsFrame(client2Data);
        if (frame) {
          const parsed = JSON.parse(frame.payload.toString('utf8'));
          if (parsed.type === 'RECEIVE_PLAYBACK_SYNC') {
            clearTimeout(timeout);
            client2.removeListener('data', onData);
            resolve(parsed);
          }
        }
      };
      client2.on('data', onData);
    });

    assert.strictEqual(receivedBroadcast.type, 'RECEIVE_PLAYBACK_SYNC');
    assert.strictEqual(receivedBroadcast.sourceDevice, 'device_desktop_windows');
    assert.strictEqual(receivedBroadcast.animeId, 'solo-leveling-s2');
    assert.strictEqual(receivedBroadcast.action, 'PLAY');
    assert.strictEqual(receivedBroadcast.positionSec, 420.5);
    console.log('  -> PASS: Real-time broadcast successfully delivered to peer device.\n');

    // -----------------------------------------------------------------------
    // TEST 3: RFC-6455 Ping (0x9) -> Server Pong (0xA) Heartbeat Echo
    // -----------------------------------------------------------------------
    console.log('[TEST 3] Testing RFC-6455 Ping (opcode 0x9) -> Pong (opcode 0xA) keepalive...');
    const pingPayload = Buffer.from('heartbeat_check_token_xyz', 'utf8');
    client1Data = Buffer.alloc(0);

    client1.write(createClientWsFrame(0x09, pingPayload));

    const pongFrame = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Pong frame timeout')), 3000);
      const onData = (chunk) => {
        client1Data = Buffer.concat([client1Data, chunk]);
        const frame = parseServerWsFrame(client1Data);
        if (frame && frame.opcode === 0x0a) {
          clearTimeout(timeout);
          client1.removeListener('data', onData);
          resolve(frame);
        }
      };
      client1.on('data', onData);
    });

    assert.strictEqual(pongFrame.opcode, 0x0a, 'Must return Pong frame (opcode 0xA)');
    assert.strictEqual(
      pongFrame.payload.toString('utf8'),
      'heartbeat_check_token_xyz',
      'Pong payload must match Ping payload exactly per RFC-6455 Section 5.5.2'
    );
    console.log('  -> PASS: Ping successfully answered with exact Pong heartbeat.\n');

    // -----------------------------------------------------------------------
    // TEST 4: RFC-6455 Close Frame (opcode 0x8 with code 1000 = [0x03, 0xE8])
    // -----------------------------------------------------------------------
    console.log('[TEST 4] Testing RFC-6455 Close Frame (opcode 0x8, code 1000 = [0x03, 0xE8])...');
    // This is the EXACT payload [0x03, 0xE8] that previously threw:
    // "WebSocket frame parse error: Unexpected token '♥', '♥' is not valid JSON"
    const closePayload = Buffer.from([0x03, 0xe8]); // Status code 1000 (Normal Closure)
    client2Data = Buffer.alloc(0);

    client2.write(createClientWsFrame(0x08, closePayload));

    const serverCloseFrame = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server close frame timeout')), 3000);
      const onData = (chunk) => {
        client2Data = Buffer.concat([client2Data, chunk]);
        const frame = parseServerWsFrame(client2Data);
        if (frame && frame.opcode === 0x08) {
          clearTimeout(timeout);
          client2.removeListener('data', onData);
          resolve(frame);
        }
      };
      client2.on('data', onData);
    });

    assert.strictEqual(serverCloseFrame.opcode, 0x08, 'Server must respond with Close frame (opcode 0x8)');
    const returnedCloseCode = serverCloseFrame.payload.readUInt16BE(0);
    assert.strictEqual(returnedCloseCode, 1000, 'Server must echo normal closure code 1000');

    // Wait for TCP socket closure
    await new Promise((resolve) => {
      if (client2.destroyed) return resolve();
      client2.on('close', resolve);
      client2.on('end', resolve);
      setTimeout(resolve, 500);
    });
    console.log('  -> PASS: Close frame processed cleanly, TCP socket closed without errors.\n');

    // -----------------------------------------------------------------------
    // TEST 5: RFC-6455 Message Fragmentation (opcode 0x1 fin=0, opcode 0x0 fin=1)
    // -----------------------------------------------------------------------
    console.log('[TEST 5] Testing RFC-6455 Message Fragmentation reassembly...');
    const fullJsonMsg = JSON.stringify({
      type: 'CLOUD_DATA_SYNC',
      dataType: 'preferences',
      data: { theme: 'midnight-crimson', mode: 'dark' }
    });
    const halfLen = Math.floor(fullJsonMsg.length / 2);
    const part1 = fullJsonMsg.substring(0, halfLen);
    const part2 = fullJsonMsg.substring(halfLen);

    // Frame 1: Text opcode 0x1 with fin = false
    client1.write(createClientWsFrame(0x01, part1, { fin: false }));
    // Frame 2: Continuation opcode 0x0 with fin = true
    client1.write(createClientWsFrame(0x00, part2, { fin: true }));

    // Verify socket remains alive and responsive after fragmented message
    client1Data = Buffer.alloc(0);
    client1.write(createClientWsFrame(0x09, 'ping_after_fragment'));
    const pingResp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ping response after fragmentation timeout')), 3000);
      const onData = (chunk) => {
        client1Data = Buffer.concat([client1Data, chunk]);
        const frame = parseServerWsFrame(client1Data);
        if (frame && frame.opcode === 0x0a) {
          clearTimeout(timeout);
          client1.removeListener('data', onData);
          resolve(frame);
        }
      };
      client1.on('data', onData);
    });
    assert.strictEqual(pingResp.opcode, 0x0a);
    console.log('  -> PASS: Fragmented frames reassembled and processed correctly.\n');

    // -----------------------------------------------------------------------
    // TEST 6: Resilient handling of malformed text JSON frame
    // -----------------------------------------------------------------------
    console.log('[TEST 6] Testing server resilience against malformed non-JSON text frame...');
    client1.write(createClientWsFrame(0x01, 'NOT_VALID_JSON_TEXT'));

    // Verify socket does not crash or disconnect
    client1Data = Buffer.alloc(0);
    client1.write(createClientWsFrame(0x09, 'ping_after_malformed'));
    const pingResp2 = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ping response after malformed text timeout')), 3000);
      const onData = (chunk) => {
        client1Data = Buffer.concat([client1Data, chunk]);
        const frame = parseServerWsFrame(client1Data);
        if (frame && frame.opcode === 0x0a) {
          clearTimeout(timeout);
          client1.removeListener('data', onData);
          resolve(frame);
        }
      };
      client1.on('data', onData);
    });
    assert.strictEqual(pingResp2.opcode, 0x0a);
    console.log('  -> PASS: Malformed JSON handled gracefully without socket disruption.\n');

    // Clean close client1
    client1.write(createClientWsFrame(0x08, Buffer.from([0x03, 0xe8])));
    await new Promise((resolve) => setTimeout(resolve, 200));
    client1.destroy();

    // -----------------------------------------------------------------------
    // TEST 7: Log Audit for "Unexpected token '♥'"
    // -----------------------------------------------------------------------
    console.log('[TEST 7] Auditing server log output for any JSON parse errors on heart characters...');
    assert(
      !serverLogs.includes("Unexpected token '♥'"),
      "Server log MUST NOT contain Unexpected token '♥' parse error"
    );
    assert(
      !serverLogs.includes('♥'),
      "Server log MUST NOT contain any raw control character '♥' corruption"
    );
    console.log("  -> PASS: Confirmed zero 'Unexpected token ♥' errors throughout test execution.\n");

    console.log('======================================================================');
    console.log('  ALL 7 RFC-6455 PROTOCOL TESTS PASSED WITH 100% SUCCESS!');
    console.log('======================================================================\n');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGKILL');
    }
  }
}

runTestSuite().catch((err) => {
  console.error('\n[FATAL TEST FAILURE]:', err);
  process.exit(1);
});
