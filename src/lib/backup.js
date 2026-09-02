import { zip } from './xlsx.js';
import { asBytes } from './files.js';

/**
 * A copy of everything, as files a person can open.
 *
 * Every table as a CSV, every stored document as the document it is, and a
 * manifest saying when and how much. Contracts, signatures, four years of
 * payroll and every payslip live in one database with nothing else holding a
 * copy; this is the copy. It is meant to be downloaded and put somewhere the
 * property controls, and it is what the nightly run writes to a bucket when
 * one is bound.
 *
 * CSV RATHER THAN A DATABASE FILE. A .sqlite is the faithful copy and the one
 * nobody can open. A folder of CSVs can be read in a spreadsheet on the day
 * the app is not there, which is the whole point of a backup: it is for the
 * bad day, not the good one. The table names and column names are the
 * database's own, so restoring is mechanical.
 *
 * FILES COME OUT AS FILES. A CV, a signed contract or the company logo is
 * kept as bytes in a `content` column, in one row or spread across `_part`
 * rows when it is large. Those are written under files/ with their own
 * names, and the CSV column says where each one went instead of carrying
 * the bytes.
 */

// The tables whose `content` is a document, and where the overflow lives.
const FILE_TABLES = {
  hr_document: { parts: 'hr_document_part', key: 'document_id', name: (r) => r.filename || `${r.id}` },
  corr_file: { parts: 'corr_file_part', key: 'file_id', name: (r) => r.filename || `${r.id}` },
  rec_file: { parts: null, name: (r) => r.filename || `${r.id}` },
  company_logo: { parts: null, name: (r) => `logo-${r.id}.${(r.mime || '').split('/')[1] || 'bin'}` },
};
const PART_TABLES = new Set(Object.values(FILE_TABLES).map((t) => t.parts).filter(Boolean));

// Not the property's data: SQLite's own bookkeeping, D1's, and the counter
// of wrong PINs from the last ten minutes.
const SKIP = (name) => name.startsWith('sqlite_') || name.startsWith('_cf_')
  || name === 'd1_migrations' || name === 'login_attempts';

const utf8 = (s) => new TextEncoder().encode(s);

function csvCell(v) {
  if (v == null) return '';
  if (v instanceof Uint8Array || v instanceof ArrayBuffer || (Array.isArray(v) && v.every((n) => typeof n === 'number'))) {
    return `base64:${toBase64(asBytes(v))}`;
  }
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toBase64(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(str);
}

function csv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  // A byte-order mark, so a spreadsheet opens it as UTF-8 without asking.
  return utf8(`\uFEFF${lines.join('\n')}\n`);
}

/** A file name that is safe inside a zip and still says what it was. */
function safeName(text) {
  return String(text).replace(/[\\/:*?"<>| -]/g, '_').slice(0, 120) || 'file';
}

async function tableNames(db) {
  const rows = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  return (rows.results ?? []).map((r) => r.name).filter((n) => !SKIP(n));
}

async function columnsOf(db, table) {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
  return (rows.results ?? []).map((c) => c.name);
}

/**
 * Every part of the backup, in memory: `{ name, bytes }` for the zip.
 *
 * `now` is an ISO stamp for the manifest; the caller supplies it so a test
 * can pin it and so the nightly copy names itself by the property's day.
 */
export async function backupParts(db, { now = new Date().toISOString(), property = '' } = {}) {
  const parts = [];
  const manifest = { app: 'HIVE', property, at: now, tables: {}, files: 0 };

  for (const table of await tableNames(db)) {
    if (PART_TABLES.has(table)) continue; // folded into the file they belong to
    const columns = await columnsOf(db, table);
    const rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results ?? [];
    manifest.tables[table] = rows.length;

    const spec = FILE_TABLES[table];
    if (!spec) {
      parts.push({ name: `tables/${table}.csv`, bytes: csv(columns, rows) });
      continue;
    }

    // A document table: the bytes go out as files, and the CSV points at them.
    const pointed = [];
    for (const row of rows) {
      let bytes = asBytes(row.content);
      if (spec.parts) {
        const more = await db.prepare(
          `SELECT content FROM ${spec.parts} WHERE ${spec.key} = ? ORDER BY seq`,
        ).bind(row.id).all().catch(() => ({ results: [] }));
        const chunks = [bytes, ...(more.results ?? []).map((p) => asBytes(p.content))];
        const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) { joined.set(c, at); at += c.length; }
        bytes = joined;
      }
      const path = `files/${table}/${row.id}-${safeName(spec.name(row))}`;
      parts.push({ name: path, bytes });
      manifest.files += 1;
      pointed.push({ ...row, content: path });
    }
    parts.push({ name: `tables/${table}.csv`, bytes: csv(columns, pointed) });
  }

  parts.unshift({ name: 'manifest.json', bytes: utf8(JSON.stringify(manifest, null, 2)) });
  parts.push({
    name: 'README.txt',
    bytes: utf8([
      'HIVE backup',
      '',
      `Taken ${now}${property ? ` for ${property}` : ''}.`,
      '',
      'tables/   one CSV per table, named as in the database, first row the column names.',
      '          A cell reading base64:... is binary data that had no better home.',
      'files/    every stored document, contract, CV and logo, as the file it was.',
      '          The content column of the matching CSV says which file each row is.',
      'manifest.json   row counts per table, and how many files.',
      '',
      'To restore, the tables are inserted in migration order with the files read back',
      'into their content columns. Keep this somewhere the property controls.',
    ].join('\n')),
  });
  return { parts, manifest };
}

/** The whole thing as one zip, stored rather than compressed. */
export async function backupZip(db, opts = {}) {
  const { parts, manifest } = await backupParts(db, opts);
  return { bytes: zip(parts), manifest };
}

/**
 * The nightly copy, when a bucket is bound as BACKUPS.
 *
 * One object per day, and the days beyond `keep` are dropped so the bucket
 * holds a month rather than forever. Nothing here is fatal: a bucket that
 * refuses is logged and the morning carries on.
 */
export async function nightlyCopy(db, bucket, { today, property = '', keep = 30 } = {}) {
  if (!bucket?.put) return { written: false, reason: 'no bucket bound' };
  const { bytes, manifest } = await backupZip(db, { now: new Date().toISOString(), property });
  const key = `hive/${today}.zip`;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'application/zip' },
    customMetadata: { tables: String(Object.keys(manifest.tables).length), files: String(manifest.files) },
  });

  let dropped = 0;
  try {
    const listed = await bucket.list({ prefix: 'hive/' });
    const names = (listed?.objects ?? []).map((o) => o.key).sort();
    const stale = names.slice(0, Math.max(0, names.length - keep));
    for (const name of stale) { await bucket.delete(name); dropped += 1; }
  } catch (err) {
    console.error('backup pruning failed', err);
  }
  return { written: true, key, bytes: bytes.length, dropped };
}
