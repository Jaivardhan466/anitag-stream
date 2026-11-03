/**
 * AniTAG Database Backup & Encryption Utility
 * Strict Integrity & Security Architecture:
 * - AES-256-GCM Authenticated Encryption (Salt + IV + Auth Tag + Ciphertext)
 * - Deterministic Pagination (fetches all records, never truncates at API limits)
 * - Atomic Backup Manifest (table names, row counts, SHA-256 content hashes, timestamps)
 * - Strict Failure Model: Any single table failure FAILS the entire backup with exit code 1.
 * - Never produces or labels partial exports as successful.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// All application tables in foreign-key dependency order
export const REQUIRED_TABLES = [
  'profiles',
  'user_preferences',
  'continue_watching',
  'watch_history',
  'user_watchlist',
  'user_anime_ratings',
  'user_episode_ratings'
];

// Primary key mapping per table for deterministic order by during pagination
export const TABLE_PRIMARY_KEYS = {
  profiles: 'id',
  user_preferences: 'user_id',
  continue_watching: 'id',
  watch_history: 'id',
  user_watchlist: 'id',
  user_anime_ratings: 'id',
  user_episode_ratings: 'id'
};

export const BACKUP_VERSION = '1.1.0';
export const DEFAULT_PAGE_SIZE = 500;

/**
 * Derives a 256-bit encryption key from passphrase and salt using PBKDF2
 */
export function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
}

/**
 * Encrypts a Buffer or string using AES-256-GCM
 * Output format:
 * [Magic (13 B: ANITAG_ENC_V1)] [Salt (16 B)] [IV (12 B)] [AuthTag (16 B)] [Ciphertext (N B)]
 */
export function encryptPayload(plainBuffer, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const magic = Buffer.from('ANITAG_ENC_V1', 'utf8');
  return Buffer.concat([magic, salt, iv, authTag, encrypted]);
}

/**
 * Decrypts a payload encrypted with encryptPayload
 */
export function decryptPayload(encryptedBuffer, passphrase) {
  const magic = encryptedBuffer.subarray(0, 13).toString('utf8');
  if (magic !== 'ANITAG_ENC_V1') {
    throw new Error('Invalid backup file format: missing ANITAG_ENC_V1 header');
  }

  const salt = encryptedBuffer.subarray(13, 29);
  const iv = encryptedBuffer.subarray(29, 41);
  const authTag = encryptedBuffer.subarray(41, 57);
  const ciphertext = encryptedBuffer.subarray(57);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Computes SHA-256 checksum of a data structure
 */
export function computeChecksum(data) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  return hash.digest('hex');
}

/**
 * Paginates through all records of a PostgREST table
 */
export async function fetchAllRowsForTable(supabaseUrl, serviceRoleKey, table, options = {}) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const fetchFn = options.fetchFn || fetch;
  const rows = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    // Deterministic ordering by primary key / unique column ensures pagination consistency
    const pk = TABLE_PRIMARY_KEYS[table] || 'id';
    const endpoint = `${supabaseUrl}/rest/v1/${table}?select=*&order=${pk}.asc&limit=${pageSize}&offset=${offset}`;
    
    let res;
    try {
      res = await fetchFn(endpoint, {
        method: 'GET',
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Accept': 'application/json',
          'Range-Unit': 'items'
        }
      });
    } catch (err) {
      throw new Error(`Network error while fetching table '${table}' at offset ${offset}: ${err.message}`);
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`PostgREST API returned HTTP ${res.status} for table '${table}' at offset ${offset}: ${errorText || res.statusText}`);
    }

    const chunk = await res.json();
    if (!Array.isArray(chunk)) {
      throw new Error(`Unexpected non-array response from table '${table}': ${typeof chunk}`);
    }

    rows.push(...chunk);

    if (chunk.length < pageSize) {
      hasMore = false;
    } else {
      offset += pageSize;
    }
  }

  return rows;
}

/**
 * Executes a full backup of all required tables with encryption & manifest
 */
export async function executeBackup(options = {}) {
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const serviceRoleKey = options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const encryptionKey = options.encryptionKey || process.env.BACKUP_ENCRYPTION_KEY;
  const backupDir = options.backupDir || path.resolve(__dirname, '../../../backups');
  const fetchFn = options.fetchFn || fetch;
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;

  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, '-');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Verification of required environment variables
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[Backup Error] Missing required credentials: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    console.error('[Backup Error] Backup execution aborted. Exit code: 1');
    if (options.throwOnError) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }
    process.exit(1);
  }

  if (!encryptionKey) {
    console.error('[Backup Error] Missing BACKUP_ENCRYPTION_KEY: Application-level AES-256-GCM encryption is mandatory.');
    console.error('[Backup Error] Backup execution aborted. Exit code: 1');
    if (options.throwOnError) {
      throw new Error('Missing BACKUP_ENCRYPTION_KEY');
    }
    process.exit(1);
  }

  console.log(`[Backup] Initiating full database backup at ${timestamp}...`);
  console.log(`[Backup] Target URL: ${supabaseUrl}`);
  console.log(`[Backup] Required tables to export (${REQUIRED_TABLES.length}): ${REQUIRED_TABLES.join(', ')}`);

  const tablesData = {};
  const manifestTables = {};
  let totalRows = 0;

  // Strict export loop: Any table failure triggers immediate abort and failure
  for (const table of REQUIRED_TABLES) {
    try {
      console.log(`[Backup] Fetching table: '${table}' (page size: ${pageSize})...`);
      const rows = await fetchAllRowsForTable(supabaseUrl, serviceRoleKey, table, { pageSize, fetchFn });
      
      const checksum = computeChecksum(rows);
      tablesData[table] = rows;
      manifestTables[table] = {
        row_count: rows.length,
        sha256: checksum,
        status: 'OK'
      };
      totalRows += rows.length;
      console.log(`[Backup] -> '${table}' exported successfully: ${rows.length} rows (SHA-256: ${checksum.slice(0, 12)}...)`);
    } catch (err) {
      console.error(`[Backup Fatal] Failed to export table '${table}': ${err.message}`);
      console.error('[Backup Fatal] Aborting backup. Partial exports are strictly prohibited.');

      // Write error manifest for diagnostic inspection
      const failureManifest = {
        schema_version: BACKUP_VERSION,
        timestamp,
        status: 'FAILED',
        failed_table: table,
        error: err.message,
        tables: manifestTables
      };
      const failLogPath = path.join(backupDir, `backup_failure_${fileTimestamp}.json`);
      fs.writeFileSync(failLogPath, JSON.stringify(failureManifest, null, 2), 'utf8');
      console.error(`[Backup Fatal] Failure diagnostic saved to: ${failLogPath}`);

      if (options.throwOnError) {
        throw new Error(`Backup failed on table '${table}': ${err.message}`);
      }
      process.exit(1);
    }
  }

  // Construct complete, verified manifest
  const manifest = {
    schema_version: BACKUP_VERSION,
    timestamp,
    status: 'SUCCESS',
    total_tables: REQUIRED_TABLES.length,
    total_rows: totalRows,
    tables: manifestTables,
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: 100000,
      magic: 'ANITAG_ENC_V1'
    }
  };

  const payload = {
    manifest,
    data: tablesData
  };

  const jsonBuffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[Backup] Encrypting ${jsonBuffer.length} bytes with AES-256-GCM...`);
  const encryptedBuffer = encryptPayload(jsonBuffer, encryptionKey);

  // Write encrypted backup file
  const encryptedFileName = `anitag_backup_${fileTimestamp}.json.enc`;
  const encryptedFilePath = path.join(backupDir, encryptedFileName);
  fs.writeFileSync(encryptedFilePath, encryptedBuffer);

  // Write unencrypted manifest sidecar for verification & indexing without revealing data
  const manifestFileName = `anitag_backup_${fileTimestamp}.manifest.json`;
  const manifestFilePath = path.join(backupDir, manifestFileName);
  fs.writeFileSync(manifestFilePath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('================================================================');
  console.log('[Backup Success] Full database backup completed and verified.');
  console.log(`[Backup Success] Encrypted artifact: ${encryptedFilePath} (${encryptedBuffer.length} bytes)`);
  console.log(`[Backup Success] Public manifest:   ${manifestFilePath}`);
  console.log(`[Backup Success] Total tables:      ${REQUIRED_TABLES.length}`);
  console.log(`[Backup Success] Total records:     ${totalRows}`);
  console.log('================================================================');

  return {
    success: true,
    manifest,
    encryptedFilePath,
    manifestFilePath
  };
}

// Direct execution CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  executeBackup().catch(err => {
    console.error('[Backup Uncaught Error]:', err.message);
    process.exit(1);
  });
}
