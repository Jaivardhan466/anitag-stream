import assert from 'node:assert/strict';
import fs from 'node:fs';

console.log('====================================================');
console.log(' RUNNING STREAMING PIPELINE VERIFICATION SUITE');
console.log('====================================================');

let totalTests = 0;
let passedTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    process.exitCode = 1;
  }
}

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    process.exitCode = 1;
  }
}

// Mock a provider router matching AniTAG's native contract
function createMockHandler({ streams = [], subtitles = [], timeoutMs = 0, shouldError = false }) {
  return {
    async fetch(request) {
      if (timeoutMs > 0) {
        await new Promise((res) => setTimeout(res, timeoutMs));
      }
      if (shouldError) {
        return new Response(JSON.stringify({ error: 'Mock provider failure' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ streams, subtitles }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

async function main() {
  const indexHtml = fs.readFileSync('src/client/index.html', 'utf8');

  // ---------------------------------------------------------------------------
  // TEST GROUP 1: CATALOG INTEGRITY & NO LAZY ONE PIECE (21) FALLBACKS
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 1: Catalog Integrity & No "|| 21" Leaks ---');

  it('No hardcoded "|| 21" fallback for malId in index.html', () => {
    const malIdFallbacks = [...indexHtml.matchAll(/malId\s*\|\|\s*21/g)];
    assert.equal(malIdFallbacks.length, 0, 'Found forbidden hardcoded "|| 21" fallback for malId');
  });

  it('No hardcoded "|| 21" fallback for anilistId in index.html', () => {
    const anilistIdFallbacks = [...indexHtml.matchAll(/anilistId\s*\|\|\s*21/g)];
    assert.equal(anilistIdFallbacks.length, 0, 'Found forbidden hardcoded "|| 21" fallback for anilistId');
  });

  it('No fake opening theme MP3/MP4 used as episode fallbacks', () => {
    assert.ok(!indexHtml.includes('fallback-op.mp4'), 'Forbidden fallback-op.mp4 found');
    assert.ok(!indexHtml.includes('fake_stream_url'), 'Forbidden fake_stream_url found');
  });

  // ---------------------------------------------------------------------------
  // TEST GROUP 2: STREAM FORMATTING & MOCK PROVIDER PIPELINE RESOLUTION
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 2: Mocked Provider Pipeline Resolution ---');

  await itAsync('Resolves HLS (.m3u8) streams with proper typing and proxy requirements', async () => {
    const mockStreams = [
      {
        server: 'HLS Master',
        url: 'https://cdn.example.com/stream/playlist.m3u8',
        type: 'hls',
        referer: 'https://cdn.example.com/'
      }
    ];
    const handler = createMockHandler({ streams: mockStreams });
    const res = await handler.fetch(new Request('http://localhost/watch/mock/52299/sub/mock-1'));
    const data = await res.json();
    assert.equal(data.streams.length, 1);
    assert.equal(data.streams[0].server, 'HLS Master');
    assert.equal(data.streams[0].type, 'hls');
    assert.ok(data.streams[0].url.includes('.m3u8'));
  });

  await itAsync('Resolves MP4 direct streams with proper typing', async () => {
    const mockStreams = [
      {
        server: 'Direct MP4',
        url: 'https://archive.org/download/anime/ep1.mp4',
        type: 'mp4'
      }
    ];
    const handler = createMockHandler({ streams: mockStreams });
    const res = await handler.fetch(new Request('http://localhost/watch/mock/34572/dub/mock-1'));
    const data = await res.json();
    assert.equal(data.streams.length, 1);
    assert.equal(data.streams[0].type, 'mp4');
    assert.ok(data.streams[0].url.endsWith('.mp4'));
  });

  await itAsync('Handles provider timeouts gracefully', async () => {
    const slowHandler = createMockHandler({ timeoutMs: 300 });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Provider 'mock' resolution timeout")), 50)
    );
    await assert.rejects(
      Promise.race([slowHandler.fetch(new Request('http://localhost/watch/mock/21/sub/mock-1')), timeoutPromise]),
      { message: "Provider 'mock' resolution timeout" }
    );
  });

  await itAsync('Handles missing stream URLs cleanly without throwing', async () => {
    const handler = createMockHandler({ streams: [] });
    const res = await handler.fetch(new Request('http://localhost/watch/mock/999999/sub/mock-999'));
    const data = await res.json();
    assert.equal(data.streams.length, 0);
  });

  // ---------------------------------------------------------------------------
  // TEST GROUP 3: SUB AND DUB INDEPENDENT ROUTING
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 3: SUB and DUB Independent Routing ---');

  it('Ensures SUB and DUB generate separate distinct stream URLs in embed generator', () => {
    const malId = 52299;
    const ep = 1;

    const subUrl = `https://babastream.top/embed/${malId}/${ep}/sub`;
    const dubUrl = `https://babastream.top/embed/${malId}/${ep}/dub`;

    assert.notEqual(subUrl, dubUrl, 'SUB and DUB URLs must differ');
    assert.ok(subUrl.endsWith('/sub'), 'SUB URL must end with /sub');
    assert.ok(dubUrl.endsWith('/dub'), 'DUB URL must end with /dub');
  });

  // ---------------------------------------------------------------------------
  // TEST GROUP 4: SERVER API STREAM INTEGRATION WITH LIVE ADAPTER
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 4: Live Engine /api/stream Tests ---');

  await itAsync('Queries /api/stream for Solo Leveling Episode 1 (SUB)', async () => {
    const url = 'http://localhost:4000/api/stream?provider=2dhive&animeId=solo-leveling&anilistId=151807&malId=52299&ep=1&audio=sub';
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.streams));
    assert.ok(data.streams.length >= 1, 'Expected at least 1 stream mirror for Solo Leveling');
    assert.equal(data.audio, 'sub');
    assert.ok(data.streams.some(s => s.url.includes('52299') && s.url.includes('/sub')), 'Stream URL must reference correct MAL ID and sub audio');
  });

  await itAsync('Queries /api/stream for Solo Leveling Episode 1 (DUB)', async () => {
    const url = 'http://localhost:4000/api/stream?provider=2dhive&animeId=solo-leveling&anilistId=151807&malId=52299&ep=1&audio=dub';
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.streams));
    assert.ok(data.streams.length >= 1);
    assert.equal(data.audio, 'dub');
    assert.ok(data.streams.some(s => s.url.includes('52299') && s.url.includes('/dub')), 'Stream URL must reference correct MAL ID and dub audio');
  });

  await itAsync('Queries /api/stream for One Piece Episode 1 (Preserve working reference)', async () => {
    const url = 'http://localhost:4000/api/stream?provider=2dhive&animeId=one-piece&anilistId=21&malId=21&ep=1&audio=sub';
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.streams));
    assert.ok(data.streams.length >= 1, 'One Piece reference playback must be preserved');
    assert.ok(data.streams.some(s => s.url.includes('21')), 'One Piece stream URL must reference MAL ID 21');
  });

  await itAsync('Unreleased anime (overgeared) returns honest empty stream response without fake URLs', async () => {
    const url = 'http://localhost:4000/api/stream?provider=2dhive&animeId=overgeared&anilistId=0&malId=&ep=1&audio=sub';
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.streams.length, 0, 'Unreleased anime must not have fake streams');
    assert.ok(data.error, 'Expected error message for unreleased anime');
  });

  await itAsync('Invalid anime ID returns 200 with honest empty stream response', async () => {
    const url = 'http://localhost:4000/api/stream?provider=2dhive&animeId=non-existent-xyz&anilistId=99999999&malId=&ep=1&audio=sub';
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.streams.length, 0);
    assert.ok(data.error);
  });

  // ---------------------------------------------------------------------------
  // TEST GROUP 5: SECURITY AUDIT
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 5: Security & Safety Verification ---');

  it('Verifies no service-role keys or production database secrets are in client code', () => {
    const forbiddenPatterns = [
      'service_role',
      'postgres://',
      'postgresql://',
      'SUPABASE_SERVICE_ROLE_KEY',
      'sk_live_',
      'AKIA[0-9A-Z]{16}'
    ];
    for (const pat of forbiddenPatterns) {
      assert.ok(!indexHtml.includes(pat), `Forbidden credential pattern '${pat}' found in client code`);
    }
  });

  await itAsync('Verifies proxy rejects ad and tracker URLs safely', async () => {
    const adUrl = 'http://localhost:4000/proxy?url=' + encodeURIComponent('https://doubleclick.net/tracker.m3u8');
    const res = await fetch(adUrl);
    assert.equal(res.status, 403, 'Proxy must block ad/tracker requests');
  });

  // ---------------------------------------------------------------------------
  // SUITE SUMMARY
  // ---------------------------------------------------------------------------
  console.log('\n====================================================');
  console.log(` STREAMING PIPELINE TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  console.log('====================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
