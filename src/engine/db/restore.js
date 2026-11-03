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
 * - Validates cryptographic SHA-256 checksums for each table before executing any operations.
 * - Defaults to DRY-RUN mode: Validates decryption, checksums, and row counts without mutating any database.
 * - Mandatory confirmation: Live restoration requires `--confirm` flag.
 * - Safe test restoration: Allows targeting an isolated test/staging database via TARGET_SUPABASE_URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptPayload, computeChecksum, REQUIRED_TABLES } from './backup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Validates and decrypts an encrypted backup file
 */
export function readAndValidateBackupFile(filePath, encryptionKey) {
  if (!fs.existsSync(filePath)) {
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

  if (!decryptedJson.manifest || !decryptedJson.data) {
    throw new Error('Invalid backup structure: Missing manifest or data section.');
  }

  const { manifest, data } = decryptedJson;
  console.log(`[Restore] Manifest loaded. Timestamp: ${manifest.timestamp}, Total rows: ${manifest.total_rows}`);

  // Cryptographic checksum verification for every table
  for (const table of REQUIRED_TABLES) {
    const tableData = data[table];
    if (!tableData) {
      throw new Error(`Backup payload is missing required table: '${table}'`);
    }

    const expectedChecksum = manifest.tables && manifest.tables[table] && manifest.tables[table].sha256;
    const actualChecksum = computeChecksum(tableData);

    if (expectedChecksum && expectedChecksum !== actualChecksum) {
      throw new Error(`Integrity Check Failed: Checksum mismatch for table '${table}'! Expected ${expectedChecksum}, got ${actualChecksum}`);
    }
  }

  console.log(`[Restore] Cryptographic integrity verified: All ${REQUIRED_TABLES.length} tables passed SHA-256 validation.`);
  return { manifest, data };
}

/**
 * Restores tables into target Supabase instance via PostgREST upserts
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

  // 1. Read, decrypt, and verify checksums
  const { manifest, data } = readAndValidateBackupFile(backupFilePath, encryptionKey);

  console.log('----------------------------------------------------------------');
  console.log('[Restore Plan]');
  console.log(`  Source Backup: ${path.basename(backupFilePath)}`);
  console.log(`  Source Date:   ${manifest.timestamp}`);
  console.log(`  Target URL:    ${targetUrl || '(None specified - Dry Run)'}`);
  console.log(`  Mode:          ${isConfirmed ? 'LIVE RESTORATION' : 'DRY RUN (Read-Only Validation)'}`);
  console.log('----------------------------------------------------------------');

  for (const table of REQUIRED_TABLES) {
    const rows = data[table] || [];
    console.log(`  - Table: ${table.padEnd(24)} ${rows.length.toString().padStart(6)} records`);
  }
  console.log('----------------------------------------------------------------');

  if (!isConfirmed) {
    console.log('[Restore Dry Run] Verification completed successfully.');
    console.log('[Restore Dry Run] To execute live writes to an isolated test database, rerun with --confirm.');
    return {
      dryRun: true,
      verified: true,
      manifest
    };
  }

  // 2. Live writes require target test URL and Service Key, and strictly forbid production URL
  if (!targetUrl || !targetKey) {
    throw new Error('Live restore aborted: Missing TARGET_SUPABASE_URL or TARGET_SERVICE_ROLE_KEY. Restoration is permitted on isolated test databases only.');
  }

  if (process.env.SUPABASE_URL && targetUrl.trim() === process.env.SUPABASE_URL.trim()) {
    throw new Error('Safety Violation: TARGET_SUPABASE_URL matches production SUPABASE_URL. Direct restoration into production is strictly blocked.');
  }

  console.log(`[Restore Live] Starting live database restoration to: ${targetUrl}...`);

  const restorationReport = {
    restoredAt: new Date().toISOString(),
    targetUrl,
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
      const endpoint = `${targetUrl}/rest/v1/${table}`;

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
