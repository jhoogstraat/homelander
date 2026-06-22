// SQLite database layer for Homelander.
// Uses better-sqlite3 — synchronous API, perfect for embedded use.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS filters (
  id TEXT PRIMARY KEY,
  name TEXT,
  web_url TEXT NOT NULL,
  mobile_params TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_polled_at TEXT,
  total_seen INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listings (
  hash TEXT PRIMARY KEY,
  expose_id TEXT NOT NULL,
  title TEXT,
  price REAL,
  size REAL,
  rooms REAL,
  address TEXT,
  image_url TEXT,
  filter_id TEXT REFERENCES filters(id),
  status TEXT DEFAULT 'seen',
  discovered_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  sent_at TEXT,
  outcome TEXT,
  failure_reason TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_hash TEXT,
  filter_id TEXT,
  outcome TEXT,
  detail TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_filter ON listings(filter_id);
CREATE INDEX IF NOT EXISTS idx_listings_discovered ON listings(filter_id, discovered_at);
CREATE INDEX IF NOT EXISTS idx_results_timestamp ON results(timestamp);
`;

export class HomelanderDB {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
  }

  _migrate() {
    let version = null;
    try {
      version = this.db.prepare(
        'SELECT version FROM schema_version'
      ).get();
    } catch {
      // Table doesn't exist yet — first run
    }

    if (!version || version.version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      this.db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  close() {
    this.db.close();
  }

  // ── Filters ──────────────────────────────────────────────────

  addFilter({ id, name, web_url, mobile_params }) {
    return this.db.prepare(`
      INSERT INTO filters (id, name, web_url, mobile_params)
      VALUES (?, ?, ?, ?)
    `).run(id, name || '', web_url, mobile_params);
  }

  getFilters() {
    return this.db.prepare(`
      SELECT f.*,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status = 'seen') as new_count,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status = 'sent') as sent_count,
        (SELECT COUNT(*) FROM listings WHERE filter_id = f.id AND status IN ('sent', 'failed')) as processed_count
      FROM filters f
      ORDER BY f.created_at DESC, f.rowid DESC
    `).all();
  }

  getFilter(id) {
    return this.db.prepare('SELECT * FROM filters WHERE id = ?').get(id);
  }

  updateFilter(id, patch) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      // better-sqlite3 rejects JS booleans — convert to 0/1
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE filters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  removeFilter(id) {
    // Null out references first so FK constraint doesn't block the delete
    this.db.prepare('UPDATE listings SET filter_id = NULL WHERE filter_id = ?').run(id);
    this.db.prepare('DELETE FROM filters WHERE id = ?').run(id);
  }

  // ── Listings ─────────────────────────────────────────────────

  static hashListing(exposeId, price) {
    return createHash('sha256').update(`${exposeId}|${price}`).digest('hex').slice(0, 16);
  }

  insertListing(listing) {
    const hash = HomelanderDB.hashListing(listing.expose_id, listing.price);
    try {
      return this.db.prepare(`
        INSERT INTO listings (hash, expose_id, title, price, size, rooms, address, image_url, filter_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seen')
      `).run(
        hash, listing.expose_id, listing.title, listing.price,
        listing.size, listing.rooms, listing.address, listing.image_url,
        listing.filter_id
      );
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return { changes: 0, skipped: true };
      }
      throw err;
    }
  }

  /** Bulk insert — returns count of actually inserted listings. */
  insertListings(listings, filterId) {
    let inserted = 0;
    for (const listing of listings) {
      const result = this.insertListing({ ...listing, filter_id: filterId });
      if (result.changes > 0) inserted++;
    }
    return inserted;
  }

  getSeenListings(filterId = null) {
    let sql = 'SELECT * FROM listings WHERE status = ?';
    const params = ['seen'];
    if (filterId) {
      sql += ' AND filter_id = ?';
      params.push(filterId);
    }
    sql += ' ORDER BY discovered_at ASC';
    return this.db.prepare(sql).all(...params);
  }

  markSent(hash, outcome, detail, failureReason = '') {
    const status = outcome === 'SENT' ? 'sent' : 'failed';
    this.db.prepare(`
      UPDATE listings SET status = ?, outcome = ?, sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), detail = ?, failure_reason = ?
      WHERE hash = ?
    `).run(status, outcome, detail || '', failureReason || '', hash);

    this.db.prepare(`
      INSERT INTO results (listing_hash, outcome, detail) VALUES (?, ?, ?)
    `).run(hash, outcome, detail || '');
  }

  /** Reset a listing back to 'seen' so the apply loop picks it up again.
   *  Clears outcome/detail/failure_reason/sent_at so the listing
   *  disappears from history until the daemon re-processes it. */
  retryListing(exposeId) {
    const row = this.db.prepare('SELECT hash, status FROM listings WHERE expose_id = ?').get(exposeId);
    if (!row) return { error: 'Listing not found' };
    if (row.status === 'seen') return { hash: row.hash, already_seen: true };
    this.db.prepare(`
      UPDATE listings SET status = 'seen', outcome = NULL, detail = NULL, 
        failure_reason = NULL, sent_at = NULL
      WHERE hash = ?
    `).run(row.hash);
    return { hash: row.hash };
  }

  getHistory(limit = 100, offset = 0, filterId = null, outcome = null) {
    let sql = 'SELECT * FROM listings WHERE outcome IS NOT NULL';
    const params = [];
    if (filterId) {
      sql += ' AND filter_id = ?';
      params.push(filterId);
    }
    if (outcome) {
      if (outcome === 'CAPTCHA') {
        sql += ' AND (failure_reason LIKE ? OR detail LIKE ?)';
        params.push('%captcha%', '%captcha%');
      } else if (outcome === 'PREMIUM') {
        sql += ' AND (failure_reason LIKE ? OR detail LIKE ? OR detail LIKE ?)';
        params.push('%premium%', '%premium%', '%Suchen+%');
      } else {
        sql += ' AND outcome = ?';
        params.push(outcome);
      }
    }
    sql += ' ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }

  getStats(filterId = null) {
    const whereFilter = filterId ? ' WHERE filter_id = ?' : '';
    const filterParam = filterId ? [filterId] : [];

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent', 'failed') THEN 1 ELSE 0 END), 0) as total,
        COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) as sent,
        COALESCE(SUM(CASE WHEN status = 'failed' AND outcome NOT IN ('DEACTIVATED', 'PREMIUM') AND failure_reason NOT LIKE '%premium%' AND detail NOT LIKE '%premium%' AND detail NOT LIKE '%Suchen+%' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN outcome = 'DEACTIVATED' THEN 1 ELSE 0 END), 0) as deactivated,
        COALESCE(SUM(CASE WHEN (failure_reason LIKE '%premium%' OR detail LIKE '%premium%' OR detail LIKE '%Suchen+%') THEN 1 ELSE 0 END), 0) as premium,
        COALESCE(SUM(CASE WHEN (failure_reason LIKE '%captcha%' OR detail LIKE '%captcha%') THEN 1 ELSE 0 END), 0) as captcha,
        COALESCE(SUM(CASE WHEN status = 'seen' THEN 1 ELSE 0 END), 0) as seen_unapplied,
        COALESCE(SUM(CASE WHEN status = 'sent' AND date(sent_at) = date('now', 'localtime') THEN 1 ELSE 0 END), 0) as today
      FROM listings${whereFilter}
    `).get(...filterParam);

    return {
      total: row.total, sent: row.sent, failed: row.failed,
      deactivated: row.deactivated, premium: row.premium, captcha: row.captcha,
      seen_unapplied: row.seen_unapplied, today: row.today,
    };
  }

  getTodayStats(filterId = null) {
    const whereFilter = filterId ? ' AND filter_id = ?' : '';
    const filterParam = filterId ? [filterId] : [];

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('sent', 'failed') THEN 1 ELSE 0 END), 0) as total,
        COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) as sent,
        COALESCE(SUM(CASE WHEN status = 'failed' AND outcome NOT IN ('DEACTIVATED', 'PREMIUM') AND failure_reason NOT LIKE '%premium%' AND detail NOT LIKE '%premium%' AND detail NOT LIKE '%Suchen+%' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN outcome = 'DEACTIVATED' THEN 1 ELSE 0 END), 0) as deactivated,
        COALESCE(SUM(CASE WHEN (failure_reason LIKE '%premium%' OR detail LIKE '%premium%' OR detail LIKE '%Suchen+%') THEN 1 ELSE 0 END), 0) as premium,
        COALESCE(SUM(CASE WHEN (failure_reason LIKE '%captcha%' OR detail LIKE '%captcha%') THEN 1 ELSE 0 END), 0) as captcha,
        COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) as today
      FROM listings WHERE date(sent_at) = date('now', 'localtime')${whereFilter}
    `).get(...filterParam);

    // seen_unapplied uses discovered_at, not sent_at — query separately
    const seenUnapplied = this.db.prepare(
      `SELECT COUNT(*) as count FROM listings WHERE status = 'seen' AND date(discovered_at) = date('now', 'localtime')${whereFilter}`
    ).get(...filterParam);

    return {
      total: row.total, sent: row.sent, failed: row.failed,
      deactivated: row.deactivated, premium: row.premium, captcha: row.captcha,
      seen_unapplied: seenUnapplied.count, today: row.today,
    };
  }

  getRecentActivity(limit = 50) {
    return this.db.prepare(`
      SELECT hash, expose_id, title, price, address, outcome, failure_reason, detail, sent_at, image_url
      FROM listings
      WHERE outcome IS NOT NULL
      ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC
      LIMIT ?
    `).all(limit);
  }

  getCaptchaConsecutive() {
    // Count how many consecutive FAIL/captcha results we have (most recent first)
    const rows = this.db.prepare(`
      SELECT outcome, failure_reason FROM listings
      WHERE outcome IS NOT NULL
      ORDER BY COALESCE(sent_at, discovered_at) DESC, rowid DESC
      LIMIT 20
    `).all();

    let consecutive = 0;
    for (const row of rows) {
      if (row.failure_reason === 'captcha' || (row.outcome === 'FAIL' && (row.failure_reason || '').includes('captcha'))) {
        consecutive++;
      } else {
        break;
      }
    }
    return consecutive;
  }
}
