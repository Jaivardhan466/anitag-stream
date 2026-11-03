/**
 * Comprehensive Test Suite for AniTAG Backup, Encryption, Pagination, Failure Handling, and Restoration
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_TABLES,
  deriveKey,
  encryptPayload,
  decryptPayload,
  computeChecksum,
  fetchAllRowsForTable,
  executeBackup
} from '../src/engine/db/backup.js';
import {
  readAndValidateBackupFile,
  executeRestore
} from '../src/engine/db/restore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_BACKUP_DIR = path.resolve(__dirname, 'temp_backup_test');
const TEST_PASSPHRASE = 'test_secret_passphrase_32_characters_long_abc123';

// Setup & Teardown
function setupTestDir() {
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log('STARTING BACKUP & RESTORATION RIGOROUS TEST SUITE');
  console.log('================================================================\n');

  setupTestDir();
  let passedCount = 0;

  // ---------------------------------------------------------------------------
  // TEST 1: AES-256-GCM Encryption, Tamper-Resistance & Auth Tag Validation
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 1] Testing AES-256-GCM Encryption, Decryption & Tamper-Resistance...');
    const originalText = JSON.stringify({ message: 'AniTAG Confidential User Data', timestamp: Date.now() });
    const buffer = Buffer.from(originalText, 'utf8');

    const encrypted = encryptPayload(buffer, TEST_PASSPHRASE);
    assert(encrypted.length > buffer.length, 'Encrypted buffer must include magic, salt, IV, authTag, and ciphertext');
    assert.strictEqual(encrypted.subarray(0, 13).toString('utf8'), 'ANITAG_ENC_V1', 'Header must match magic bytes');

    // Decrypt with correct key
    const decrypted = decryptPayload(encrypted, TEST_PASSPHRASE);
    assert.strictEqual(decrypted.toString('utf8'), originalText, 'Decrypted text must match original');

    // Attempt decrypt with WRONG key -> must throw
    let wrongKeyThrown = false;
    try {
      decryptPayload(encrypted, 'wrong_passphrase_here');
    } catch {
      wrongKeyThrown = true;
    }
    assert(wrongKeyThrown, 'Decryption with incorrect key must fail auth tag verification');

    // Attempt decrypt with TAMPERED ciphertext -> must throw
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xFF; // Flip bits in ciphertext
    let tamperThrown = false;
    try {
      decryptPayload(tampered, TEST_PASSPHRASE);
    } catch {
      tamperThrown = true;
    }
    assert(tamperThrown, 'Decryption with tampered ciphertext must fail auth tag verification');

    console.log('  -> PASS: Encryption round-trip, key enforcement, and tamper detection verified.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 1:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Deterministic Pagination (Simulating Multi-Page API Limits)
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 2] Testing Deterministic PostgREST Pagination...');
    const TOTAL_MOCK_ROWS = 1250;
    const PAGE_SIZE = 500;
    const mockDb = Array.from({ length: TOTAL_MOCK_ROWS }, (_, i) => ({
      id: `uuid-${(i + 1).toString().padStart(6, '0')}`,
      value: `data-row-${i + 1}`
    }));

    let requestCount = 0;
    const mockFetch = async (url) => {
      requestCount++;
      const urlObj = new URL(url);
      const limit = parseInt(urlObj.searchParams.get('limit') || '500', 10);
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const slice = mockDb.slice(offset, offset + limit);

      return {
        ok: true,
        status: 200,
        json: async () => slice
      };
    };

    const fetchedRows = await fetchAllRowsForTable('https://mock.supabase.co', 'mock-key', 'watch_history', {
      pageSize: PAGE_SIZE,
      fetchFn: mockFetch
    });

    assert.strictEqual(fetchedRows.length, TOTAL_MOCK_ROWS, `Must fetch exactly all ${TOTAL_MOCK_ROWS} rows`);
    assert.strictEqual(requestCount, 3, 'Must paginate across exactly 3 requests (500 + 500 + 250)');
    assert.strictEqual(fetchedRows[0].id, 'uuid-000001', 'First row must align');
    assert.strictEqual(fetchedRows[TOTAL_MOCK_ROWS - 1].id, 'uuid-001250', 'Last row must align');

    console.log(`  -> PASS: Pagination fetched all ${fetchedRows.length} records across ${requestCount} pages without omission.\n`);
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 2:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Strict Failure Model (Any Single Table Error FAILS Entire Backup)
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 3] Testing Failure Handling: Partial Export Must Fail Entire Backup...');
    const failingFetch = async (url) => {
      // Simulate failure on 'continue_watching'
      if (url.includes('/continue_watching')) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => 'Database connection timeout'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'mock-1', data: 'ok' }]
      };
    };

    let backupFailedAsExpected = false;
    try {
      await executeBackup({
        supabaseUrl: 'https://mock.supabase.co',
        serviceRoleKey: 'mock-service-key',
        encryptionKey: TEST_PASSPHRASE,
        backupDir: TEST_BACKUP_DIR,
        fetchFn: failingFetch,
        throwOnError: true
      });
    } catch (err) {
      backupFailedAsExpected = true;
      assert(err.message.includes("table 'continue_watching'"), 'Error message must identify the failing table');
    }

    assert(backupFailedAsExpected, 'Backup MUST fail and throw error when any required table fails');

    // Confirm no valid encrypted backup was generated for the failed run
    const files = fs.readdirSync(TEST_BACKUP_DIR);
    const validEncBackups = files.filter(f => f.startsWith('anitag_backup_') && f.endsWith('.json.enc'));
    assert.strictEqual(validEncBackups.length, 0, 'No valid encrypted backup artifact should be created on failure');

    // Confirm failure diagnostic log was written
    const failDiagnostics = files.filter(f => f.startsWith('backup_failure_'));
    assert.strictEqual(failDiagnostics.length, 1, 'A failure diagnostic record must be written');

    console.log('  -> PASS: Backup safely aborted on table failure; zero partial exports labeled as success.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 3:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Full Successful Backup with Manifest & AES-256-GCM Container
  // ---------------------------------------------------------------------------
  let backupArtifactPath;
  try {
    console.log('[TEST 4] Testing Full Successful Encrypted Backup with Manifest...');
    const mockDbData = {
      profiles: [{ id: 'user-uuid-1', display_name: 'Test Viewer', avatar_url: 'https://example.com/a.png' }],
      user_preferences: [{ user_id: 'user-uuid-1', theme_id: 'monochrome', theme_mode: 'dark', audio_mode: 'SUB' }],
      continue_watching: [{ id: 'cw-1', user_id: 'user-uuid-1', anime_id: 'black-clover', episode_num: 12, progress_seconds: 450 }],
      watch_history: [{ id: 'wh-1', user_id: 'user-uuid-1', anime_id: 'black-clover', episode_num: 12, completed: true }],
      user_watchlist: [{ id: 'wl-1', user_id: 'user-uuid-1', anime_id: 'black-clover' }],
      user_anime_ratings: [{ id: 'ar-1', user_id: 'user-uuid-1', anime_id: 'black-clover', rating: 9.5 }],
      user_episode_ratings: [{ id: 'er-1', user_id: 'user-uuid-1', anime_id: 'black-clover', episode_num: 12, rating: 9.0 }]
    };

    const successfulFetch = async (url) => {
      for (const table of REQUIRED_TABLES) {
        if (url.includes(`/${table}?`)) {
          return {
            ok: true,
            status: 200,
            json: async () => mockDbData[table] || []
          };
        }
      }
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'Table not found' };
    };

    const backupResult = await executeBackup({
      supabaseUrl: 'https://test.supabase.co',
      serviceRoleKey: 'test-service-key-12345',
      encryptionKey: TEST_PASSPHRASE,
      backupDir: TEST_BACKUP_DIR,
      fetchFn: successfulFetch,
      throwOnError: true
    });

    assert(backupResult.success, 'Backup must report success');
    assert.strictEqual(backupResult.manifest.status, 'SUCCESS');
    assert.strictEqual(backupResult.manifest.total_tables, 7);
    assert.strictEqual(backupResult.manifest.total_rows, 7);

    // Verify all 7 tables have checksums
    for (const t of REQUIRED_TABLES) {
      assert(backupResult.manifest.tables[t], `Manifest must contain table '${t}'`);
      assert(backupResult.manifest.tables[t].sha256, `Table '${t}' must have sha256 checksum`);
      assert.strictEqual(backupResult.manifest.tables[t].status, 'OK');
    }

    assert(fs.existsSync(backupResult.encryptedFilePath), 'Encrypted .enc file must exist');
    assert(fs.existsSync(backupResult.manifestFilePath), 'Public .manifest.json file must exist');

    backupArtifactPath = backupResult.encryptedFilePath;
    console.log(`  -> PASS: Successful backup generated and validated at ${backupArtifactPath}\n`);
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 4:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Decryption, Checksum Verification, Dry-Run & Restoration
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 5] Testing Restoration: Decryption, Checksum Verification & Safe Re-Insertion...');
    
    // 5A: Validate Backup Artifact & SHA-256 Checksums
    const validated = readAndValidateBackupFile(backupArtifactPath, TEST_PASSPHRASE);
    assert.strictEqual(validated.manifest.total_rows, 7);
    assert.strictEqual(validated.data.profiles.length, 1);
    assert.strictEqual(validated.data.profiles[0].display_name, 'Test Viewer');

    // 5B: Dry-Run Mode (Verifies plan without any network calls)
    const dryRunResult = await executeRestore({
      filePath: backupArtifactPath,
      encryptionKey: TEST_PASSPHRASE,
      confirm: false
    });
    assert.strictEqual(dryRunResult.dryRun, true, 'Dry run must report dryRun: true');
    assert.strictEqual(dryRunResult.verified, true, 'Dry run must report verified: true');

    // 5C: Live Mock Target Restoration
    const restoredTargetDb = {};
    const mockTargetFetch = async (url, options) => {
      const urlPath = new URL(url).pathname;
      const tableName = urlPath.split('/').pop();
      const body = JSON.parse(options.body);

      restoredTargetDb[tableName] = restoredTargetDb[tableName] || [];
      restoredTargetDb[tableName].push(...body);

      return {
        ok: true,
        status: 201,
        text: async () => 'OK'
      };
    };

    const restoreResult = await executeRestore({
      filePath: backupArtifactPath,
      encryptionKey: TEST_PASSPHRASE,
      targetUrl: 'https://target-test.supabase.co',
      targetKey: 'test-target-service-key',
      confirm: true,
      fetchFn: mockTargetFetch
    });

    assert(restoreResult.success, 'Restore must report success');
    for (const t of REQUIRED_TABLES) {
      assert(restoredTargetDb[t], `Target database must receive data for '${t}'`);
      assert.strictEqual(restoredTargetDb[t].length, 1, `Table '${t}' must receive exactly 1 restored record`);
    }

    console.log('  -> PASS: Decryption, checksum verification, dry-run, and mock re-insertion passed.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 5:', err);
    throw err;
  }

  cleanupTestDir();
  console.log('================================================================');
  console.log(`TEST SUITE COMPLETE: ALL ${passedCount} / 5 TEST SUITES PASSED (100%)`);
  console.log('================================================================');
}

runAllTests().catch(err => {
  console.error('[TEST SUITE CRITICAL FAILURE]:', err);
  cleanupTestDir();
  process.exit(1);
});
