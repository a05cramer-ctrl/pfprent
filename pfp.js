// Is this profile picture wearing the coin?
// The official $PFP logo and every "face on the coin" PFP made on the site share one frame:
// a thick white rim, a black gap, a thin white ring. We look for that frame, allowing for
// X's JPEG compression and for people nudging the crop when they upload.
import sharp from 'sharp';
import { q, now } from './db.js';

// frame geometry, as fractions of the image half-width (keep in sync with the site's frame maker)
export const FRAME = { rimOut: 0.94, rimIn: 0.756, gapIn: 0.696, thinIn: 0.648, photo: 0.63, bust: 0.584 };
const RADII = { rim: [0.79, 0.848, 0.905], gap: [0.726], thin: [0.672] };
const N = 256, ANG = 96;
const COS = [], SIN = [];
for (let i = 0; i < ANG; i++) { const a = (i / ANG) * Math.PI * 2; COS.push(Math.cos(a)); SIN.push(Math.sin(a)); }

async function pixels(buf) {
  const { data } = await sharp(buf, { failOn: 'none' }).rotate().resize(N, N, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const L = new Float32Array(N * N), C = new Float32Array(N * N);
  for (let i = 0, j = 0; i < N * N; i++, j += 3) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b; C[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { L, C };
}
function sample(A, x, y) {
  if (x < 0 || y < 0 || x > N - 1.001 || y > N - 1.001) return -1;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * N + x0;
  return A[i] * (1 - fx) * (1 - fy) + A[i + 1] * fx * (1 - fy) + A[i + N] * (1 - fx) * fy + A[i + N + 1] * fx * fy;
}

function scoreAt({ L, C }, cx, cy, R) {
  let rim = 0, gap = 0, thin = 0;
  for (let a = 0; a < ANG; a++) {
    let ok = true;
    for (const r of RADII.rim) { const x = cx + COS[a] * r * R, y = cy + SIN[a] * r * R; const l = sample(L, x, y); if (l < 170 || sample(C, x, y) > 70) { ok = false; break; } }
    if (ok) rim++;
    { const x = cx + COS[a] * RADII.gap[0] * R, y = cy + SIN[a] * RADII.gap[0] * R; const l = sample(L, x, y); if (l >= 0 && l < 100) gap++; }
    { const x = cx + COS[a] * RADII.thin[0] * R, y = cy + SIN[a] * RADII.thin[0] * R; const l = sample(L, x, y); if (l >= 165 && sample(C, x, y) <= 80) thin++; }
  }
  return { rim: rim / ANG, gap: gap / ANG, thin: thin / ANG };
}

// -> { ok, score, rim, gap, thin }
export async function analyze(buf) {
  const px = await pixels(buf);
  const H = N / 2; let best = { score: -1 };
  // coarse search over centre and size, then refine around the best
  const tryAt = (dx, dy, s) => { const cx = H - 0.5 + dx * H, cy = H - 0.5 + dy * H, R = H * s; const r = scoreAt(px, cx, cy, R); const score = Math.min(r.rim, r.gap, Math.min(1, r.thin * 1.15)); if (score > best.score) best = { score, ...r, dx, dy, s }; };
  for (let s = 0.86; s <= 1.141; s += 0.035) for (let dx = -0.09; dx <= 0.091; dx += 0.03) for (let dy = -0.09; dy <= 0.091; dy += 0.03) tryAt(dx, dy, s);
  const b = best;
  for (let s = b.s - 0.02; s <= b.s + 0.021; s += 0.01) for (let dx = b.dx - 0.02; dx <= b.dx + 0.021; dx += 0.01) for (let dy = b.dy - 0.02; dy <= b.dy + 0.021; dy += 0.01) tryAt(dx, dy, s);
  const ok = best.rim >= 0.82 && best.gap >= 0.78 && best.thin >= 0.62;
  return { ok, score: +best.score.toFixed(3), rim: +best.rim.toFixed(3), gap: +best.gap.toFixed(3), thin: +best.thin.toFixed(3) };
}

const ALLOWED_HOSTS = process.env.AVATAR_HOSTS ? new RegExp(process.env.AVATAR_HOSTS) : /^(pbs|abs)\.twimg\.com$/;
export async function fetchAvatar(url) {
  const u = new URL(url); if (!ALLOWED_HOSTS.test(u.hostname)) throw new Error('avatar host not allowed');
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('avatar ' + r.status);
  const len = +r.headers.get('content-length') || 0; if (len > 5e6) throw new Error('avatar too big');
  return Buffer.from(await r.arrayBuffer());
}

// cached by image URL: X gives every new profile picture a new URL
export async function isWearing(url) {
  if (!url || /default_profile/.test(url)) return { ok: false, score: 0, cached: true };
  const c = q('SELECT ok, score FROM avatars WHERE url=?').get(url);
  if (c) return { ok: !!c.ok, score: c.score, cached: true };
  const r = await analyze(await fetchAvatar(url));
  q('INSERT OR REPLACE INTO avatars(url,ok,score,at) VALUES(?,?,?,?)').run(url, r.ok ? 1 : 0, r.score, now());
  return r;
}
