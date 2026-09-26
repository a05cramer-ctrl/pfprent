import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CFG } from './settings.js';

fs.mkdirSync(CFG.dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH || path.join(CFG.dataDir, 'pfprent.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  x_id TEXT UNIQUE NOT NULL,
  handle TEXT NOT NULL COLLATE NOCASE,
  name TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  followers INTEGER DEFAULT 0,
  joined_at INTEGER DEFAULT 0,
  wallet TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',          -- active | banned
  via TEXT DEFAULT '',                             -- x-login | tweet | bio
  created_at INTEGER NOT NULL,
  next_check_at INTEGER DEFAULT 0,
  last_check_at INTEGER DEFAULT 0,
  wearing INTEGER DEFAULT 0,
  name_tag INTEGER DEFAULT 0,
  streak_since INTEGER DEFAULT 0,                  -- first ok check of the current unbroken streak
  last_error TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS users_next ON users(status, next_check_at);
CREATE INDEX IF NOT EXISTS users_handle ON users(handle);

CREATE TABLE IF NOT EXISTS claims (             -- pending "post this code" verifications
  code TEXT PRIMARY KEY,
  handle TEXT NOT NULL COLLATE NOCASE,
  x_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  tag INTEGER NOT NULL DEFAULT 0,
  score REAL DEFAULT 0,
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS checks_epoch ON checks(epoch, user_id);
CREATE INDEX IF NOT EXISTS checks_user ON checks(user_id, at);

CREATE TABLE IF NOT EXISTS avatars (             -- detection cache per image URL
  url TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  score REAL NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS epochs (
  id INTEGER PRIMARY KEY,                        -- floor(start / epoch length)
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  pool INTEGER NOT NULL DEFAULT 0,               -- base units
  wearers INTEGER NOT NULL DEFAULT 0,
  total_weight REAL NOT NULL DEFAULT 0,
  source TEXT DEFAULT '',
  note TEXT DEFAULT '',
  closed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (              -- +credit / -debit, base units
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                            -- epoch | raid | payout | refund | adjust
  ref TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,                          -- queued | sent | confirmed | failed | dry
  signature TEXT DEFAULT '',
  last_valid_height INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS payouts_user ON payouts(user_id);

CREATE TABLE IF NOT EXISTS raids (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                            -- quote | reply | retweet
  tweet_id TEXT NOT NULL,
  tweet_url TEXT NOT NULL,
  title TEXT DEFAULT '',
  pool INTEGER NOT NULL,                         -- base units
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',           -- live | settled | cancelled
  entries INTEGER DEFAULT 0,
  settled_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS raid_entries (
  raid_id INTEGER NOT NULL REFERENCES raids(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_tweet_id TEXT DEFAULT '',
  weight REAL NOT NULL DEFAULT 1,
  reward INTEGER DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (raid_id, user_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- public events are shown in the site feed
  public INTEGER NOT NULL DEFAULT 0,
  msg TEXT NOT NULL,
  data TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_pub ON events(public, id);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const q = (sql) => db.prepare(sql);
export const now = () => Date.now();

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- key/value settings
export function kvGet(key, d = null) { const r = q('SELECT value FROM kv WHERE key=?').get(key); if (!r) return d; try { return JSON.parse(r.value); } catch { return d; } }
export function kvSet(key, v) { q('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(v)); }

// rules = env defaults + admin overrides
export function rules() { return { ...CFG.rules, ...(kvGet('rules', {}) || {}) }; }
export function setRules(patch) {
  const allowed = ['live', 'paused', 'poolMode', 'poolFixed', 'poolPercent', 'feesBuyPercent', 'minFollowers', 'minAccountDays', 'minHold', 'nameTagBonus', 'maxSharePercent', 'payoutMin', 'bands', 'streakBonusPerHour', 'streakBonusMax', 'checkEveryMinutes'];
  const cur = kvGet('rules', {}) || {};
  for (const k of allowed) if (k in patch) cur[k] = patch[k];
  kvSet('rules', cur); return rules();
}

export function secret() {
  if (CFG.sessionSecret) return CFG.sessionSecret;
  let s = kvGet('session_secret'); if (!s) { s = crypto.randomBytes(32).toString('hex'); kvSet('session_secret', s); }
  return s;
}

export function event(kind, msg, { pub = false, data = null } = {}) {
  q('INSERT INTO events(at,kind,public,msg,data) VALUES(?,?,?,?,?)').run(now(), kind, pub ? 1 : 0, msg, data ? JSON.stringify(data) : '');
  if (!pub) console.log(`[${kind}] ${msg}`);
}

// 'dry' rows are dry-run bookkeeping only and never count as money owed
export function balanceOf(userId) { return Number(q("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id=? AND kind!='dry'").get(userId).s); }
export function earnedOf(userId) { return Number(q("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id=? AND kind IN ('epoch','raid','adjust')").get(userId).s); }
// owed to users + payouts debited but not yet confirmed on-chain
export function liabilities() {
  const owed = Number(q("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kind!='dry'").get().s);
  const inflight = Number(q("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status IN ('queued','sent')").get().s);
  return owed + inflight;
}
export function reservedForRaids() { return Number(q("SELECT COALESCE(SUM(pool),0) s FROM raids WHERE status='live'").get().s); }
