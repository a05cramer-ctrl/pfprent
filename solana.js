// Treasury wallet: balances, payout transfers, signing PumpPortal transactions.
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL, SystemProgram, SendTransactionError,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getMint,
} from '@solana/spl-token';
import { CFG } from './settings.js';
import { event } from './db.js';

export const conn = new Connection(CFG.rpcUrl, { commitment: 'confirmed' });

// ---------- treasury key: from TREASURY_SECRET, else the bot makes one and keeps it in the data folder
function loadTreasury() {
  const s = CFG.treasurySecret;
  if (s) return Keypair.fromSecretKey(s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s));
  const f = path.join(CFG.dataDir, 'treasury.json');
  if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
  const kp = Keypair.generate();
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  event('treasury', `created a new treasury wallet ${kp.publicKey.toBase58()} (backup: ${f})`);
  return kp;
}
export const treasury = loadTreasury();
export const treasuryAddress = treasury.publicKey.toBase58();
export function treasuryBackup() { return { address: treasuryAddress, secretKeyBase58: bs58.encode(treasury.secretKey), secretKeyJson: JSON.stringify(Array.from(treasury.secretKey)) }; }

export function isWallet(a) { try { const k = new PublicKey(a); return PublicKey.isOnCurve(k.toBytes()) ? k.toBase58() : null; } catch { return null; } }

// ---------- the $PFP mint (works for classic SPL and Token-2022 mints)
let MINT = null;
export async function mintInfo() {
  if (MINT) return MINT;
  if (!CFG.mint) return null;
  const mint = new PublicKey(CFG.mint);
  const acc = await conn.getAccountInfo(mint); if (!acc) throw new Error('PFP_MINT not found on chain');
  const programId = acc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(conn, mint, 'confirmed', programId);
  MINT = { mint, programId, decimals: m.decimals };
  return MINT;
}
export const toUnits = (tokens, dec) => Math.floor(Number(tokens) * 10 ** dec);
export const fromUnits = (units, dec) => Number(units) / 10 ** dec;

export async function balances() {
  const sol = (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
  const m = await mintInfo().catch(() => null); let token = 0;
  if (m) {
    const ata = getAssociatedTokenAddressSync(m.mint, treasury.publicKey, false, m.programId);
    // no token account yet = 0; any other RPC error must throw, never read as an empty treasury
    if (await conn.getAccountInfo(ata)) token = Number((await conn.getTokenAccountBalance(ata)).value.amount);
  }
  return { sol, token, decimals: m?.decimals ?? 6 };
}

// token balance (base units) for many wallets; used by the MIN_HOLD rule
export async function holdings(wallets) {
  const m = await mintInfo(); const out = new Map(); if (!m) return out;
  for (let i = 0; i < wallets.length; i += 100) {
    const chunk = wallets.slice(i, i + 100); const atas = chunk.map((w) => getAssociatedTokenAddressSync(m.mint, new PublicKey(w), false, m.programId));
    const infos = await conn.getMultipleParsedAccounts(atas);
    infos.value.forEach((a, j) => out.set(chunk[j], a ? Number(a.data?.parsed?.info?.tokenAmount?.amount || 0) : 0));
  }
  return out;
}

const priority = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CFG.priorityMicroLamports });

// build one transaction paying several wallets. Creates their token account if they don't have one.
export async function buildPayoutTx(items) {
  const m = await mintInfo(); if (!m) throw new Error('PFP_MINT not set');
  const from = getAssociatedTokenAddressSync(m.mint, treasury.publicKey, false, m.programId);
  const t = new Transaction();
  t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 12000 + items.length * 38000 }), priority());
  for (const it of items) {
    const owner = new PublicKey(it.wallet); const to = getAssociatedTokenAddressSync(m.mint, owner, false, m.programId);
    t.add(createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, to, owner, m.mint, m.programId));
    t.add(createTransferCheckedInstruction(from, m.mint, to, treasury.publicKey, BigInt(it.amount), m.decimals, [], m.programId));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  t.recentBlockhash = blockhash; t.feePayer = treasury.publicKey; t.sign(treasury);
  const raw = t.serialize();
  return { raw, signature: bs58.encode(t.signature), lastValidBlockHeight };
}
export function fitsInTx(n) { return n <= 7; }

// e.rejected = the RPC answered with an error, so the tx was not forwarded and can be safely retried.
// Anything else (timeout, dropped connection) means we don't know yet: keep it 'sent' and let reconcile decide.
export async function send(raw) {
  try { return await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }); }
  catch (e) { if (e instanceof SendTransactionError || e?.name === 'SendTransactionError') e.rejected = true; throw e; }
}
// wait until confirmed, or until the blockhash expires (then it can never land)
export async function waitFor(signature, lastValidBlockHeight, raw) {
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.err) return { ok: false, err: JSON.stringify(st.err) };
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return { ok: true };
    const h = await conn.getBlockHeight('confirmed');
    if (h > lastValidBlockHeight + EXPIRY_MARGIN) { if (!(await landed(signature))) return { ok: false, expired: true }; continue; }
    if (raw) conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((s) => setTimeout(s, 2500));
  }
}
// a tx is only called dead well past its blockhash expiry, and after a second look (load-balanced RPCs can lag)
const EXPIRY_MARGIN = 150;
async function landed(signature) {
  await new Promise((r) => setTimeout(r, 1500));
  const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  return !!st && !st.err;
}
export async function status(signature, lastValidBlockHeight) {
  const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (st?.err) return 'failed';
  if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return 'confirmed';
  if (st) return 'pending';
  const h = await conn.getBlockHeight('confirmed');
  if (h <= lastValidBlockHeight + EXPIRY_MARGIN) return 'pending';
  return (await landed(signature)) ? 'pending' : 'expired';
}

// sign + send a serialized v0 transaction built by someone else (PumpPortal)
export async function signAndSend(bytes) {
  const vtx = VersionedTransaction.deserialize(bytes);
  const { lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  vtx.sign([treasury]); const raw = vtx.serialize(); const sig = bs58.encode(vtx.signatures[0]);
  await send(raw); const r = await waitFor(sig, lastValidBlockHeight + 10, raw);
  if (!r.ok) throw new Error(`tx ${sig} failed: ${r.err || 'expired'}`);
  return sig;
}

// unsigned transfer INTO the treasury, for the admin page's "Fund" button (the admin's wallet signs it)
export async function buildFundTx(fromAddr, asset, amount) {
  const from = new PublicKey(fromAddr); const t = new Transaction(); t.add(priority());
  if (asset === 'SOL') {
    t.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: treasury.publicKey, lamports: Math.round(Number(amount) * LAMPORTS_PER_SOL) }));
  } else {
    const m = await mintInfo(); if (!m) throw new Error('PFP_MINT not set');
    const src = getAssociatedTokenAddressSync(m.mint, from, false, m.programId); const dst = getAssociatedTokenAddressSync(m.mint, treasury.publicKey, false, m.programId);
    t.add(createAssociatedTokenAccountIdempotentInstruction(from, dst, treasury.publicKey, m.mint, m.programId));
    t.add(createTransferCheckedInstruction(src, m.mint, dst, from, BigInt(toUnits(amount, m.decimals)), m.decimals, [], m.programId));
  }
  const { blockhash } = await conn.getLatestBlockhash('confirmed'); t.recentBlockhash = blockhash; t.feePayer = from;
  return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

// withdraw from the treasury to an admin wallet
export async function withdraw(toAddr, asset, amount) {
  const to = new PublicKey(toAddr); const t = new Transaction(); t.add(priority());
  if (asset === 'SOL') t.add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports: Math.round(Number(amount) * LAMPORTS_PER_SOL) }));
  else {
    const m = await mintInfo(); const src = getAssociatedTokenAddressSync(m.mint, treasury.publicKey, false, m.programId); const dst = getAssociatedTokenAddressSync(m.mint, to, false, m.programId);
    t.add(createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, dst, to, m.mint, m.programId));
    t.add(createTransferCheckedInstruction(src, m.mint, dst, treasury.publicKey, BigInt(toUnits(amount, m.decimals)), m.decimals, [], m.programId));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'); t.recentBlockhash = blockhash; t.feePayer = treasury.publicKey; t.sign(treasury);
  const raw = t.serialize(); const sig = bs58.encode(t.signature); await send(raw);
  const r = await waitFor(sig, lastValidBlockHeight, raw); if (!r.ok) throw new Error('withdraw failed: ' + (r.err || 'expired'));
  return sig;
}
