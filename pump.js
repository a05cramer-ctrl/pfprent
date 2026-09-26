// pump.fun via PumpPortal's local-transaction API: we get an unsigned tx, the treasury signs it.
// Creator fees only land in the treasury if the treasury wallet is the coin's creator wallet.
import { CFG } from './settings.js';
import { treasuryAddress, signAndSend, conn, treasury, mintInfo } from './solana.js';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

async function portal(body) {
  const r = await fetch(CFG.pumpPortal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: treasuryAddress, priorityFee: 0.0001, ...body }), signal: AbortSignal.timeout(20000) });
  if (r.status !== 200) throw new Error(`PumpPortal ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return new Uint8Array(await r.arrayBuffer());
}
const solBal = async () => (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
async function tokBal() {
  const m = await mintInfo(); const ata = getAssociatedTokenAddressSync(m.mint, new PublicKey(treasuryAddress), false, m.programId);
  const b = await conn.getTokenAccountBalance(ata).catch(() => null); return b ? Number(b.value.amount) : 0;
}

// -> { sig, sol } SOL received
export async function claimCreatorFees() {
  const before = await solBal();
  const sig = await signAndSend(await portal({ action: 'collectCreatorFee' }));
  await new Promise((s) => setTimeout(s, 1500));
  return { sig, sol: Math.max(0, (await solBal()) - before) };
}

// -> { sig, tokens } base units bought
export async function buyPfp(sol) {
  if (!(sol > 0)) return { sig: '', tokens: 0 };
  const before = await tokBal();
  const sig = await signAndSend(await portal({ action: 'buy', mint: CFG.mint, amount: +sol.toFixed(6), denominatedInSol: 'true', slippage: 15, pool: 'auto' }));
  await new Promise((s) => setTimeout(s, 1500));
  return { sig, tokens: Math.max(0, (await tokBal()) - before) };
}
