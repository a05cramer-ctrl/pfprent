import { CFG } from './settings.js';
import { rules } from './db.js';
import { app } from './api.js';
import * as E from './engine.js';
import { treasuryAddress } from './solana.js';
import { source, xLoginEnabled } from './x.js';

app.listen(CFG.port, () => {
  const r = rules();
  console.log(`pfpRent bot on :${CFG.port}
  treasury   ${treasuryAddress}
  mint       ${CFG.mint || '(PFP_MINT not set yet)'}
  X data     ${source()}${xLoginEnabled() ? ' + Sign in with X' : ''}
  payouts    ${r.live ? 'LIVE' : 'dry run (turn on in /admin)'}  pool: ${r.poolMode}`);
  E.start();
});
process.on('unhandledRejection', (e) => console.error('unhandled', e));
