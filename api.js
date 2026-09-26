import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import bs58 from 'bs58';
import { fileURLToPath } from 'node:url';
import { CFG, parseBands } from './settings.js';
import { q, tx, now, rules, setRules, secret, event, balanceOf, earnedOf, liabilities, reservedForRaids, kvGet, kvSet } from './db.js';
import * as X from './x.js';
import * as SOL from './solana.js';
import * as PUMP from './pump.js';
import { isWearing, analyze, fetchAvatar } from './pfp.js';
import { officialSvg } from './frame.js';
import * as E from './engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
const origins = [...CFG.corsOrigins, CFG.siteUrl].filter(Boolean);
app.use('/api', cors({ origin: origins.length ? origins : true, allowedHeaders: ['content-type', 'authorization', 'x-admin-key'], maxAge: 600 }));

// ---------- helpers
const H = 3600000;
const b64u = (b) => Buffer.from(b).toString('base64url');
function sign(payload) { const body = b64u(JSON.stringify(payload)); return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }
function unsign(tok) {
  const [body, mac] = String(tok || '').split('.'); if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > now() ? p : null;
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const session = (uid) => sign({ uid, exp: now() + 30 * 24 * H });
function needUser(req, res, next) {
  const p = unsign(bearer(req)); const u = p?.uid && q('SELECT * FROM users WHERE id=?').get(p.uid);
  if (!u) return res.status(401).json({ error: 'log in first' });
  if (u.status === 'banned') return res.status(403).json({ error: 'this account is banned' });
  req.user = u; next();
}
function needAdmin(req, res, next) {
  const k = req.headers['x-admin-key']; const p = unsign(bearer(req));
  const keyOk = CFG.adminKey && k && k.length === CFG.adminKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(CFG.adminKey));
  if (keyOk || p?.admin) return next();
  res.status(401).json({ error: 'admin only' });
}
const hits = new Map();
function limit(n, perMs, name = '') {
  return (req, res, next) => {
    const k = (name || req.route?.path || req.baseUrl) + '|' + req.ip; const t = now(); const a = (hits.get(k) || []).filter((x) => t - x < perMs);
    if (a.length >= n) return res.status(429).json({ error: 'slow down a little' });
    a.push(t); hits.set(k, a); next();
  };
}
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some((x) => t - x < 3600000)) hits.delete(k); }, 600000).unref();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { if (!e.status || e.status >= 500) console.error(req.path, e.message); res.status(e.status || 400).json({ error: e.message || 'something went wrong' }); });
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const dec = () => E.decimals();
const tok = async (units) => SOL.fromUnits(units, await dec());

function publicUser(u) { return { handle: u.handle, name: u.name, avatar: u.avatar, followers: u.followers, wearing: !!u.wearing, streakHours: Math.floor(E.streakHours(u)), tag: !!u.name_tag }; }

// ---------- public
app.get('/api/health', (req, res) => res.json({ ok: true, lastTick: E.state.lastTick }));

app.get('/api/config', wrap(async (req, res) => {
  const r = rules(); const b = await E.treasuryBalances();
  res.json({
    ticker: CFG.ticker, mint: CFG.mint, treasury: SOL.treasuryAddress, live: !!r.live, paused: !!r.paused,
    epochMinutes: r.epochMinutes, checkEveryMinutes: r.checkEveryMinutes,
    bands: parseBands(r.bands), nameTag: r.nameTag, nameTagBonus: r.nameTagBonus, streakBonusPerHour: r.streakBonusPerHour, streakBonusMax: r.streakBonusMax,
    minFollowers: r.minFollowers, minAccountDays: r.minAccountDays, minHold: r.minHold, maxSharePercent: r.maxSharePercent, payoutMin: r.payoutMin, payoutEveryMinutes: r.payoutEveryMinutes,
    poolMode: r.poolMode, poolFixed: r.poolFixed, poolPercent: r.poolPercent, feesBuyPercent: r.feesBuyPercent,
    xLogin: X.xLoginEnabled(), retweetRaids: X.canReadRetweets(), decimals: b.decimals,
  });
}));

app.get('/api/stats', wrap(async (req, res) => {
  const b = await E.treasuryBalances(); const d = b.decimals;
  const paid = Number(q("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status='confirmed'").get().s);
  const paid24 = Number(q("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status='confirmed' AND updated_at>?").get(now() - 24 * H).s);
  const cur = E.epochOf(now()); const last = q('SELECT * FROM epochs ORDER BY id DESC LIMIT 1').get();
  res.json({
    wearing: q("SELECT COUNT(*) n FROM users WHERE status='active' AND wallet IS NOT NULL AND wearing=1").get().n,
    members: q("SELECT COUNT(*) n FROM users WHERE status='active' AND wallet IS NOT NULL").get().n,
    paid: SOL.fromUnits(paid, d), paid24h: SOL.fromUnits(paid24, d),
    treasury: { address: SOL.treasuryAddress, sol: b.sol, token: SOL.fromUnits(b.token, d), free: SOL.fromUnits(Math.max(0, b.token - liabilities() - reservedForRaids()), d) },
    epoch: { id: cur, endsAt: (cur + 1) * E.epochMs() }, lastEpoch: last ? { id: last.id, pool: SOL.fromUnits(last.pool, d), wearers: last.wearers, dry: last.note === 'dry run' } : null,
    live: !!rules().live,
  });
}));

app.get('/api/feed', wrap(async (req, res) => {
  const d = await dec(); const since = Number(req.query.since) || 0;
  const rows = q('SELECT id, at, kind, msg, data FROM events WHERE public=1 AND id>? ORDER BY id DESC LIMIT 40').all(since);
  res.json(rows.map((r) => { const data = r.data ? JSON.parse(r.data) : null; if (data?.items) data.items = data.items.map((i) => ({ ...i, amount: SOL.fromUnits(i.amount, d) })); if (data?.pool !== undefined) data.pool = SOL.fromUnits(data.pool, d); return { ...r, data }; }));
}));

app.get('/api/wearing', wrap(async (req, res) => {
  res.json(q("SELECT * FROM users WHERE status='active' AND wallet IS NOT NULL AND wearing=1 ORDER BY followers DESC LIMIT 60").all().map(publicUser));
}));

app.get('/api/leaderboard', wrap(async (req, res) => {
  const d = await dec();
  const top = q(`SELECT u.*, COALESCE(SUM(CASE WHEN l.kind IN ('epoch','raid','adjust') THEN l.amount END),0) earned FROM users u LEFT JOIN ledger l ON l.user_id=u.id
    WHERE u.status='active' AND u.wallet IS NOT NULL GROUP BY u.id ORDER BY earned DESC, u.followers DESC LIMIT 50`).all();
  const streaks = q("SELECT * FROM users WHERE status='active' AND wallet IS NOT NULL AND wearing=1 AND streak_since>0 ORDER BY streak_since ASC LIMIT 20").all();
  res.json({ earners: top.map((u) => ({ ...publicUser(u), earned: SOL.fromUnits(u.earned, d) })), streaks: streaks.map(publicUser) });
}));

app.get('/api/raids', wrap(async (req, res) => {
  const d = await dec();
  res.json(q("SELECT * FROM raids WHERE status!='cancelled' ORDER BY (status='live') DESC, id DESC LIMIT 20").all().map((r) => ({ id: r.id, kind: r.kind, tweetUrl: r.tweet_url, tweetId: r.tweet_id, title: r.title, pool: SOL.fromUnits(r.pool, d), startsAt: r.starts_at, endsAt: r.ends_at, status: r.status, entries: r.entries })));
}));

// preview anyone's X profile: picture, followers, band, and whether they're wearing the coin right now
app.get('/api/lookup/:handle', limit(20, 60000, 'lookup'), wrap(async (req, res) => {
  const p = await X.getUser(req.params.handle); if (!p) throw fail("couldn't find that X account", 404);
  const r = rules(); let wearing = null;
  try { wearing = (await isWearing(p.avatar)).ok; } catch { /* picture unreachable */ }
  const known = q('SELECT wallet FROM users WHERE x_id=?').get(p.id);
  res.json({ handle: p.handle, name: p.name, avatar: p.avatar, followers: p.followers, band: E.bandMult(p.followers, r), problems: E.eligibility({ ...p, joined_at: p.joinedAt }, r), wearing, member: !!known?.wallet });
}));

// the X picture itself, same-origin, so the site can put it on the coin in a canvas
app.get('/api/avatar/:handle', limit(30, 60000, 'avatar'), wrap(async (req, res) => {
  const p = await X.getUser(req.params.handle); if (!p?.avatar) throw fail('no picture', 404);
  const buf = await fetchAvatar(p.avatar); const png = await sharp(buf).resize(400, 400).png().toBuffer();
  res.set('cache-control', 'public, max-age=300').type('png').send(png);
}));

let OFFICIAL = null;
app.get(['/pfp.png', '/api/pfp.png'], wrap(async (req, res) => { OFFICIAL ||= await sharp(Buffer.from(officialSvg(1000))).png().toBuffer(); res.set('cache-control', 'public, max-age=86400').type('png').send(OFFICIAL); }));

// ---------- join: Sign in with X
const pending = new Map();
app.get('/auth/x/start', (req, res) => {
  if (!X.xLoginEnabled()) return res.status(400).send('Sign in with X is not set up. Use "verify with a post" instead.');
  const state = crypto.randomBytes(16).toString('hex'); const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const back = String(req.query.return || CFG.siteUrl || '/'); pending.set(state, { verifier, back, at: now() });
  for (const [k, v] of pending) if (now() - v.at > 900000) pending.delete(k);
  res.redirect(X.xAuthUrl(state, challenge));
});
app.get('/auth/x/callback', wrap(async (req, res) => {
  const st = pending.get(req.query.state); pending.delete(req.query.state);
  if (!st) throw fail('login expired, try again');
  const back = safeReturn(st.back);
  if (req.query.error) return res.redirect(back + '#login_error=' + encodeURIComponent(req.query.error));
  const p = await X.xExchange(req.query.code, st.verifier);
  const u = upsertUser(p, null, 'x-login');
  res.redirect(back + '#session=' + session(u.id));
}));
function safeReturn(u) {
  try { const url = new URL(u, CFG.publicUrl || 'http://localhost'); const ok = [CFG.siteUrl, CFG.publicUrl, ...CFG.corsOrigins].filter(Boolean).some((o) => url.origin === new URL(o).origin); return ok ? url.origin + url.pathname : (CFG.siteUrl || CFG.publicUrl || '/'); } catch { return CFG.siteUrl || '/'; }
}
function upsertUser(p, wallet, via) {
  return tx(() => {
    let u = q('SELECT * FROM users WHERE x_id=?').get(p.id);
    if (wallet) { const other = q('SELECT id FROM users WHERE wallet=? AND x_id!=?').get(wallet, p.id); if (other) throw fail('that wallet is already linked to another X account'); }
    if (!u) {
      q('INSERT INTO users(x_id,handle,name,avatar,followers,joined_at,wallet,via,created_at,next_check_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(p.id, p.handle, p.name, p.avatar, p.followers, p.joinedAt || 0, wallet, via, now(), 0);
      event('join', `@${p.handle} joined`, { pub: true, data: { handle: p.handle, avatar: p.avatar } });
    } else q('UPDATE users SET handle=?, name=?, avatar=?, followers=?, wallet=COALESCE(?, wallet), via=?, next_check_at=0 WHERE id=?').run(p.handle, p.name, p.avatar, p.followers, wallet, via, u.id);
    return q('SELECT * FROM users WHERE x_id=?').get(p.id);
  });
}

// ---------- join: verify with a post (or a code in your bio) — no X developer account needed
app.post('/api/claim', limit(10, 60000, 'claim'), wrap(async (req, res) => {
  const wallet = SOL.isWallet(req.body.wallet); if (!wallet) throw fail("that doesn't look like a Solana wallet address");
  const p = await X.getUser(req.body.handle); if (!p) throw fail("couldn't find that X account");
  const problems = E.eligibility({ ...p, joined_at: p.joinedAt }); if (problems.length) throw fail('not eligible yet: ' + problems.join(', '));
  const taken = q('SELECT x_id FROM users WHERE wallet=?').get(wallet); if (taken && taken.x_id !== p.id) throw fail('that wallet is already linked to another X account');
  const code = 'PFP-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  q('INSERT INTO claims(code,handle,x_id,wallet,created_at) VALUES(?,?,?,?,?)').run(code, p.handle, p.id, wallet, now());
  const site = CFG.siteUrl || CFG.publicUrl || '';
  const text = `Renting my PFP to $${CFG.ticker} \u{1FA99}\nI wear the coin, I get paid every hour.\n\n${site ? site.replace(/^https?:\/\//, '') + '\n' : ''}verify: ${code}`;
  res.json({ code, text, intent: 'https://x.com/intent/post?text=' + encodeURIComponent(text), handle: p.handle });
}));
app.post('/api/claim/verify', limit(12, 60000, 'verify'), wrap(async (req, res) => {
  const c = q('SELECT * FROM claims WHERE code=?').get(String(req.body.code || '').toUpperCase().trim()); if (!c) throw fail('that code expired, start again');
  let via = null;
  const id = X.tweetIdFrom(req.body.tweetUrl);
  if (id) {
    const t = await X.getTweet(id); if (!t) throw fail("couldn't read that post yet, try again in a few seconds");
    if (t.authorId !== c.x_id) throw fail(`that post isn't from @${c.handle}`);
    if (t.isRetweet) throw fail('post the code yourself, a retweet does not count');
    if (!t.text.toUpperCase().includes(c.code)) throw fail('the code is not in that post');
    via = 'tweet';
  } else {
    const p = await X.getUser(c.handle); if (!p || p.id !== c.x_id) throw fail("couldn't read your profile");
    if (!(p.description + ' ' + p.name).toUpperCase().includes(c.code)) throw fail('paste your post link, or put the code in your bio and try again');
    via = 'bio';
  }
  let p = await X.getUser(c.handle).catch(() => null);
  if (!p || p.id !== c.x_id) p = { id: c.x_id, handle: c.handle, name: '', avatar: '', followers: 0 };
  const before = q('SELECT wallet FROM users WHERE x_id=?').get(c.x_id);
  const u = upsertUser(p, c.wallet, via);
  if (before?.wallet && before.wallet !== c.wallet) event('wallet', `@${c.handle} changed payout wallet by ${via}`);
  q('DELETE FROM claims WHERE x_id=?').run(c.x_id);
  res.json({ session: session(u.id) });
}));

// ---------- me
app.get('/api/me', needUser, wrap(async (req, res) => {
  const u = req.user; const r = rules(); const d = await dec();
  const parts = E.weightParts(u, r);
  const cur = E.epochOf(now());
  const epochChecks = q('SELECT COUNT(*) n, COALESCE(SUM(ok),0) ok FROM checks WHERE user_id=? AND epoch=?').get(u.id, cur);
  const checks = q('SELECT at, ok, tag FROM checks WHERE user_id=? ORDER BY at DESC LIMIT 12').all(u.id);
  const payouts = q("SELECT amount, status, signature, updated_at FROM payouts WHERE user_id=? AND status IN ('confirmed','sent') ORDER BY id DESC LIMIT 20").all(u.id);
  const dry = Number(q("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id=? AND kind='dry'").get(u.id).s);
  const raids = q('SELECT raid_id, reward FROM raid_entries WHERE user_id=?').all(u.id);
  res.json({
    handle: u.handle, name: u.name, avatar: u.avatar, followers: u.followers, wallet: u.wallet, via: u.via,
    wearing: !!u.wearing, tag: !!u.name_tag, lastCheckAt: u.last_check_at, lastError: u.last_error,
    streakHours: Math.floor(E.streakHours(u)), weight: parts, problems: E.eligibility(u, r),
    thisHour: { checks: epochChecks.n, ok: epochChecks.ok, endsAt: (cur + 1) * E.epochMs() },
    owed: SOL.fromUnits(balanceOf(u.id), d), earned: SOL.fromUnits(earnedOf(u.id), d), dryRun: SOL.fromUnits(dry, d),
    paid: SOL.fromUnits(Number(q("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE user_id=? AND status='confirmed'").get(u.id).s), d),
    checks, payouts: payouts.map((p) => ({ ...p, amount: SOL.fromUnits(p.amount, d) })), raids: raids.map((x) => ({ ...x, reward: SOL.fromUnits(x.reward, d) })),
  });
}));
app.post('/api/me/wallet', needUser, limit(6, 60000, 'wallet'), wrap(async (req, res) => {
  const w = SOL.isWallet(req.body.wallet); if (!w) throw fail("that doesn't look like a Solana wallet address");
  const other = q('SELECT id FROM users WHERE wallet=? AND id!=?').get(w, req.user.id); if (other) throw fail('that wallet is already linked to another X account');
  q('UPDATE users SET wallet=?, next_check_at=0 WHERE id=?').run(w, req.user.id); res.json({ ok: true, wallet: w });
}));
app.post('/api/me/check', needUser, limit(3, 60000, 'check'), wrap(async (req, res) => {
  if (!req.user.wallet) throw fail('add a wallet first');
  const r = (await E.checkUsers([req.user], { manual: true })).get(req.user.id) || {};
  if (r.error) throw fail(r.error);
  res.json(r);
}));
app.post('/api/raids/:id/enter', needUser, limit(10, 60000, 'enter'), wrap(async (req, res) => { res.json(await E.enterRaid(Number(req.params.id), req.user, req.body.tweetUrl)); }));

// ---------- admin
const nonces = new Map();
app.get('/api/admin/nonce', limit(20, 60000, 'nonce'), (req, res) => { for (const [k, t] of nonces) if (now() - t > 300000) nonces.delete(k); const n = crypto.randomBytes(12).toString('hex'); nonces.set(n, now()); res.json({ message: `pfpRent admin login\nnonce: ${n}\ntime: ${new Date().toISOString()}` }); });
app.post('/api/admin/login', limit(10, 60000, 'login'), wrap(async (req, res) => {
  if (req.body.key) {
    if (!CFG.adminKey || req.body.key !== CFG.adminKey) throw fail('wrong key', 401);
    return res.json({ session: sign({ admin: true, exp: now() + 7 * 24 * H }) });
  }
  const { wallet, message, signature } = req.body;
  if (!CFG.adminWallets.includes(wallet)) throw fail('that wallet is not an admin (set ADMIN_WALLETS)', 401);
  const n = (String(message).match(/nonce: (\w+)/) || [])[1]; const t = nonces.get(n); nonces.delete(n);
  if (!t || now() - t > 300000) throw fail('login message expired, try again', 401);
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(bs58.decode(wallet)) }, format: 'jwk' });
  if (!crypto.verify(null, Buffer.from(message), key, Buffer.from(bs58.decode(signature)))) throw fail('signature check failed', 401);
  res.json({ session: sign({ admin: true, wallet, exp: now() + 7 * 24 * H }) });
}));

app.get('/api/admin/overview', needAdmin, wrap(async (req, res) => {
  const b = await E.treasuryBalances(true); const d = b.decimals; const r = rules();
  const cur = E.epochOf(now());
  const preview = q(`SELECT u.handle, u.followers, u.wearing, COUNT(*) n, SUM(c.ok) ok FROM checks c JOIN users u ON u.id=c.user_id WHERE c.epoch=? GROUP BY u.id ORDER BY ok DESC LIMIT 200`).all(cur);
  res.json({
    rules: r, envLive: CFG.rules.live, treasury: { address: SOL.treasuryAddress, sol: b.sol, token: SOL.fromUnits(b.token, d), error: b.error || null },
    mint: CFG.mint || null, decimals: d, owed: SOL.fromUnits(liabilities(), d), reservedRaids: SOL.fromUnits(reservedForRaids(), d),
    free: SOL.fromUnits(Math.max(0, b.token - liabilities() - reservedForRaids()), d),
    users: q("SELECT COUNT(*) n, SUM(wearing) w FROM users WHERE status='active' AND wallet IS NOT NULL").get(),
    source: X.source(), xLogin: X.xLoginEnabled(), retweetRaids: X.canReadRetweets(),
    epoch: { id: cur, endsAt: (cur + 1) * E.epochMs(), checks: preview },
    epochs: q('SELECT * FROM epochs ORDER BY id DESC LIMIT 24').all().map((e) => ({ ...e, pool: SOL.fromUnits(e.pool, d) })),
    payouts: q('SELECT p.*, u.handle FROM payouts p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 60').all().map((p) => ({ ...p, amount: SOL.fromUnits(p.amount, d) })),
    events: q('SELECT * FROM events ORDER BY id DESC LIMIT 80').all(),
    raids: q('SELECT * FROM raids ORDER BY id DESC LIMIT 30').all().map((x) => ({ ...x, pool: SOL.fromUnits(x.pool, d) })),
    lastTick: E.state.lastTick,
  });
}));
app.post('/api/admin/rules', needAdmin, wrap(async (req, res) => {
  const patch = { ...req.body };
  if ('live' in patch && patch.live && !CFG.mint) throw fail('set PFP_MINT before going live');
  if ('live' in patch && patch.live && !CFG.treasurySecret && !kvGet('treasury_backed_up')) throw fail('back up the treasury key first (Treasury > Back up key), so the wallet can never be lost');
  const r = setRules(patch); event('admin', 'rules changed: ' + JSON.stringify(patch)); res.json(r);
}));
app.post('/api/admin/raids', needAdmin, wrap(async (req, res) => {
  const { kind = 'quote', tweetUrl, pool, hours = 24, title = '' } = req.body;
  if (!['quote', 'reply', 'retweet'].includes(kind)) throw fail('kind must be quote, reply or retweet');
  if (kind === 'retweet' && !X.canReadRetweets()) throw fail('retweet raids need TWITTERAPI_KEY (or X_BEARER). Use a quote raid instead.');
  const id = X.tweetIdFrom(tweetUrl); if (!id) throw fail('paste the link to the post to raid');
  const d = await dec(); const units = SOL.toUnits(pool, d); if (!(units > 0)) throw fail('set a reward pool');
  if (rules().live) { const b = await E.treasuryBalances(true); const free = b.token - liabilities() - reservedForRaids(); if (units > free) throw fail(`treasury only has ${SOL.fromUnits(free, d)} $${CFG.ticker} free`); }
  const clean = `https://x.com/i/status/${id}`;
  const r = q('INSERT INTO raids(kind,tweet_id,tweet_url,title,pool,starts_at,ends_at) VALUES(?,?,?,?,?,?,?)').run(kind, id, clean, String(title).slice(0, 120), units, now(), now() + Number(hours) * H);
  event('raid', `raid #${r.lastInsertRowid} is live: ${kind} this post for a share of ${Number(pool).toLocaleString()} $${CFG.ticker}`, { pub: true, data: { raid: Number(r.lastInsertRowid), tweetUrl: clean } });
  res.json({ id: Number(r.lastInsertRowid) });
}));
app.post('/api/admin/raids/:id/cancel', needAdmin, wrap(async (req, res) => { q("UPDATE raids SET status='cancelled' WHERE id=? AND status='live'").run(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/admin/raids/:id/end', needAdmin, wrap(async (req, res) => { q("UPDATE raids SET ends_at=? WHERE id=? AND status='live'").run(now(), Number(req.params.id)); await E.settleRaids(); res.json({ ok: true }); }));
app.get('/api/admin/users', needAdmin, wrap(async (req, res) => {
  const s = `%${String(req.query.q || '').replace(/^@/, '')}%`; const d = await dec();
  res.json(q('SELECT * FROM users WHERE handle LIKE ? OR wallet LIKE ? ORDER BY wearing DESC, followers DESC LIMIT 100').all(s, s).map((u) => ({ ...u, owed: SOL.fromUnits(balanceOf(u.id), d), band: E.bandMult(u.followers) })));
}));
app.post('/api/admin/users/:id/:action(ban|unban)', needAdmin, wrap(async (req, res) => {
  q('UPDATE users SET status=? WHERE id=?').run(req.params.action === 'ban' ? 'banned' : 'active', Number(req.params.id)); event('admin', `${req.params.action} user ${req.params.id}`); res.json({ ok: true });
}));
app.post('/api/admin/adjust', needAdmin, wrap(async (req, res) => {
  const u = q('SELECT * FROM users WHERE handle=?').get(X.cleanHandle(req.body.handle)); if (!u) throw fail('no such member');
  const units = SOL.toUnits(req.body.tokens, await dec()); q("INSERT INTO ledger(user_id,kind,ref,amount,at) VALUES(?,?,?,?,?)").run(u.id, 'adjust', 'admin', units, now());
  event('admin', `adjusted @${u.handle} by ${req.body.tokens}`); res.json({ ok: true });
}));
app.post('/api/admin/fund-tx', needAdmin, wrap(async (req, res) => { res.json({ tx: await SOL.buildFundTx(req.body.from, req.body.asset === 'SOL' ? 'SOL' : 'PFP', req.body.amount) }); }));
app.post('/api/admin/withdraw', needAdmin, wrap(async (req, res) => {
  const to = SOL.isWallet(req.body.to); if (!to) throw fail('bad address');
  if (req.body.asset !== 'SOL') {
    const b = await SOL.balances(); const d = await dec(); const free = b.token - liabilities() - reservedForRaids();
    if (SOL.toUnits(req.body.amount, d) > free) throw fail(`only ${SOL.fromUnits(Math.max(0, free), d)} $${CFG.ticker} is free; the rest is owed to members or held for raids`);
  }
  const sig = await SOL.withdraw(to, req.body.asset === 'SOL' ? 'SOL' : 'PFP', req.body.amount); event('admin', `withdrew ${req.body.amount} ${req.body.asset} to ${to}: ${sig}`); res.json({ sig });
}));
app.post('/api/admin/claim-fees', needAdmin, wrap(async (req, res) => { const r = await PUMP.claimCreatorFees(); event('admin', `claimed ${r.sol} SOL: ${r.sig}`); res.json(r); }));
app.post('/api/admin/buy', needAdmin, wrap(async (req, res) => {
  const r = await PUMP.buyPfp(Number(req.body.sol)); const d = await dec();
  event('fees', `bought ${SOL.fromUnits(r.tokens, d).toLocaleString()} $${CFG.ticker} for the treasury`, { pub: true, data: { buySig: r.sig } }); res.json({ ...r, tokens: SOL.fromUnits(r.tokens, d) });
}));
app.post('/api/admin/pay-now', needAdmin, wrap(async (req, res) => { res.json(await E.runPayouts(true)); }));
app.post('/api/admin/check-now', needAdmin, wrap(async (req, res) => { q("UPDATE users SET next_check_at=0 WHERE status='active'").run(); res.json({ ok: true }); }));
app.post('/api/admin/test-pfp', needAdmin, wrap(async (req, res) => { const p = await X.getUser(req.body.handle); if (!p) throw fail('not found'); res.json({ avatar: p.avatar, ...(await analyze(await fetchAvatar(p.avatar))) }); }));
app.post('/api/admin/backup', needAdmin, wrap(async (req, res) => { if (req.body.confirm !== 'I will keep this secret') throw fail('confirm first'); event('admin', 'treasury key exported'); kvSet('treasury_backed_up', true); res.json(SOL.treasuryBackup()); }));

// ---------- static: the site at /, admin at /admin. Only these files are ever served.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLAT = fs.existsSync(path.join(HERE, 'admin.html')); // deploy folder: everything side by side
const PUBLIC = FLAT
  ? { '/': 'index.html', '/index.html': 'index.html', '/avatar.svg': 'avatar.svg', '/config.js': 'config.js', '/og.jpg': 'og.jpg', '/admin': 'admin.html', '/admin.js': 'admin.js', '/admin-fonts.css': 'admin-fonts.css' }
  : { '/': 'site/index.html', '/index.html': 'site/index.html', '/avatar.svg': 'site/avatar.svg', '/config.js': 'site/config.js', '/og.jpg': 'site/og.jpg', '/admin': 'admin/index.html', '/admin.js': 'admin/admin.js', '/admin-fonts.css': 'admin/fonts.css' };
const BASE = FLAT ? HERE : ROOT;
for (const [route, file] of Object.entries(PUBLIC)) {
  const f = path.join(BASE, file);
  app.get(route, (req, res) => (fs.existsSync(f) ? res.sendFile(f, { maxAge: route === '/' || route === '/config.js' ? 0 : 3600000 }) : res.status(404).end()));
}
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
