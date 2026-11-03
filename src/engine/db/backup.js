/**
 * AniTAG Database Backup & Export Utility
 * Provides on-demand snapshot exports of user tables (Continue Watching, Watchlist, Ratings, Preferences)
 * Can be run manually (npm run db:backup) or via scheduled GitHub Actions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TABLES = [
  'profiles',
  'user_preferences',
  'continue_watching',
  'watch_history',
  'user_watchlist',
  'user_anime_ratings',
  'user_episode_ratings'
];

async function runBackup() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.resolve(__dirname, '../../../backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('[DB Backup] Notice: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.');
    console.warn('[DB Backup] A local offline schema template backup will be generated.');

    const schemaPath = path.resolve(__dirname, '001_initial_schema.sql');
    const destPath = path.join(backupDir, `schema_snapshot_${timestamp}.sql`);
    if (fs.existsSync(schemaPath)) {
      fs.copyFileSync(schemaPath, destPath);
      console.log(`[DB Backup] Schema snapshot created at: ${destPath}`);
    }
    return;
  }

  console.log(`[DB Backup] Starting export for ${TABLES.length} tables from ${supabaseUrl}...`);
  const exportData = {
    exportedAt: new Date().toISOString(),
    tables: {}
  };

  for (const table of TABLES) {
    try {
      const endpoint = `${supabaseUrl}/rest/v1/${table}?select=*`;
      const res = await fetch(endpoint, {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
        console.error(`[DB Backup] Failed to fetch table ${table}: ${res.status} ${res.statusText}`);
        exportData.tables[table] = { error: res.statusText };
      } else {
        const rows = await res.json();
        exportData.tables[table] = rows;
        console.log(`[DB Backup] Exported ${rows.length} rows from ${table}`);
      }
    } catch (err) {
      console.error(`[DB Backup] Error exporting ${table}:`, err.message);
      exportData.tables[table] = { error: err.message };
    }
  }

  const exportFilePath = path.join(backupDir, `anitag_backup_${timestamp}.json`);
  fs.writeFileSync(exportFilePath, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`[DB Backup] Successfully saved backup to: ${exportFilePath}`);
}

runBackup().catch(err => {
  console.error('[DB Backup] Fatal backup error:', err);
  process.exit(1);
});
