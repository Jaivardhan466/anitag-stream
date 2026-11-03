/**
 * Comprehensive Test Suite for AniTAG Database Backup & Restoration System
 * 
 * Verified Scenarios:
 * 1. Successful backup (All 7 tables exported, manifest generated, AES-256-GCM encrypted)
 * 2. Missing credentials (Fails safely without creating an insecure backup)
 * 3. Failed table export (Partial failure marks entire backup FAILED, zero partial success)
 * 4. Pagination with more rows than one API response (Multi-page cursor traversal)
 * 5. Encryption and decryption (AES-256-GCM, PBKDF2 key derivation, tamper detection)
 * 6. Restore validation (Dry-run mode, checksum verification, production overwrite guard)
 * 7. Incomplete backup detection (Detecting missing tables, corrupted records or checksum mismatches)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_TABLES,
  TABLE_PRIMARY_KEYS,
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
  console.log('STARTING ANITAG BACKUP & RESTORATION RIGOROUS VERIFICATION SUITE');
  console.log('================================================================\n');

  setupTestDir();
  let passedCount = 0;
  let backupArtifactPath = null;

  // ---------------------------------------------------------------------------
  // TEST 1: SUCCESSFUL BACKUP
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 1] Successful Backup Verification...');
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

    for (const t of REQUIRED_TABLES) {
      assert(backupResult.manifest.tables[t], `Manifest must contain table '${t}'`);
      assert(backupResult.manifest.tables[t].sha256, `Table '${t}' must have sha256 checksum`);
      assert.strictEqual(backupResult.manifest.tables[t].status, 'OK');
      assert.strictEqual(backupResult.manifest.tables[t].row_count, 1);
    }

    assert(fs.existsSync(backupResult.encryptedFilePath), 'Encrypted .enc file must exist');
    assert(fs.existsSync(backupResult.manifestFilePath), 'Public .manifest.json file must exist');

    backupArtifactPath = backupResult.encryptedFilePath;
    console.log(`  -> PASS: Successful full backup created with valid manifest and encrypted container.\n`);
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 1:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 2: MISSING CREDENTIALS (FAIL-SAFE)
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 2] Missing Credentials Fail-Safe Verification...');

    // 2A: Missing SUPABASE_URL / Service Key
    let missingCredsThrown = false;
    try {
      await executeBackup({
        supabaseUrl: '',
        serviceRoleKey: '',
        encryptionKey: TEST_PASSPHRASE,
        backupDir: TEST_BACKUP_DIR,
        throwOnError: true
      });
    } catch (err) {
      missingCredsThrown = true;
      assert(err.message.includes('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'));
    }
    assert(missingCredsThrown, 'Must throw error when database credentials are missing');

    // 2B: Missing Encryption Key
    let missingKeyThrown = false;
    try {
      await executeBackup({
        supabaseUrl: 'https://test.supabase.co',
        serviceRoleKey: 'mock-key',
        encryptionKey: '',
        backupDir: TEST_BACKUP_DIR,
        throwOnError: true
      });
    } catch (err) {
      missingKeyThrown = true;
      assert(err.message.includes('Missing BACKUP_ENCRYPTION_KEY'));
    }
    assert(missingKeyThrown, 'Must throw error when BACKUP_ENCRYPTION_KEY is missing');

    console.log('  -> PASS: System safely refuses to backup when credentials or encryption keys are missing.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 2:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 3: FAILED TABLE EXPORT (STRICT ATOMIC FAILURE)
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 3] Failed Table Export Verification (Strict Atomic Failure)...');
    const failingFetch = async (url) => {
      if (url.includes('/continue_watching')) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => 'Database connection timeout'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: 'mock-1', data: 'ok' }]
      };
    };

    let failureThrown = false;
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
      failureThrown = true;
      assert(err.message.includes("table 'continue_watching'"), 'Error message must identify failing table');
    }
    assert(failureThrown, 'Backup MUST throw error when any table export fails');

    // Verify diagnostic file was written
    const files = fs.readdirSync(TEST_BACKUP_DIR);
    const failDiagnostics = files.filter(f => f.startsWith('backup_failure_'));
    assert(failDiagnostics.length >= 1, 'Failure diagnostic file must be recorded');

    const failContent = JSON.parse(fs.readFileSync(path.join(TEST_BACKUP_DIR, failDiagnostics[0]), 'utf8'));
    assert.strictEqual(failContent.status, 'FAILED');
    assert.strictEqual(failContent.failed_table, 'continue_watching');

    console.log('  -> PASS: Table failure aborted backup, recorded diagnostic, and produced zero partial success.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 3:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 4: DETERMINISTIC PAGINATION (> 1 API RESPONSE)
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 4] Pagination with More Rows Than One API Response Verification...');
    const TOTAL_MOCK_ROWS = 1250;
    const PAGE_SIZE = 500;
    const mockDb = Array.from({ length: TOTAL_MOCK_ROWS }, (_, i) => ({
      id: `uuid-${(i + 1).toString().padStart(6, '0')}`,
      value: `record-${i + 1}`
    }));

    let pageRequests = 0;
    const mockPaginationFetch = async (url) => {
      pageRequests++;
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
      fetchFn: mockPaginationFetch
    });

    assert.strictEqual(fetchedRows.length, TOTAL_MOCK_ROWS, `Must fetch all ${TOTAL_MOCK_ROWS} records`);
    assert.strictEqual(pageRequests, 3, 'Must paginate across exactly 3 requests (500 + 500 + 250)');
    assert.strictEqual(fetchedRows[0].id, 'uuid-000001', 'First row must align');
    assert.strictEqual(fetchedRows[TOTAL_MOCK_ROWS - 1].id, 'uuid-001250', 'Last row must align');

    // Also verify user_preferences uses 'user_id' as ordering primary key
    let preferencesOrderedBy = '';
    await fetchAllRowsForTable('https://mock.supabase.co', 'mock-key', 'user_preferences', {
      pageSize: 10,
      fetchFn: async (url) => {
        preferencesOrderedBy = new URL(url).searchParams.get('order');
        return { ok: true, status: 200, json: async () => [] };
      }
    });
    assert.strictEqual(preferencesOrderedBy, 'user_id.asc', 'user_preferences must paginate using user_id primary key');

    console.log(`  -> PASS: Successfully paginated ${TOTAL_MOCK_ROWS} records across ${pageRequests} pages without omission.\n`);
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 4:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 5: ENCRYPTION AND DECRYPTION (AES-256-GCM)
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 5] AES-256-GCM Encryption and Decryption Verification...');
    const sensitivePayload = JSON.stringify({ user_id: 'uuid-1234', secret_note: 'Confidential anime bookmark' });
    const plainBuf = Buffer.from(sensitivePayload, 'utf8');

    const encrypted = encryptPayload(plainBuf, TEST_PASSPHRASE);
    assert.strictEqual(encrypted.subarray(0, 13).toString('utf8'), 'ANITAG_ENC_V1', 'Magic header must be present');
    assert.strictEqual(encrypted.length, plainBuf.length + 57, 'Container must encompass magic (13B), salt (16B), IV (12B), tag (16B), and ciphertext');

    // Decrypt with correct key
    const decrypted = decryptPayload(encrypted, TEST_PASSPHRASE);
    assert.strictEqual(decrypted.toString('utf8'), sensitivePayload, 'Decrypted text must match original');

    // Decrypt with incorrect key -> must fail authentication tag check
    let wrongKeyFailed = false;
    try {
      decryptPayload(encrypted, 'invalid_encryption_key_99999');
    } catch {
      wrongKeyFailed = true;
    }
    assert(wrongKeyFailed, 'Decryption with wrong key must throw auth tag error');

    // Tampered payload -> bit flip in ciphertext
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 2] ^= 0xAA;
    let tamperFailed = false;
    try {
      decryptPayload(tampered, TEST_PASSPHRASE);
    } catch {
      tamperFailed = true;
    }
    assert(tamperFailed, 'Decryption with tampered ciphertext must throw auth tag error');

    console.log('  -> PASS: Authenticated encryption, key enforcement, and cryptographic tamper resistance verified.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 5:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 6: RESTORE VALIDATION & SAFETY GUARDS
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 6] Restore Validation & Safety Guard Verification...');
    assert(backupArtifactPath && fs.existsSync(backupArtifactPath), 'Backup artifact from Test 1 must exist');

    // 6A: Dry-Run Mode Validation
    const dryRunResult = await executeRestore({
      filePath: backupArtifactPath,
      encryptionKey: TEST_PASSPHRASE,
      confirm: false
    });
    assert.strictEqual(dryRunResult.dryRun, true, 'Must report dryRun: true');
    assert.strictEqual(dryRunResult.verified, true, 'Must report verified: true');
    assert.strictEqual(dryRunResult.manifest.total_rows, 7);

    // 6B: Production Overwrite Guard
    process.env.SUPABASE_URL = 'https://prod.supabase.co';
    let prodOverwriteBlocked = false;
    try {
      await executeRestore({
        filePath: backupArtifactPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: 'https://prod.supabase.co', // Matches production!
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      prodOverwriteBlocked = true;
      assert(err.message.includes('matches production SUPABASE_URL'), 'Must block targetUrl matching production');
    }
    delete process.env.SUPABASE_URL;
    assert(prodOverwriteBlocked, 'Must block accidental restore into production database');

    // 6C: Live Test Restoration against Isolated Test Database
    const mockTargetRows = {};
    const mockTargetFetch = async (url, options) => {
      const tableName = new URL(url).pathname.split('/').pop();
      const records = JSON.parse(options.body);
      mockTargetRows[tableName] = mockTargetRows[tableName] || [];
      mockTargetRows[tableName].push(...records);
      return { ok: true, status: 201, text: async () => 'OK' };
    };

    const restoreResult = await executeRestore({
      filePath: backupArtifactPath,
      encryptionKey: TEST_PASSPHRASE,
      targetUrl: 'https://test-isolated.supabase.co',
      targetKey: 'test-isolated-service-key',
      confirm: true,
      fetchFn: mockTargetFetch
    });

    assert(restoreResult.success, 'Restore must report success');
    for (const t of REQUIRED_TABLES) {
      assert(mockTargetRows[t], `Target database must receive rows for '${t}'`);
      assert.strictEqual(mockTargetRows[t].length, 1, `Table '${t}' must receive exactly 1 restored record`);
    }

    console.log('  -> PASS: Restore dry-run verified, production overwrite guard blocked execution, and test restore succeeded.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 6:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 7: INCOMPLETE BACKUP DETECTION
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 7] Incomplete Backup Detection Verification...');

    // 7A: Payload missing a required table
    const incompletePayload = {
      manifest: {
        schema_version: '1.1.0',
        timestamp: new Date().toISOString(),
        status: 'SUCCESS',
        total_tables: 6,
        total_rows: 6,
        tables: {
          profiles: { row_count: 1, sha256: computeChecksum([{ id: '1' }]) }
          // continue_watching is missing!
        }
      },
      data: {
        profiles: [{ id: '1' }]
      }
    };
    const incompleteBuffer = encryptPayload(Buffer.from(JSON.stringify(incompletePayload), 'utf8'), TEST_PASSPHRASE);
    const incompleteFilePath = path.join(TEST_BACKUP_DIR, 'incomplete_backup.json.enc');
    fs.writeFileSync(incompleteFilePath, incompleteBuffer);

    let incompleteDetected = false;
    try {
      readAndValidateBackupFile(incompleteFilePath, TEST_PASSPHRASE);
    } catch (err) {
      incompleteDetected = true;
      assert(err.message.includes("missing required table: 'user_preferences'") || err.message.includes("missing required table: 'continue_watching'"));
    }
    assert(incompleteDetected, 'Restore validation must fail when a required table is missing from backup');

    // 7B: Checksum Mismatch Detection
    const corruptedPayload = {
      manifest: {
        schema_version: '1.1.0',
        timestamp: new Date().toISOString(),
        status: 'SUCCESS',
        total_tables: 7,
        total_rows: 7,
        tables: {
          profiles: { row_count: 1, sha256: 'fake_corrupted_checksum_hash_1234567890' },
          user_preferences: { row_count: 0, sha256: computeChecksum([]) },
          continue_watching: { row_count: 0, sha256: computeChecksum([]) },
          watch_history: { row_count: 0, sha256: computeChecksum([]) },
          user_watchlist: { row_count: 0, sha256: computeChecksum([]) },
          user_anime_ratings: { row_count: 0, sha256: computeChecksum([]) },
          user_episode_ratings: { row_count: 0, sha256: computeChecksum([]) }
        }
      },
      data: {
        profiles: [{ id: '1', display_name: 'Altered Data' }],
        user_preferences: [],
        continue_watching: [],
        watch_history: [],
        user_watchlist: [],
        user_anime_ratings: [],
        user_episode_ratings: []
      }
    };
    const corruptedBuffer = encryptPayload(Buffer.from(JSON.stringify(corruptedPayload), 'utf8'), TEST_PASSPHRASE);
    const corruptedFilePath = path.join(TEST_BACKUP_DIR, 'corrupted_backup.json.enc');
    fs.writeFileSync(corruptedFilePath, corruptedBuffer);

    let checksumMismatchDetected = false;
    try {
      readAndValidateBackupFile(corruptedFilePath, TEST_PASSPHRASE);
    } catch (err) {
      checksumMismatchDetected = true;
      assert(err.message.includes('Checksum mismatch for table \'profiles\''));
    }
    assert(checksumMismatchDetected, 'Restore validation must fail when data does not match manifest SHA-256');

    console.log('  -> PASS: Successfully detected incomplete backup and checksum tampering.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 7:', err);
    throw err;
  }

  cleanupTestDir();
  console.log('================================================================');
  console.log(`VERIFICATION COMPLETE: ALL ${passedCount} / 7 TESTS PASSED WITH 100% SUCCESS`);
  console.log('================================================================');
}

runAllTests().catch(err => {
  console.error('[CRITICAL FAILURE IN TEST SUITE]:', err);
  cleanupTestDir();
  process.exit(1);
});
