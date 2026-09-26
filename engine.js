// The loop: spot-check PFPs, close each hour, pay people, settle raids.
import { CFG, parseBands } from './settings.js';
import { db, q, tx, now, rules, kvGet, kvSet, event, balanceOf, liabilities, reservedForRaids } from './db.js';
import * as X from './x.js';
import { isWearing } from './pfp.js';
import * as SOL from './solana.js';
import * as PUMP from './pump.js';

const H = 3600000;
export const epochMs = () => rules().epochMinutes * 60000;
export const epochOf = (t) => Math.floor(t / epochMs());
export const state = { bal: null, balAt: 0, lastTick: 0, running: false, errors: 0 };

// ---------- weights
export function bandMult(followers, r = rules()) { let m = 0; for (const [min, mult] of parseBands(r.bands)) if (followers >= min) m = mult; return m; }
export function streakHours(u, at = now()) { return u.wearing && u.streak_since ? Math.max(0, (at - u.streak_since) / H) : 0; }
export function weightParts(u, r = rules(), at = now()) {
  const band = bandMult(u.followers, r);
  const tag = u.name_tag ? r.nameTagBonus : 0;
  const streak = Math.min(r.streakBonusMax, Math.floor(streakHours(u, at)) * r.streakBonusPerHour);
  return { band, tag, streak, total: band * (1 + tag) * (1 + streak) };
}
export function eligibility(u, r = rules()) {
  const why = [];
  if (u.protected) why.push('your account is protected');
  if ((u.followers | 0) < r.minFollowers) why.push(`needs ${r.minFollowers}+ followers`);
  const days = u.joined_at || u.joinedAt ? (now() - (u.joined_at || u.joinedAt)) / (24 * H) : 9999;
  if (days < r.minAccountDays) why.push(`account must be ${r.minAccountDays}+ days old`);
  return why;
}
const mint = async () => SOL.mintInfo().catch(() => null);
export async function decimals() { return (await mint())?.decimals ?? 6; }

export async function treasuryBalances(force = false) {
  if (!force && state.bal && now() - state.balAt < 60000) return state.bal;
  try { state.bal = await SOL.balances(); state.balAt = now(); } catch (e) { if (!state.bal) state.bal = { sol: 0, token: 0, decimals: 6, error: e.message }; }
  return state.bal;
}
// fresh from chain; throws if the RPC is down (so an hour never closes on a fake zero balance)
export async function freeTokens() { const b = await SOL.balances(); state.bal = b; state.balAt = now(); return Math.max(0, b.token - liabilities() - reservedForRaids()); }

// split `pool` by weight; nobody gets more than `cap` of it (extra goes to the others)
export function split(weights, pool, capFrac) {
  const n = weights.length; const out = new Array(n).fill(0); if (!n || pool <= 0) return out;
  // the cap only bites once there are enough people for it to be fair (with 8 wearers nobody can be held to 5%)
  const cap = capFrac > 0 ? pool * Math.min(1, Math.max(capFrac, 3 / n)) : Infinity;
  let open = weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0); let left = pool;
  for (let round = 0; round < 50 && open.length && left > 1e-9; round++) {
    const W = open.reduce((s, i) => s + weights[i], 0); if (W <= 0) break;
    for (const i of open) { const give = Math.min((left * weights[i]) / W, cap - out[i]); out[i] += give; }
    left = pool - out.reduce((a, b) => a + b, 0);
    const next = open.filter((i) => out[i] < cap - 1e-9); const over = next.length < open.length; open = next; if (!over) break;
  }
  return out.map(Math.floor);
}

// one money operation at a time: closing hours, paying, settling raids, admin payouts
let chain = Promise.resolve();
export function locked(fn) { const run = chain.then(() => fn()); chain = run.catch(() => {}); return run; }

// ---------- 1. spot checks
async function runChecks() {
  const due = q("SELECT * FROM users WHERE status='active' AND wallet IS NOT NULL AND next_check_at<=? ORDER BY next_check_at LIMIT 150").all(now());
  if (due.length) await checkUsers(due);
}
// look at each user's current X profile picture and record whether the coin is on it.
// manual = the "check now" button: tells you the answer, but doesn't count or reschedule anything.
export async function checkUsers(users, { manual = false } = {}) {
  const r = rules(); const ep = epochOf(now()); const results = new Map();
  const profiles = await X.getUsers(users.map((u) => ({ id: u.x_id, handle: u.handle })));
  for (const u of users) {
    const p = profiles.get(u.x_id);
    const next = now() + r.checkEveryMinutes * 60000 * (0.55 + Math.random() * 0.9);
    if (!p) { if (!manual) q('UPDATE users SET next_check_at=?, last_error=? WHERE id=?').run(now() + 10 * 60000, 'could not read your X profile', u.id); results.set(u.id, { error: 'could not read your X profile' }); continue; }
    let w;
    try { w = await isWearing(p.avatar); } catch (e) { if (!manual) q('UPDATE users SET next_check_at=?, last_error=? WHERE id=?').run(now() + 5 * 60000, 'could not load your picture', u.id); results.set(u.id, { error: 'could not load your picture' }); continue; }
    const tag = r.nameTag && p.name.toLowerCase().includes(r.nameTag.toLowerCase()) ? 1 : 0;
    const ok = w.ok ? 1 : 0;
    results.set(u.id, { ok: !!ok, tag: !!tag, score: w.score });
    if (manual) { q('UPDATE users SET handle=?, name=?, avatar=?, followers=? WHERE id=?').run(p.handle, p.name, p.avatar, p.followers, u.id); continue; }
    const streak = ok ? (u.wearing && u.streak_since ? u.streak_since : now()) : 0;
    tx(() => {
      q('INSERT INTO checks(user_id,at,epoch,ok,tag,score) VALUES(?,?,?,?,?,?)').run(u.id, now(), ep, ok, tag, w.score || 0);
      q('UPDATE users SET handle=?, name=?, avatar=?, followers=?, joined_at=?, wearing=?, name_tag=?, streak_since=?, last_check_at=?, next_check_at=?, last_error=? WHERE id=?')
        .run(p.handle, p.name, p.avatar, p.followers, p.joinedAt || u.joined_at, ok, tag, streak, now(), next, '', u.id);
    });
    if (ok && !u.wearing) event('wear', `@${p.handle} put the coin on`, { pub: true, data: { handle: p.handle, avatar: p.avatar } });
    if (!ok && u.wearing) event('unwear', `@${p.handle} took the coin off`, { pub: true, data: { handle: p.handle } });
  }
  return results;
}

// ---------- 2. close each epoch (hour)
async function poolFor(r, live) {
  const dec = await decimals();
  if (r.poolMode === 'fixed') return { pool: SOL.toUnits(r.poolFixed, dec), source: `fixed ${r.poolFixed}` };
  if (r.poolMode === 'fees') {
    if (!live) return { pool: 0, source: 'fees (dry run: nothing claimed)' };
    // claim, then buy with a share of it (plus anything a failed buy left over last time)
    let carry = kvGet('fees_carry_sol', 0) || 0, claimed = 0, claimSig = '';
    try { const c = await PUMP.claimCreatorFees(); claimed = c.sol; claimSig = c.sig; } catch (e) { event('warn', 'creator fee claim failed: ' + e.message); }
    const b = await SOL.balances();
    const want = carry + claimed * (r.feesBuyPercent / 100);
    const spend = Math.max(0, Math.min(want, b.sol - CFG.solReserve));
    let buy = { tokens: 0, sig: '' };
    if (spend > 0.001) { try { buy = await PUMP.buyPfp(spend); carry = Math.max(0, want - spend); } catch (e) { event('warn', 'buy failed, will retry next hour: ' + e.message); carry = want; } }
    else carry = want;
    kvSet('fees_carry_sol', carry);
    if (claimed || buy.tokens) event('fees', `claimed ${claimed.toFixed(4)} SOL in creator fees, bought ${SOL.fromUnits(buy.tokens, dec).toLocaleString()} $${CFG.ticker}`, { pub: true, data: { claimSig, buySig: buy.sig, sol: claimed, tokens: buy.tokens } });
    return { pool: buy.tokens, source: `fees ${claimed.toFixed(4)} SOL` };
  }
  const free = await freeTokens();
  return { pool: Math.floor((free * r.poolPercent) / 100), source: `${r.poolPercent}% of ${SOL.fromUnits(free, dec).toLocaleString()}` };
}

async function _closeEpoch(id) {
  if (q('SELECT 1 FROM epochs WHERE id=?').get(id)) return { id, skipped: 'already closed' };
  const r = rules(); const live = !!r.live; const dec = await decimals();
  const rows = q(`SELECT c.user_id, COUNT(*) total, SUM(c.ok) oks, MAX(c.tag) tag, u.* FROM checks c JOIN users u ON u.id=c.user_id
    WHERE c.epoch=? AND u.status='active' AND u.wallet IS NOT NULL GROUP BY c.user_id HAVING oks>0`).all(id);
  let list = rows.filter((u) => !eligibility(u, r).length);
  if (r.minHold > 0 && list.length) {
    try { const h = await SOL.holdings(list.map((u) => u.wallet)); const need = SOL.toUnits(r.minHold, dec); list = list.filter((u) => (h.get(u.wallet) || 0) >= need); }
    catch (e) { event('warn', 'MIN_HOLD check failed, skipping it this hour: ' + e.message); }
  }
  const end = (id + 1) * epochMs();
  const weights = list.map((u) => { const p = weightParts({ ...u, name_tag: u.tag }, r, end); return p.total * (u.oks / u.total); });
  let pool = 0, source = 'nobody wearing';
  if (list.length || r.poolMode === 'fees') ({ pool, source } = await poolFor(r, live));
  if (live && r.poolMode !== 'fees' && pool > 0) { const free = await freeTokens(); if (pool > free) { event('warn', `pool trimmed to what the treasury has free (${SOL.fromUnits(free, dec)})`); pool = free; } }
  if (!list.length) pool = 0;
  const shares = split(weights, pool, r.maxSharePercent / 100);
  const paid = shares.reduce((a, b) => a + b, 0);
  const done = tx(() => {
    const ins = q('INSERT OR IGNORE INTO epochs(id,starts_at,ends_at,pool,wearers,total_weight,source,note,closed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, id * epochMs(), end, paid, list.length, weights.reduce((a, b) => a + b, 0), source, live ? '' : 'dry run', now());
    if (ins.changes !== 1) return false; // someone else closed it first
    list.forEach((u, i) => { if (shares[i] > 0) q('INSERT INTO ledger(user_id,kind,ref,amount,at) VALUES(?,?,?,?,?)').run(u.user_id, live ? 'epoch' : 'dry', 'e' + id, shares[i], now()); });
    return true;
  });
  if (done && list.length) event('epoch', `${live ? '' : '[dry run] '}hour closed: ${SOL.fromUnits(paid, dec).toLocaleString()} $${CFG.ticker} split across ${list.length} wearer${list.length > 1 ? 's' : ''}`, { pub: true, data: { epoch: id, pool: paid, wearers: list.length, dry: !live } });
  return { id, pool: done ? paid : 0, wearers: list.length };
}
export const closeEpoch = (id) => locked(() => _closeEpoch(id));
async function _closeEpochs() {
  const cur = epochOf(now()); let last = kvGet('last_epoch');
  if (last === null) { kvSet('last_epoch', cur - 1); return; }
  if (cur - 1 - last > 48) last = cur - 2; // bot was off for days: don't replay them all
  for (let e = last + 1; e < cur; e++) {
    if (now() < (e + 1) * epochMs() + 60000) break; // give the last checks a minute to land
    await _closeEpoch(e); kvSet('last_epoch', e);
  }
}
const closeEpochs = () => locked(_closeEpochs);

// ---------- 3. payouts
// every status change only happens from the state we expect, so nothing can be refunded or confirmed twice
function refund(pid, why) {
  return tx(() => {
    const p = q('SELECT * FROM payouts WHERE id=?').get(pid);
    const ch = q("UPDATE payouts SET status='failed', error=?, updated_at=? WHERE id=? AND status IN ('queued','sent')").run(String(why).slice(0, 300), now(), pid);
    if (ch.changes === 1) q("INSERT INTO ledger(user_id,kind,ref,amount,at) VALUES(?,?,?,?,?)").run(p.user_id, 'refund', 'p' + pid, p.amount, now());
    return ch.changes === 1;
  });
}
const confirm = (pid) => q("UPDATE payouts SET status='confirmed', updated_at=? WHERE id=? AND status='sent'").run(now(), pid);
async function _reconcile() {
  for (const p of q("SELECT * FROM payouts WHERE status='sent'").all()) {
    const s = await SOL.status(p.signature, p.last_valid_height).catch(() => 'pending');
    if (s === 'confirmed') confirm(p.id);
    else if (s === 'failed' || s === 'expired') refund(p.id, s);
  }
}
const reconcile = () => locked(_reconcile);
async function _runPayouts(force = false) {
  const r = rules(); if (!r.live || r.paused) return { skipped: 'dry run or paused' };
  const last = kvGet('last_payout_at', 0); if (!force && now() - last < r.payoutEveryMinutes * 60000) return { skipped: 'not yet' };
  kvSet('last_payout_at', now());
  await _reconcile();
  const dec = await decimals(); const min = Math.max(1, SOL.toUnits(r.payoutMin, dec));
  const owed = q(`SELECT u.id, u.wallet, u.handle, COALESCE(SUM(l.amount),0) bal FROM users u JOIN ledger l ON l.user_id=u.id
    WHERE u.status='active' AND u.wallet IS NOT NULL AND l.kind!='dry' GROUP BY u.id HAVING bal>=? ORDER BY bal DESC`).all(min);
  if (!owed.length) return { paid: 0 };
  const b = await SOL.balances(); state.bal = b; state.balAt = now();
  let tokens = b.token - Number(q("SELECT COALESCE(SUM(amount),0) s FROM payouts WHERE status IN ('queued','sent')").get().s);
  let sol = b.sol - CFG.solReserve;
  const items = [];
  for (const o of owed) {
    const amt = Number(o.bal); if (amt < min || amt > tokens || sol < 0.0035) continue;
    tokens -= amt; sol -= 0.0025; items.push({ ...o, amount: amt });
  }
  if (items.length < owed.length) event('warn', `treasury low: paying ${items.length}/${owed.length} this round (SOL ${b.sol.toFixed(4)}, $${CFG.ticker} ${SOL.fromUnits(b.token, dec)})`);
  let sent = 0;
  for (let i = 0; i < items.length; i += 7) {
    const rowsP = tx(() => items.slice(i, i + 7).filter((it) => balanceOf(it.id) >= it.amount).map((it) => {
      const id = q("INSERT INTO payouts(user_id,wallet,amount,status,created_at,updated_at) VALUES(?,?,?,'queued',?,?)").run(it.id, it.wallet, it.amount, now(), now()).lastInsertRowid;
      q("INSERT INTO ledger(user_id,kind,ref,amount,at) VALUES(?,?,?,?,?)").run(it.id, 'payout', 'p' + id, -it.amount, now());
      return { ...it, pid: Number(id) };
    }));
    if (!rowsP.length) continue;
    let built;
    try { built = await SOL.buildPayoutTx(rowsP); } catch (e) { rowsP.forEach((p) => refund(p.pid, 'build: ' + e.message)); event('error', 'payout build failed: ' + e.message); continue; }
    // written BEFORE sending: after a crash we know exactly which transaction to look for
    for (const p of rowsP) q("UPDATE payouts SET status='sent', signature=?, last_valid_height=?, updated_at=? WHERE id=? AND status='queued'").run(built.signature, built.lastValidBlockHeight, now(), p.pid);
    try {
      await SOL.send(built.raw);
      const res = await SOL.waitFor(built.signature, built.lastValidBlockHeight, built.raw);
      if (res.ok) {
        for (const p of rowsP) confirm(p.pid);
        sent += rowsP.length;
        event('payout', `paid ${rowsP.map((p) => '@' + p.handle).join(', ')}`, { pub: true, data: { sig: built.signature, items: rowsP.map((p) => ({ handle: p.handle, amount: p.amount })) } });
      } else rowsP.forEach((p) => refund(p.pid, res.err || 'expired'));
    } catch (e) {
      // rejected by the RPC = it never went out, refund now; otherwise it stays 'sent' and reconcile() settles it
      if (e.rejected) rowsP.forEach((p) => refund(p.pid, e.message));
      event('error', 'payout send: ' + e.message);
    }
  }
  return { paid: sent };
}
export const runPayouts = (force = false) => locked(() => _runPayouts(force));

// ---------- 4. raids
export async function enterRaid(raidId, user, tweetUrl) {
  const raid = q('SELECT * FROM raids WHERE id=?').get(raidId);
  if (!raid || raid.status !== 'live' || now() > raid.ends_at) throw new Error('this raid is over');
  if (raid.kind === 'retweet') throw new Error('retweet raids are automatic, just retweet it');
  const why = eligibility(user); if (why.length) throw new Error('not eligible yet: ' + why.join(', '));
  const id = X.tweetIdFrom(tweetUrl); if (!id) throw new Error('paste the link to your post');
  const t = await X.getTweet(id); if (!t) throw new Error("couldn't find that post");
  if (t.authorId !== user.x_id) throw new Error('that post is not from your account');
  if (raid.kind === 'quote' && t.quoteId !== raid.tweet_id) throw new Error('that post does not quote the raid post');
  if (raid.kind === 'reply' && t.replyToId !== raid.tweet_id) throw new Error('that post is not a reply to the raid post');
  if (t.createdAt && t.createdAt < raid.starts_at - 60000) throw new Error('post it after the raid started');
  q('INSERT OR IGNORE INTO raid_entries(raid_id,user_id,entry_tweet_id,weight,at) VALUES(?,?,?,?,?)').run(raid.id, user.id, t.id, bandMult(user.followers), now());
  q('UPDATE raids SET entries=(SELECT COUNT(*) FROM raid_entries WHERE raid_id=?) WHERE id=?').run(raid.id, raid.id);
  return { ok: true };
}
async function settleRaid(raid) {
  const r = rules(); const live = !!r.live; const dec = await decimals();
  if (raid.kind === 'retweet') {
    const ids = await X.getRetweeters(raid.tweet_id); // throws on API trouble: the raid waits and retries
    for (const u of q("SELECT * FROM users WHERE status='active' AND wallet IS NOT NULL").all()) if (ids.has(u.x_id)) q('INSERT OR IGNORE INTO raid_entries(raid_id,user_id,weight,at) VALUES(?,?,?,?)').run(raid.id, u.id, bandMult(u.followers), now());
  }
  let entries = q("SELECT e.*, u.wearing, u.handle, u.followers, u.joined_at FROM raid_entries e JOIN users u ON u.id=e.user_id WHERE e.raid_id=? AND u.status='active'").all(raid.id);
  // must be eligible and have worn the coin during the raid
  entries = entries.filter((e) => !eligibility(e, r).length && (e.wearing || q('SELECT 1 FROM checks WHERE user_id=? AND ok=1 AND at>=? LIMIT 1').get(e.user_id, raid.starts_at)));
  if (raid.kind !== 'retweet') {
    const keep = [];
    for (const e of entries) { const t = await X.getTweet(e.entry_tweet_id).catch(() => undefined); if (t !== null) keep.push(e); } // only a real "not found" drops a post
    entries = keep;
  }
  let pool = raid.pool;
  if (live) { const b = await SOL.balances(); const free = b.token - liabilities() - (reservedForRaids() - raid.pool); if (pool > free) { event('warn', `raid #${raid.id} pot trimmed to what the treasury has free`); pool = Math.max(0, free); } }
  const shares = split(entries.map((e) => e.weight), pool, (r.maxSharePercent * 2) / 100);
  const done = tx(() => {
    const ch = q("UPDATE raids SET status='settled', settled_at=?, entries=? WHERE id=? AND status='live'").run(now(), entries.length, raid.id);
    if (ch.changes !== 1) return false; // cancelled or already settled meanwhile
    entries.forEach((e, i) => { q('UPDATE raid_entries SET reward=? WHERE raid_id=? AND user_id=?').run(shares[i], raid.id, e.user_id); if (shares[i] > 0) q('INSERT INTO ledger(user_id,kind,ref,amount,at) VALUES(?,?,?,?,?)').run(e.user_id, live ? 'raid' : 'dry', 'r' + raid.id, shares[i], now()); });
    return true;
  });
  if (done) event('raid', `${live ? '' : '[dry run] '}raid #${raid.id} paid ${SOL.fromUnits(shares.reduce((a, b) => a + b, 0), dec).toLocaleString()} $${CFG.ticker} to ${entries.length} raider${entries.length === 1 ? '' : 's'}`, { pub: true, data: { raid: raid.id } });
}
async function _settleRaids() {
  for (const raid of q("SELECT * FROM raids WHERE status='live' AND ends_at<=?").all(now())) {
    try { await settleRaid(raid); } catch (e) { event('warn', `raid #${raid.id} not settled yet: ${e.message}`); }
  }
}
const settleRaids = () => locked(_settleRaids);

// ---------- loop
const lastRun = {};
async function every(name, ms, fn) {
  if (now() - (lastRun[name] || 0) < ms) return; lastRun[name] = now();
  try { await fn(); } catch (e) { state.errors++; event('error', `${name}: ${e.message}`); }
}
export async function tick() {
  if (state.running) return; state.running = true; state.lastTick = now();
  try {
    if (!rules().paused) await every('checks', 10000, runChecks);
    await every('epochs', 20000, closeEpochs);
    await every('raids', 60000, settleRaids);
    await every('payouts', 30000, () => runPayouts());
    await every('balances', 60000, () => treasuryBalances(true));
    await every('prune', 6 * H, async () => { q('DELETE FROM checks WHERE at<?').run(now() - 14 * 24 * H); q('DELETE FROM claims WHERE created_at<?').run(now() - 48 * H); q('DELETE FROM events WHERE at<? AND public=0').run(now() - 30 * 24 * H); });
  } finally { state.running = false; }
}
export function start() {
  // a crash between "debited" and "sent" leaves 'queued' rows that were never broadcast: give the money back
  locked(async () => { for (const p of q("SELECT id FROM payouts WHERE status='queued'").all()) refund(p.id, 'bot restarted before sending'); });
  setInterval(tick, 5000); tick();
}
export { runChecks, closeEpochs, settleRaids, reconcile };
