// X (Twitter) data. Picks the best source that's configured:
//   TWITTERAPI_KEY -> api.twitterapi.io (paid, cheap, batch lookups, retweeters)
//   X_BEARER       -> official X API v2
//   neither        -> api.fxtwitter.com (free, one profile per request)
import { CFG } from './settings.js';

const UA = 'pfpRent-bot/1.0';
const FX = (process.env.FXTWITTER_BASE || 'https://api.fxtwitter.com').replace(/\/$/, '');
export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const source = () => (CFG.twitterApiKey ? 'twitterapi' : CFG.xBearer ? 'xapi' : 'fxtwitter');

export function cleanHandle(h) { return String(h || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0]; }
export function tweetIdFrom(u) { const s = String(u || '').trim(); const m = s.match(/status(?:es)?\/(\d{1,25})/) || s.match(/^(\d{1,25})$/); return m ? m[1] : null; }
export function bigAvatar(u) { return (u || '').replace(/_(normal|bigger|mini|200x200|400x400)(\.\w+)$/i, '_400x400$2'); }

async function getJSON(url, headers = {}, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return { __status: 404 };
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status} from ${new URL(url).host}`); await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
      const j = await r.json().catch(() => ({}));
      // only a real "not found" may read as missing; auth/credit/other errors must throw so nobody gets dropped by mistake
      if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}: ${(j.error || j.message || j.msg || '').toString().slice(0, 120)}`);
      if (j.status === 'error' && !/not.?found|suspend|unavailable|does not exist/i.test(j.msg || j.message || '')) throw new Error(`${new URL(url).host}: ${j.msg || j.message}`);
      j.__status = r.status; return j;
    } catch (e) { if (/ from /.test(e.message) && !/^(429|5\d\d) /.test(e.message)) throw e; last = e; await new Promise((s) => setTimeout(s, 1000 * (i + 1))); }
  }
  throw last;
}

// ---------- normalizers -> { id, handle, name, description, followers, avatar, joinedAt, protected }
const fromFx = (u) => u && ({ id: String(u.id), handle: u.screen_name, name: u.name || '', description: u.description || '', followers: u.followers | 0, avatar: bigAvatar(u.avatar_url), joinedAt: Date.parse(u.joined) || 0, protected: !!u.protected });
const fromTA = (u) => u && !u.unavailable && ({ id: String(u.id), handle: u.userName, name: u.name || '', description: u.description || '', followers: u.followers | 0, avatar: bigAvatar(u.profilePicture), joinedAt: Date.parse(u.createdAt) || 0, protected: !!u.protected });
const fromX = (u) => u && ({ id: String(u.id), handle: u.username, name: u.name || '', description: u.description || '', followers: u.public_metrics?.followers_count | 0, avatar: bigAvatar(u.profile_image_url), joinedAt: Date.parse(u.created_at) || 0, protected: !!u.protected });
const X_USER_FIELDS = 'user.fields=profile_image_url,public_metrics,created_at,description,protected';

export async function getUser(handle) {
  handle = cleanHandle(handle); if (!HANDLE_RE.test(handle)) return null;
  const s = source();
  if (s === 'twitterapi') { const j = await getJSON(`https://api.twitterapi.io/twitter/user/info?userName=${handle}`, { 'x-api-key': CFG.twitterApiKey }); return fromTA(j.data) || null; }
  if (s === 'xapi') { const j = await getJSON(`https://api.x.com/2/users/by/username/${handle}?${X_USER_FIELDS}`, { authorization: `Bearer ${CFG.xBearer}` }); return fromX(j.data) || null; }
  const j = await getJSON(`${FX}/${handle}`); return j.user ? fromFx(j.user) : null;
}

// many users at once: [{id, handle}] -> Map(id -> profile). Missing = not found / suspended.
export async function getUsers(list) {
  const out = new Map(); const s = source();
  if (s === 'twitterapi') {
    for (let i = 0; i < list.length; i += 100) {
      const ids = list.slice(i, i + 100).map((u) => u.id).join(',');
      const j = await getJSON(`https://api.twitterapi.io/twitter/user/batch_info_by_ids?userIds=${ids}`, { 'x-api-key': CFG.twitterApiKey });
      for (const u of j.users || []) { const p = fromTA(u); if (p) out.set(p.id, p); }
    }
    return out;
  }
  if (s === 'xapi') {
    for (let i = 0; i < list.length; i += 100) {
      const ids = list.slice(i, i + 100).map((u) => u.id).join(',');
      const j = await getJSON(`https://api.x.com/2/users?ids=${ids}&${X_USER_FIELDS}`, { authorization: `Bearer ${CFG.xBearer}` });
      for (const u of j.data || []) { const p = fromX(u); if (p) out.set(p.id, p); }
    }
    return out;
  }
  // fxtwitter: one by one, a few at a time, gently
  let k = 0;
  const worker = async () => { while (k < list.length) { const u = list[k++]; try { const p = await getUser(u.handle); if (p) out.set(p.id, p); } catch { /* skip this round */ } await new Promise((s) => setTimeout(s, 250)); } };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

// -> { id, authorId, authorHandle, text, createdAt, quoteId, replyToId } | null
export async function getTweet(id) {
  const s = source();
  if (s === 'twitterapi') {
    const j = await getJSON(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${id}`, { 'x-api-key': CFG.twitterApiKey });
    const t = (j.tweets || [])[0]; if (!t) return null;
    return { id: String(t.id), authorId: String(t.author?.id || ''), authorHandle: t.author?.userName || '', text: t.text || '', createdAt: Date.parse(t.createdAt) || 0, quoteId: t.quoted_tweet?.id ? String(t.quoted_tweet.id) : null, replyToId: t.inReplyToId ? String(t.inReplyToId) : null, isRetweet: !!t.retweeted_tweet || /^RT @/.test(t.text || '') };
  }
  if (s === 'xapi') {
    const j = await getJSON(`https://api.x.com/2/tweets/${id}?tweet.fields=created_at,referenced_tweets,author_id,text&expansions=author_id&user.fields=username`, { authorization: `Bearer ${CFG.xBearer}` });
    const t = j.data; if (!t) return null; const ref = (k) => (t.referenced_tweets || []).find((r) => r.type === k)?.id || null;
    return { id: String(t.id), authorId: String(t.author_id), authorHandle: j.includes?.users?.[0]?.username || '', text: t.text || '', createdAt: Date.parse(t.created_at) || 0, quoteId: ref('quoted'), replyToId: ref('replied_to'), isRetweet: !!ref('retweeted') || /^RT @/.test(t.text || '') };
  }
  const j = await getJSON(`${FX}/i/status/${id}`);
  const t = j.tweet; if (!t) return null;
  return { id: String(t.id), authorId: String(t.author?.id || ''), authorHandle: t.author?.screen_name || '', text: t.text || '', createdAt: (t.created_timestamp || 0) * 1000, quoteId: t.quote?.id ? String(t.quote.id) : null, replyToId: t.replying_to_status ? String(t.replying_to_status) : null, isRetweet: !!t.reposted_by || /^RT @/.test(t.text || '') };
}

export const canReadRetweets = () => source() !== 'fxtwitter';
// -> Set of user ids that retweeted
export async function getRetweeters(tweetId, max = 5000) {
  const ids = new Set(); const s = source();
  if (s === 'twitterapi') {
    let cursor = '';
    for (let page = 0; page < 60 && ids.size < max; page++) {
      const j = await getJSON(`https://api.twitterapi.io/twitter/tweet/retweeters?tweetId=${tweetId}&cursor=${encodeURIComponent(cursor)}`, { 'x-api-key': CFG.twitterApiKey });
      for (const u of j.users || []) ids.add(String(u.id));
      if (!j.has_next_page || !j.next_cursor) break; cursor = j.next_cursor;
    }
  } else if (s === 'xapi') {
    let token = '';
    for (let page = 0; page < 50 && ids.size < max; page++) {
      const j = await getJSON(`https://api.x.com/2/tweets/${tweetId}/retweeted_by?max_results=100${token ? '&pagination_token=' + token : ''}`, { authorization: `Bearer ${CFG.xBearer}` });
      for (const u of j.data || []) ids.add(String(u.id));
      token = j.meta?.next_token; if (!token) break;
    }
  }
  return ids;
}

// ---------- Sign in with X (OAuth 2.0 + PKCE)
export const xLoginEnabled = () => !!(CFG.xClientId && CFG.publicUrl);
export function xAuthUrl(state, challenge) {
  const p = new URLSearchParams({ response_type: 'code', client_id: CFG.xClientId, redirect_uri: `${CFG.publicUrl}/auth/x/callback`, scope: 'users.read tweet.read', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `https://x.com/i/oauth2/authorize?${p}`;
}
export async function xExchange(code, verifier) {
  const body = new URLSearchParams({ code, grant_type: 'authorization_code', client_id: CFG.xClientId, redirect_uri: `${CFG.publicUrl}/auth/x/callback`, code_verifier: verifier });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (CFG.xClientSecret) headers.authorization = 'Basic ' + Buffer.from(`${CFG.xClientId}:${CFG.xClientSecret}`).toString('base64');
  const r = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
  const t = await r.json(); if (!t.access_token) throw new Error('X login failed: ' + (t.error_description || t.error || r.status));
  const me = await fetch(`https://api.x.com/2/users/me?${X_USER_FIELDS}`, { headers: { authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(15000) }).then((x) => x.json());
  if (!me.data) throw new Error('X login: could not read your profile');
  return fromX(me.data);
}
