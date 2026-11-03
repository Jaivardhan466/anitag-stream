/**
 * Rigorous Test Suite for AniTAG Database Backup & Restoration System
 * 
 * Verified Scenarios:
 * 1. Successful backup (All 7 tables, manifest generation, AES-256-GCM encryption)
 * 2. Missing credentials (Fails safely without creating an insecure backup)
 * 3. Failed table export (Partial failure marks entire backup FAILED, zero partial success)
 * 4. Pagination with more rows than one API response (Multi-page cursor traversal)
 * 5. Encryption and decryption (AES-256-GCM, PBKDF2 key derivation, bit tamper detection)
 * 6. Restore dry-run & default operation guards:
 *    - 6A: Valid dry-run succeeds with manifest verification and zero network writes
 *    - 6B: Default operation without --confirm is strictly dry-run
 * 7. Restore production safety & exact allowlist guards:
 *    - 7A: Missing SUPABASE_URL during live restore (blocked: unverified production identity)
 *    - 7B: Missing RESTORE_ALLOWED_TARGET_URL during live restore (blocked: allowlist required)
 *    - 7C: Production URL match rejected (TARGET_SUPABASE_URL === SUPABASE_URL blocked)
 *    - 7D: Trailing slash & casing URL normalization verified on both production and target URLs
 *    - 7E: Different hostname rejected (even with 'test' keyword, non-allowlisted host is blocked)
 *    - 7F: Live restore blocked without explicit opt-in flag (ALLOW_ISOLATED_TEST_RESTORE=true)
 *    - 7G: Exact allowlist match succeeds
 * 8. Strict manifest validation:
 *    - 8A: Invalid manifest status (status !== 'SUCCESS')
 *    - 8B: Unexpected schema version (schema_version !== '1.1.0')
 *    - 8C: Missing table from payload data
 *    - 8D: Missing table entry from manifest tables
 *    - 8E: Missing or invalid SHA-256 checksum
 *    - 8F: Incorrect table row count
 *    - 8G: Incorrect total_rows in manifest
 *    - 8H: Checksum mismatch (data tampering detection)
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
  executeRestore,
  normalizeUrl,
  SUPPORTED_SCHEMA_VERSIONS
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
  console.log('STARTING RIGOROUS BACKUP & RESTORATION VALIDATION TEST SUITE');
  console.log('================================================================\n');

  setupTestDir();
  let passedCount = 0;
  let validBackupPath = null;

  // Helper to build a valid encrypted test backup payload
  function createTestBackupFile(fileName, overrideManifest = {}, overrideData = {}) {
    const defaultData = {
      profiles: [{ id: 'user-1', display_name: 'Test Viewer' }],
      user_preferences: [{ user_id: 'user-1', theme_id: 'monochrome', theme_mode: 'dark' }],
      continue_watching: [{ id: 'cw-1', user_id: 'user-1', anime_id: 'bleach', episode_num: 1 }],
      watch_history: [{ id: 'wh-1', user_id: 'user-1', anime_id: 'bleach', episode_num: 1 }],
      user_watchlist: [{ id: 'wl-1', user_id: 'user-1', anime_id: 'bleach' }],
      user_anime_ratings: [{ id: 'ar-1', user_id: 'user-1', anime_id: 'bleach', rating: 9.0 }],
      user_episode_ratings: [{ id: 'er-1', user_id: 'user-1', anime_id: 'bleach', episode_num: 1, rating: 9.0 }]
    };

    const finalData = { ...defaultData, ...overrideData };

    const defaultManifestTables = {};
    let sumRows = 0;
    for (const t of REQUIRED_TABLES) {
      const rows = finalData[t] || [];
      sumRows += rows.length;
      defaultManifestTables[t] = {
        row_count: rows.length,
        sha256: computeChecksum(rows),
        status: 'OK'
      };
    }

    const finalManifest = {
      schema_version: '1.1.0',
      timestamp: new Date().toISOString(),
      status: 'SUCCESS',
      total_tables: REQUIRED_TABLES.length,
      total_rows: sumRows,
      tables: defaultManifestTables,
      encryption: { algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 100000, magic: 'ANITAG_ENC_V1' },
      ...overrideManifest
    };

    const payload = { manifest: finalManifest, data: finalData };
    const encBuffer = encryptPayload(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), TEST_PASSPHRASE);
    const filePath = path.join(TEST_BACKUP_DIR, fileName);
    fs.writeFileSync(filePath, encBuffer);
    return { filePath, manifest: finalManifest, data: finalData };
  }

  // ---------------------------------------------------------------------------
  // TEST 1: SUCCESSFUL FULL BACKUP
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
          return { ok: true, status: 200, json: async () => mockDbData[table] || [] };
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
      assert.strictEqual(backupResult.manifest.tables[t].sha256.length, 64, `Table '${t}' must have 64-char sha256 checksum`);
      assert.strictEqual(backupResult.manifest.tables[t].status, 'OK');
      assert.strictEqual(backupResult.manifest.tables[t].row_count, 1);
    }

    assert(fs.existsSync(backupResult.encryptedFilePath), 'Encrypted .enc file must exist');
    assert(fs.existsSync(backupResult.manifestFilePath), 'Public .manifest.json file must exist');

    validBackupPath = backupResult.encryptedFilePath;
    console.log(`  -> PASS: Full successful backup produced with valid manifest and encrypted container.\n`);
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

    let missingUrlThrown = false;
    try {
      await executeBackup({
        supabaseUrl: '',
        serviceRoleKey: '',
        encryptionKey: TEST_PASSPHRASE,
        backupDir: TEST_BACKUP_DIR,
        throwOnError: true
      });
    } catch (err) {
      missingUrlThrown = true;
      assert(err.message.includes('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'));
    }
    assert(missingUrlThrown, 'Must throw error when database credentials are empty');

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
    assert(missingKeyThrown, 'Must throw error when BACKUP_ENCRYPTION_KEY is empty');

    console.log('  -> PASS: System safely refuses to run backup when credentials or keys are missing.\n');
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
      return { ok: true, status: 200, json: async () => [{ id: 'mock-1' }] };
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
      assert(err.message.includes("table 'continue_watching'"));
    }
    assert(failureThrown, 'Backup must throw error when any table export fails');

    const files = fs.readdirSync(TEST_BACKUP_DIR);
    const failLogs = files.filter(f => f.startsWith('backup_failure_'));
    assert(failLogs.length >= 1, 'Failure diagnostic file must be recorded on disk');

    const failContent = JSON.parse(fs.readFileSync(path.join(TEST_BACKUP_DIR, failLogs[0]), 'utf8'));
    assert.strictEqual(failContent.status, 'FAILED');
    assert.strictEqual(failContent.failed_table, 'continue_watching');

    console.log('  -> PASS: Table failure immediately aborted backup; diagnostic logged; no partial success.\n');
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

      return { ok: true, status: 200, json: async () => slice };
    };

    const fetchedRows = await fetchAllRowsForTable('https://mock.supabase.co', 'mock-key', 'watch_history', {
      pageSize: PAGE_SIZE,
      fetchFn: mockPaginationFetch
    });

    assert.strictEqual(fetchedRows.length, TOTAL_MOCK_ROWS);
    assert.strictEqual(pageRequests, 3, 'Must paginate across exactly 3 requests (500 + 500 + 250)');
    assert.strictEqual(fetchedRows[0].id, 'uuid-000001');
    assert.strictEqual(fetchedRows[TOTAL_MOCK_ROWS - 1].id, 'uuid-001250');

    // Verify user_preferences uses user_id for ordering
    let preferencesOrderParam = '';
    await fetchAllRowsForTable('https://mock.supabase.co', 'mock-key', 'user_preferences', {
      pageSize: 10,
      fetchFn: async (url) => {
        preferencesOrderParam = new URL(url).searchParams.get('order');
        return { ok: true, status: 200, json: async () => [] };
      }
    });
    assert.strictEqual(preferencesOrderParam, 'user_id.asc', 'user_preferences must paginate using user_id primary key');

    console.log(`  -> PASS: Correctly paginated ${TOTAL_MOCK_ROWS} records across ${pageRequests} pages using primary key cursor.\n`);
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
    const originalSecret = JSON.stringify({ note: 'Confidential watch history', ts: Date.now() });
    const plainBuf = Buffer.from(originalSecret, 'utf8');

    const encrypted = encryptPayload(plainBuf, TEST_PASSPHRASE);
    assert.strictEqual(encrypted.subarray(0, 13).toString('utf8'), 'ANITAG_ENC_V1', 'Magic header must match');
    assert.strictEqual(encrypted.length, plainBuf.length + 57, 'Container must encompass magic (13B), salt (16B), IV (12B), tag (16B), and ciphertext');

    const decrypted = decryptPayload(encrypted, TEST_PASSPHRASE);
    assert.strictEqual(decrypted.toString('utf8'), originalSecret, 'Decrypted text must match original');

    // Wrong passphrase must fail
    let wrongKeyThrown = false;
    try {
      decryptPayload(encrypted, 'invalid_passphrase_0000');
    } catch {
      wrongKeyThrown = true;
    }
    assert(wrongKeyThrown, 'Decryption with incorrect key must fail auth tag verification');

    // Tampered ciphertext must fail
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 2] ^= 0x55;
    let tamperThrown = false;
    try {
      decryptPayload(tampered, TEST_PASSPHRASE);
    } catch {
      tamperThrown = true;
    }
    assert(tamperThrown, 'Decryption with tampered ciphertext must fail auth tag verification');

    console.log('  -> PASS: Authenticated encryption, key derivation, and tamper detection verified.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 5:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 6: RESTORE DRY-RUN & DEFAULT OPERATION GUARDS
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 6] Restore Dry-Run & Default Operation Guards...');
    assert(validBackupPath && fs.existsSync(validBackupPath), 'Valid backup artifact must exist');

    // 6A: Explicit dry-run (confirm: false)
    const dryRunResult = await executeRestore({
      filePath: validBackupPath,
      encryptionKey: TEST_PASSPHRASE,
      confirm: false
    });

    assert.strictEqual(dryRunResult.dryRun, true, 'Dry-run must report dryRun: true');
    assert.strictEqual(dryRunResult.verified, true, 'Dry-run must report verified: true');
    assert.strictEqual(dryRunResult.manifest.total_rows, 7);
    assert.strictEqual(dryRunResult.manifest.status, 'SUCCESS');

    // 6B: Default operation without confirm flag remains dry-run
    const defaultResult = await executeRestore({
      filePath: validBackupPath,
      encryptionKey: TEST_PASSPHRASE
      // confirm is omitted
    });
    assert.strictEqual(defaultResult.dryRun, true, 'Default execution without --confirm must remain dry-run');
    assert.strictEqual(defaultResult.verified, true, 'Default execution must perform verification');

    console.log('  -> PASS: Valid dry-run and default non-destructive operation verified.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 6:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 7: RESTORE TARGET SECURITY & EXACT ALLOWLIST GUARDS
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 7] Restore Target Security & Exact Allowlist Guards...');

    const PROD_URL = 'https://prod-project.supabase.co';
    const ALLOWED_TEST_URL = 'https://isolated-staging.supabase.co';

    // 7A: Missing production identity: SUPABASE_URL not set
    delete process.env.SUPABASE_URL;
    process.env.RESTORE_ALLOWED_TARGET_URL = ALLOWED_TEST_URL;
    process.env.ALLOW_ISOLATED_TEST_RESTORE = 'true';
    let missingProdThrown = false;
    try {
      await executeRestore({
        filePath: validBackupPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: ALLOWED_TEST_URL,
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      missingProdThrown = true;
      assert(err.message.includes('Production identity cannot be verified because SUPABASE_URL is not set'));
    }
    assert(missingProdThrown, 'Live restore must be blocked if SUPABASE_URL is missing');

    // 7B: Missing allowlist: RESTORE_ALLOWED_TARGET_URL not set
    process.env.SUPABASE_URL = PROD_URL;
    delete process.env.RESTORE_ALLOWED_TARGET_URL;
    let missingAllowlistThrown = false;
    try {
      await executeRestore({
        filePath: validBackupPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: ALLOWED_TEST_URL,
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      missingAllowlistThrown = true;
      assert(err.message.includes('RESTORE_ALLOWED_TARGET_URL is not configured'));
    }
    assert(missingAllowlistThrown, 'Live restore must be blocked if RESTORE_ALLOWED_TARGET_URL is missing');

    // 7C: Production URL match rejected
    process.env.RESTORE_ALLOWED_TARGET_URL = ALLOWED_TEST_URL;
    let prodTargetThrown = false;
    try {
      await executeRestore({
        filePath: validBackupPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: PROD_URL,
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      prodTargetThrown = true;
      assert(err.message.includes('matches production SUPABASE_URL'));
    }
    assert(prodTargetThrown, 'Target matching production URL must be strictly blocked');

    // 7D: Trailing slash & casing URL normalization
    // Target has trailing slash matching production
    let prodTrailingSlashThrown = false;
    try {
      await executeRestore({
        filePath: validBackupPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: `${PROD_URL}/`, // Trailing slash!
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      prodTrailingSlashThrown = true;
      assert(err.message.includes('matches production SUPABASE_URL'));
    }
    assert(prodTrailingSlashThrown, 'Target matching production with trailing slash must be normalized and blocked');

    // 7E: Different hostname (reject non-allowlisted targets, even if host has "test" or "mock")
    let differentHostnameThrown = false;
    try {
      await executeRestore({
        filePath: validBackupPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: 'https://test-unauthorized.supabase.co', // Has 'test' in name, but not in allowlist!
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      differentHostnameThrown = true;
      assert(err.message.includes('does not match the configured allowlist RESTORE_ALLOWED_TARGET_URL'));
    }
    assert(differentHostnameThrown, 'Hostname keyword heuristics must be eliminated; non-allowlisted hosts must be blocked');

    // 7F: Live restore blocked without explicit opt-in flag (ALLOW_ISOLATED_TEST_RESTORE=true)
    delete process.env.ALLOW_ISOLATED_TEST_RESTORE;
    let missingOptInThrown = false;
    try {
      await executeRestore({
        filePath: validBackupPath,
        encryptionKey: TEST_PASSPHRASE,
        targetUrl: ALLOWED_TEST_URL,
        targetKey: 'test-key',
        confirm: true
      });
    } catch (err) {
      missingOptInThrown = true;
      assert(err.message.includes('ALLOW_ISOLATED_TEST_RESTORE=true'));
    }
    assert(missingOptInThrown, 'Live restore must remain blocked if ALLOW_ISOLATED_TEST_RESTORE is not true');

    // 7G: Exact allowlist match succeeds (including trailing slash & casing normalization)
    process.env.ALLOW_ISOLATED_TEST_RESTORE = 'true';
    const mockTargetRows = {};
    const mockTargetFetch = async (url, options) => {
      const tableName = new URL(url).pathname.split('/').pop();
      const records = JSON.parse(options.body);
      mockTargetRows[tableName] = mockTargetRows[tableName] || [];
      mockTargetRows[tableName].push(...records);
      return { ok: true, status: 201, text: async () => 'OK' };
    };

    // Pass uppercase protocol and trailing slash in targetUrl; normalizeUrl normalizes and matches allowlist!
    const validRestoreResult = await executeRestore({
      filePath: validBackupPath,
      encryptionKey: TEST_PASSPHRASE,
      targetUrl: 'HTTPS://ISOLATED-STAGING.SUPABASE.CO/',
      targetKey: 'test-isolated-key',
      confirm: true,
      fetchFn: mockTargetFetch
    });

    assert(validRestoreResult.success, 'Restore must report success for exact allowlisted target');
    for (const t of REQUIRED_TABLES) {
      assert(mockTargetRows[t], `Target database must receive rows for '${t}'`);
      assert.strictEqual(mockTargetRows[t].length, 1);
    }

    // Clean up environment variables
    delete process.env.SUPABASE_URL;
    delete process.env.RESTORE_ALLOWED_TARGET_URL;
    delete process.env.ALLOW_ISOLATED_TEST_RESTORE;

    console.log('  -> PASS: All target security guards verified: missing identity, missing allowlist, prod match, normalization, different host, and exact allowlist match.\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 7:', err);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // TEST 8: STRICT MANIFEST VALIDATION SUITE
  // ---------------------------------------------------------------------------
  try {
    console.log('[TEST 8] Strict Manifest Validation Suite...');

    // 8A: Invalid manifest status (e.g. FAILED)
    const { filePath: failedStatusFile } = createTestBackupFile('bad_status.json.enc', { status: 'FAILED' });
    let badStatusCaught = false;
    try {
      readAndValidateBackupFile(failedStatusFile, TEST_PASSPHRASE);
    } catch (err) {
      badStatusCaught = true;
      assert(err.message.includes("Invalid manifest status: Expected 'SUCCESS', got 'FAILED'"));
    }
    assert(badStatusCaught, 'Must reject backup with status != SUCCESS');

    // 8B: Unexpected schema version
    const { filePath: badVerFile } = createTestBackupFile('bad_version.json.enc', { schema_version: '2.0.0' });
    let badVerCaught = false;
    try {
      readAndValidateBackupFile(badVerFile, TEST_PASSPHRASE);
    } catch (err) {
      badVerCaught = true;
      assert(err.message.includes("Invalid schema version: Expected one of [1.1.0], got '2.0.0'"));
    }
    assert(badVerCaught, 'Must reject unexpected schema versions');

    // 8C: Missing required table from payload data
    const { filePath: missingDataFile } = createTestBackupFile('missing_data_table.json.enc', {}, { profiles: undefined });
    let missingDataCaught = false;
    try {
      readAndValidateBackupFile(missingDataFile, TEST_PASSPHRASE);
    } catch (err) {
      missingDataCaught = true;
      assert(err.message.includes("Missing required table 'profiles' in data section"));
    }
    assert(missingDataCaught, 'Must reject backup when a required table is missing from data');

    // 8D: Missing table entry from manifest tables
    const { manifest: baseManifest } = createTestBackupFile('temp_base.json.enc');
    const incompleteManifestTables = { ...baseManifest.tables };
    delete incompleteManifestTables['user_watchlist'];

    const { filePath: missingManifestTableFile } = createTestBackupFile('missing_manifest_table.json.enc', {
      tables: incompleteManifestTables
    });
    let missingManifestTableCaught = false;
    try {
      readAndValidateBackupFile(missingManifestTableFile, TEST_PASSPHRASE);
    } catch (err) {
      missingManifestTableCaught = true;
      assert(err.message.includes("Missing table entry 'user_watchlist' in manifest.tables"));
    }
    assert(missingManifestTableCaught, 'Must reject manifest missing a required table entry');

    // 8E: Missing or invalid SHA-256 checksum
    const emptyChecksumTables = { ...baseManifest.tables };
    emptyChecksumTables['continue_watching'] = {
      ...emptyChecksumTables['continue_watching'],
      sha256: ''
    };
    const { filePath: emptyChecksumFile } = createTestBackupFile('empty_checksum.json.enc', {
      tables: emptyChecksumTables
    });
    let emptyChecksumCaught = false;
    try {
      readAndValidateBackupFile(emptyChecksumFile, TEST_PASSPHRASE);
    } catch (err) {
      emptyChecksumCaught = true;
      assert(err.message.includes("Missing or invalid SHA-256 checksum for table 'continue_watching'"));
    }
    assert(emptyChecksumCaught, 'Must reject missing or empty SHA-256 checksum');

    // 8F: Incorrect table row count
    const wrongCountTables = { ...baseManifest.tables };
    wrongCountTables['watch_history'] = {
      ...wrongCountTables['watch_history'],
      row_count: 99 // Actual is 1, manifest says 99!
    };
    const { filePath: wrongCountFile } = createTestBackupFile('wrong_row_count.json.enc', {
      tables: wrongCountTables
    });
    let wrongCountCaught = false;
    try {
      readAndValidateBackupFile(wrongCountFile, TEST_PASSPHRASE);
    } catch (err) {
      wrongCountCaught = true;
      assert(err.message.includes("Row count mismatch for table 'watch_history'"));
    }
    assert(wrongCountCaught, 'Must reject row count mismatch between manifest and payload');

    // 8G: Incorrect total_rows
    const { filePath: wrongTotalRowsFile } = createTestBackupFile('wrong_total_rows.json.enc', {
      total_rows: 9999 // Actual sum is 7!
    });
    let wrongTotalRowsCaught = false;
    try {
      readAndValidateBackupFile(wrongTotalRowsFile, TEST_PASSPHRASE);
    } catch (err) {
      wrongTotalRowsCaught = true;
      assert(err.message.includes("Total rows mismatch: Manifest reports 9999, but actual row sum is 7"));
    }
    assert(wrongTotalRowsCaught, 'Must reject total_rows mismatch in manifest');

    // 8H: Tampered table data resulting in checksum mismatch
    // Use baseManifest.tables (where user_anime_ratings checksum was computed for rating 9.0),
    // but pass rating 1.0 in payload data so the manifest checksum does not match the actual data
    const tamperedManifestTables = { ...baseManifest.tables };
    const { filePath: tamperedDataFile } = createTestBackupFile('tampered_checksum.json.enc', {
      tables: tamperedManifestTables
    }, {
      user_anime_ratings: [{ id: 'ar-1', user_id: 'user-1', anime_id: 'bleach', rating: 1.0 }] // Altered rating!
    });
    let checksumMismatchCaught = false;
    try {
      readAndValidateBackupFile(tamperedDataFile, TEST_PASSPHRASE);
    } catch (err) {
      checksumMismatchCaught = true;
      assert(err.message.includes("Cryptographic checksum mismatch for table 'user_anime_ratings'"));
    }
    assert(checksumMismatchCaught, 'Must detect content tampering and fail SHA-256 validation');

    console.log('  -> PASS: All 8 strict manifest validation checks passed (status, schema, tables, checksums, counts).\n');
    passedCount++;
  } catch (err) {
    console.error('  -> FAIL in TEST 8:', err);
    throw err;
  }

  cleanupTestDir();
  console.log('================================================================');
  console.log(`VERIFICATION COMPLETE: ALL ${passedCount} / 8 TEST SUITES (18 SPECIFIC SCENARIOS) PASSED (100%)`);
  console.log('================================================================');
}

runAllTests().catch(err => {
  console.error('[CRITICAL FAILURE IN TEST SUITE]:', err);
  cleanupTestDir();
  process.exit(1);
});
