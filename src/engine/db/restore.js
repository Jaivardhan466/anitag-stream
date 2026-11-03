/**
 * AniTAG Database Restoration & Verification Utility
 * 
 * Scope & Capabilities:
 * - INCLUDED OBJECTS: Application tables (`profiles`, `user_preferences`, `continue_watching`, 
 *   `watch_history`, `user_watchlist`, `user_anime_ratings`, `user_episode_ratings`).
 * - EXCLUDED OBJECTS: Underlying Supabase `auth.users` password hashes and session tokens 
 *   (managed internally by Supabase Auth), schema definitions, extensions, triggers, and RLS policies 
 *   (which are defined and applied via `001_initial_schema.sql`).
 * 
 * Security & Integrity Safeguards:
 * - Decrypts AES-256-GCM backups using BACKUP_ENCRYPTION_KEY.
 * - Strict Manifest Validation:
 *     1. manifest.status must be "SUCCESS".
 *     2. manifest.schema_version must match supported versions ('1.1.0').
 *     3. manifest.total_tables must match REQUIRED_TABLES.length.
 *     4. manifest.total_rows must match the exact sum of all table row counts.
 *     5. Every table in REQUIRED_TABLES must exist in data AND manifest.tables with status "OK".
 *     6. Every table row_count in manifest must match actual array length.
 *     7. Every table must have a valid 64-char hex SHA-256 checksum matching computed data.
 * - Production Overwrite Guard:
 *     1. Never allow live restore if production identity cannot be verified (SUPABASE_URL required).
 *     2. Normalized URL comparison strips trailing slashes, paths, and casing to prevent bypasses.
 *     3. Live restore is hard-disabled unless ALLOW_ISOLATED_TEST_RESTORE=true is set.
 *     4. Target URL must be verified as an isolated test target (e.g. test, staging, mock, localhost).
 *     5. Default operation is always read-only DRY-RUN.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptPayload, computeChecksum, REQUIRED_TABLES } from './backup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SUPPORTED_SCHEMA_VERSIONS = ['1.1.0'];

/**
 * Normalizes a URL to origin without trailing slashes or case differences
 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.origin.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Checks whether a target URL qualifies as a verified isolated test target
 */
export function isVerifiedIsolatedTestTarget(url) {
  if (!url) return false;
  const normalized = normalizeUrl(url);
  const testKeywords = ['test', 'staging', 'mock', 'localhost', '127.0.0.1'];
  return testKeywords.some(kw => normalized.includes(kw));
}

/**
 * Strictly validates and decrypts an encrypted backup file
 */
export function readAndValidateBackupFile(filePath, encryptionKey) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Backup file does not exist: ${filePath}`);
  }

  const encryptedBuffer = fs.readFileSync(filePath);
  console.log(`[Restore] Decrypting backup file (${encryptedBuffer.length} bytes)...`);

  let decryptedJson;
  try {
    const decryptedBuffer = decryptPayload(encryptedBuffer, encryptionKey);
    decryptedJson = JSON.parse(decryptedBuffer.toString('utf8'));
  } catch (err) {
    throw new Error(`Decryption failed: Invalid encryption key or corrupted backup artifact (${err.message})`);
  }

  // 1. Structure validation
  if (!decryptedJson || typeof decryptedJson !== 'object') {
    throw new Error('Malformed backup artifact: Payload must be a JSON object.');
  }
  if (!decryptedJson.manifest || typeof decryptedJson.manifest !== 'object') {
    throw new Error('Malformed backup artifact: Missing or invalid "manifest" section.');
  }
  if (!decryptedJson.data || typeof decryptedJson.data !== 'object') {
    throw new Error('Malformed backup artifact: Missing or invalid "data" section.');
  }

  const { manifest, data } = decryptedJson;

  // 2. Schema version validation
  if (!manifest.schema_version || !SUPPORTED_SCHEMA_VERSIONS.includes(manifest.schema_version)) {
    throw new Error(`Invalid schema version: Expected one of [${SUPPORTED_SCHEMA_VERSIONS.join(', ')}], got '${manifest.schema_version}'.`);
  }

  // 3. Manifest status validation
  if (manifest.status !== 'SUCCESS') {
    throw new Error(`Invalid manifest status: Expected 'SUCCESS', got '${manifest.status}'. Incomplete or failed backups cannot be restored.`);
  }

  // 4. Total tables validation
  if (typeof manifest.total_tables !== 'number' || manifest.total_tables !== REQUIRED_TABLES.length) {
    throw new Error(`Invalid total_tables count: Expected ${REQUIRED_TABLES.length}, got ${manifest.total_tables}.`);
  }

  // 5. Manifest tables section validation
  if (!manifest.tables || typeof manifest.tables !== 'object') {
    throw new Error('Malformed manifest: Missing "tables" dictionary.');
  }

  let calculatedTotalRows = 0;

  // 6. Strict table-by-table integrity and cryptographic checksum verification
  for (const table of REQUIRED_TABLES) {
    // Check existence in data
    if (!Object.prototype.hasOwnProperty.call(data, table) || !Array.isArray(data[table])) {
      throw new Error(`Incomplete backup payload: Missing required table '${table}' in data section.`);
    }

    // Check existence in manifest.tables
    if (!Object.prototype.hasOwnProperty.call(manifest.tables, table) || typeof manifest.tables[table] !== 'object') {
      throw new Error(`Incomplete manifest: Missing table entry '${table}' in manifest.tables.`);
    }

    const tableMeta = manifest.tables[table];
    const tableRows = data[table];

    // Status check
    if (tableMeta.status !== 'OK') {
      throw new Error(`Invalid table status in manifest: Table '${table}' has status '${tableMeta.status}', expected 'OK'.`);
    }

    // Row count check
    if (typeof tableMeta.row_count !== 'number' || tableMeta.row_count !== tableRows.length) {
      throw new Error(`Row count mismatch for table '${table}': Manifest reports ${tableMeta.row_count}, but payload contains ${tableRows.length} records.`);
    }

    // Checksum format and value check
    if (!tableMeta.sha256 || typeof tableMeta.sha256 !== 'string' || tableMeta.sha256.trim().length !== 64) {
      throw new Error(`Missing or invalid SHA-256 checksum for table '${table}': Expected 64-character hex string.`);
    }

    const actualChecksum = computeChecksum(tableRows);
    if (tableMeta.sha256.toLowerCase() !== actualChecksum.toLowerCase()) {
      throw new Error(`Cryptographic checksum mismatch for table '${table}': Manifest sha256 is ${tableMeta.sha256}, calculated ${actualChecksum}.`);
    }

    calculatedTotalRows += tableRows.length;
  }

  // 7. Total rows check
  if (typeof manifest.total_rows !== 'number' || manifest.total_rows !== calculatedTotalRows) {
    throw new Error(`Total rows mismatch: Manifest reports ${manifest.total_rows}, but actual row sum is ${calculatedTotalRows}.`);
  }

  console.log(`[Restore] Cryptographic integrity verified: All ${REQUIRED_TABLES.length} tables passed strict manifest & SHA-256 validation (${calculatedTotalRows} total rows).`);
  return { manifest, data };
}

/**
 * Restores tables into a verified isolated test Supabase instance via PostgREST upserts
 */
export async function executeRestore(options = {}) {
  const backupFilePath = options.filePath;
  const encryptionKey = options.encryptionKey || process.env.BACKUP_ENCRYPTION_KEY;
  const targetUrl = options.targetUrl || process.env.TARGET_SUPABASE_URL;
  const targetKey = options.targetKey || process.env.TARGET_SERVICE_ROLE_KEY;
  const isConfirmed = options.confirm === true;
  const fetchFn = options.fetchFn || fetch;
  const batchSize = options.batchSize || 100;

  if (!backupFilePath) {
    throw new Error('Missing backup file path. Pass path to anitag_backup_*.json.enc');
  }

  if (!encryptionKey) {
    throw new Error('Missing BACKUP_ENCRYPTION_KEY environment variable.');
  }

  // 1. Decrypt and strictly validate manifest & checksums
  const { manifest, data } = readAndValidateBackupFile(backupFilePath, encryptionKey);

  console.log('----------------------------------------------------------------');
  console.log('[Restore Plan]');
  console.log(`  Source Backup: ${path.basename(backupFilePath)}`);
  console.log(`  Source Date:   ${manifest.timestamp}`);
  console.log(`  Target URL:    ${targetUrl ? normalizeUrl(targetUrl) : '(None specified - Dry Run)'}`);
  console.log(`  Mode:          ${isConfirmed ? 'LIVE RESTORATION' : 'DRY RUN (Read-Only Validation)'}`);
  console.log('----------------------------------------------------------------');

  for (const table of REQUIRED_TABLES) {
    const rows = data[table] || [];
    console.log(`  - Table: ${table.padEnd(24)} ${rows.length.toString().padStart(6)} records`);
  }
  console.log('----------------------------------------------------------------');

  // Dry-run mode by default
  if (!isConfirmed) {
    console.log('[Restore Dry Run] Verification completed successfully.');
    console.log('[Restore Dry Run] To execute live writes to an isolated test database, rerun with --confirm.');
    return {
      dryRun: true,
      verified: true,
      manifest
    };
  }

  // 2. Strict Live Restoration Safety Controls (Never Write to Production)
  const prodUrl = process.env.SUPABASE_URL;
  if (!prodUrl || !prodUrl.trim()) {
    throw new Error('Safety Block: Production identity cannot be verified because SUPABASE_URL is not set in environment. Live restore is aborted to prevent accidental writes to an unverified production instance.');
  }

  if (!targetUrl || !targetKey) {
    throw new Error('Live restore aborted: Missing TARGET_SUPABASE_URL or TARGET_SERVICE_ROLE_KEY. Restoration is permitted on isolated test databases only.');
  }

  // Normalized URL comparison (strips trailing slashes, casing, etc.)
  if (normalizeUrl(targetUrl) === normalizeUrl(prodUrl)) {
    throw new Error(`Safety Violation: TARGET_SUPABASE_URL (${normalizeUrl(targetUrl)}) matches production SUPABASE_URL (${normalizeUrl(prodUrl)}). Direct restoration into production is strictly blocked.`);
  }

  // Explicit isolated test environment flag required
  const allowIsolatedTest = process.env.ALLOW_ISOLATED_TEST_RESTORE === 'true' || options.allowTestRestore === true;
  if (!allowIsolatedTest) {
    throw new Error('Safety Block: Live restore is disabled by default. To execute writes against an isolated test database, you must explicitly set ALLOW_ISOLATED_TEST_RESTORE=true in the environment.');
  }

  // Verify that the target URL represents an isolated test environment
  if (!isVerifiedIsolatedTestTarget(targetUrl) && !options.isVerifiedTestTarget) {
    throw new Error(`Safety Block: Target URL '${targetUrl}' is not recognized as an isolated test target. Live restore is restricted to verified non-production test targets only.`);
  }

  console.log(`[Restore Live] Starting live database restoration to isolated test target: ${normalizeUrl(targetUrl)}...`);

  const restorationReport = {
    restoredAt: new Date().toISOString(),
    targetUrl: normalizeUrl(targetUrl),
    tables: {}
  };

  // Upsert in strict foreign key order: profiles first, user_preferences, then child items
  for (const table of REQUIRED_TABLES) {
    const rows = data[table] || [];
    if (rows.length === 0) {
      console.log(`[Restore Live] Table '${table}' has 0 records. Skipping.`);
      restorationReport.tables[table] = { restored: 0, status: 'SKIPPED_EMPTY' };
      continue;
    }

    console.log(`[Restore Live] Restoring ${rows.length} rows to '${table}' in batches of ${batchSize}...`);
    let restoredCount = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const endpoint = `${normalizeUrl(targetUrl)}/rest/v1/${table}`;

      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'apikey': targetKey,
          'Authorization': `Bearer ${targetKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates' // Upsert behavior (idempotent)
        },
        body: JSON.stringify(batch)
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw new Error(`Failed to restore batch for table '${table}' at offset ${i}: HTTP ${res.status} - ${errorText}`);
      }

      restoredCount += batch.length;
    }

    console.log(`[Restore Live] -> '${table}' successfully restored: ${restoredCount} records.`);
    restorationReport.tables[table] = { restored: restoredCount, status: 'SUCCESS' };
  }

  console.log('================================================================');
  console.log('[Restore Complete] All tables successfully restored and verified.');
  console.log('================================================================');

  return {
    success: true,
    report: restorationReport
  };
}

// Direct execution CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const fileArg = args.find(a => !a.startsWith('--'));
  const isConfirm = args.includes('--confirm');

  if (!fileArg) {
    console.error('Usage: node src/engine/db/restore.js <path-to-anitag_backup_*.json.enc> [--confirm]');
    process.exit(1);
  }

  executeRestore({
    filePath: path.resolve(process.cwd(), fileArg),
    confirm: isConfirm
  }).catch(err => {
    console.error('[Restore Fatal Error]:', err.message);
    process.exit(1);
  });
}
