// All settings come from environment variables (.env locally, Railway "Variables" in production).
// Anything marked [admin] can also be changed live from the admin page; the admin value wins.
import 'dotenv/config';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const num = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) ? v : d; };
const bool = (k, d) => { const v = env(k, d ? 'true' : 'false').toLowerCase(); return v === 'true' || v === '1' || v === 'yes'; };
const list = (k) => env(k).split(',').map((s) => s.trim()).filter(Boolean);

export const CFG = {
  port: num('PORT', 8080),
  dataDir: env('DATA_DIR', './data'),
  // where the public site lives (for CORS and the X login redirect). Empty = same origin as the bot.
  siteUrl: env('SITE_URL').replace(/\/$/, ''),
  publicUrl: env('PUBLIC_URL').replace(/\/$/, ''), // the bot's own https URL (needed for X login callback)
  corsOrigins: list('CORS_ORIGINS'),
  sessionSecret: env('SESSION_SECRET'), // auto-generated into the data dir if empty

  // admin: connect one of these wallets on /admin (sign a message), or use ADMIN_KEY
  adminWallets: list('ADMIN_WALLETS'),
  adminKey: env('ADMIN_KEY'),

  // X data. twitterapi.io is the recommended paid source (cheap, needed for retweet raids).
  // X_BEARER = official X API. Without either, the free api.fxtwitter.com is used.
  twitterApiKey: env('TWITTERAPI_KEY'),
  xBearer: env('X_BEARER'),
  // Sign in with X (OAuth 2.0). Optional; without it users verify by posting a code.
  xClientId: env('X_CLIENT_ID'),
  xClientSecret: env('X_CLIENT_SECRET'),

  // Solana
  rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  treasurySecret: env('TREASURY_SECRET'), // base58 or [..] json; empty = the bot makes its own wallet in DATA_DIR
  mint: env('PFP_MINT'),
  ticker: env('TICKER', 'PFP'),
  priorityMicroLamports: num('PRIORITY_FEE_MICROLAMPORTS', 50000),
  solReserve: num('SOL_RESERVE', 0.05), // never spend the treasury below this much SOL
  pumpPortal: env('PUMPPORTAL_URL', 'https://pumpportal.fun/api/trade-local'),

  // rules (defaults; [admin] can override)
  rules: {
    live: bool('LIVE', false),                         // [admin] false = dry run, nothing is sent on-chain
    paused: false,                                     // [admin]
    epochMinutes: num('EPOCH_MINUTES', 60),
    checkEveryMinutes: num('CHECK_EVERY_MINUTES', 20), // each wearer is spot-checked at random times, ~this often
    poolMode: env('POOL_MODE', 'percent'),             // [admin] fixed | percent | fees
    poolFixed: num('POOL_FIXED', 0),                   // [admin] tokens per epoch (fixed mode)
    poolPercent: num('POOL_PERCENT', 1),               // [admin] % of free treasury $PFP per epoch (percent mode)
    feesBuyPercent: num('FEES_BUY_PERCENT', 90),       // [admin] fees mode: % of claimed SOL that buys $PFP
    minFollowers: num('MIN_FOLLOWERS', 50),            // [admin]
    minAccountDays: num('MIN_ACCOUNT_DAYS', 30),       // [admin]
    minHold: num('MIN_HOLD', 0),                       // [admin] must hold this many $PFP to get paid (0 = off)
    bands: env('BANDS', '0:1,1000:2,10000:4,100000:8'), // followers:multiplier
    nameTag: env('NAME_TAG', '$PFP'),
    nameTagBonus: num('NAME_TAG_BONUS', 0.5),          // [admin] +50% with the tag in your display name
    streakBonusPerHour: num('STREAK_BONUS_PER_HOUR', 0.02),
    streakBonusMax: num('STREAK_BONUS_MAX', 0.5),
    maxSharePercent: num('MAX_SHARE_PERCENT', 5),      // [admin] one account can't take more than this % of a pool
    payoutMin: num('PAYOUT_MIN', 1),                   // [admin] tokens; smaller balances wait
    payoutEveryMinutes: num('PAYOUT_EVERY_MINUTES', 60),
  },
};

export function parseBands(s) {
  return s.split(',').map((p) => p.split(':').map(Number)).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a, b) => a[0] - b[0]);
}
