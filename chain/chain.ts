// Night Watch chain service
// Watches Spacetime for signed moments (claims, verified fixes, handoffs)
// and writes a fingerprint of each one to Solana devnet, signed by the techs involved.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { DbConnection } from '../src/module_bindings/index.ts';

// ─── config ───────────────────────────────────────────────
try {
  process.loadEnvFile(new URL('../.env.local', import.meta.url));
} catch {
  /* fine if missing */
}
const HOST = process.env.SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? '';
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const WALLETS_FILE = new URL('./wallets.json', import.meta.url);
const TOKEN_FILE = new URL('./.spacetime-token', import.meta.url);

if (!DB_NAME) throw new Error('SPACETIMEDB_DB_NAME missing (looked in ../.env.local)');

// ─── wallets (kept on this machine only, never committed) ──
// payer = company wallet that pays the tiny devnet fee.
// techs = one keypair per tech, keyed by name so a demo reset keeps the same wallet.
type WalletStore = { payer: string; techs: Record<string, string> };
const toB64 = (k: Keypair) => Buffer.from(k.secretKey).toString('base64');
const fromB64 = (s: string) => Keypair.fromSecretKey(Buffer.from(s, 'base64'));

const store: WalletStore = existsSync(WALLETS_FILE)
  ? JSON.parse(readFileSync(WALLETS_FILE, 'utf8'))
  : { payer: toB64(Keypair.generate()), techs: {} };
const saveStore = () => writeFileSync(WALLETS_FILE, JSON.stringify(store, null, 2));
saveStore();

const payer = fromB64(store.payer);
function walletFor(techName: string): Keypair {
  if (!store.techs[techName]) {
    store.techs[techName] = toB64(Keypair.generate());
    saveStore();
  }
  return fromB64(store.techs[techName]);
}

// ─── solana ───────────────────────────────────────────────
// We handle rate limits ourselves (one record at a time + backoff), so turn off the library's
// own retry storm, which is what got us "429 Too Many Requests" and a crash.
const solana = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true });

// Never let one failed network call take the whole service down.
process.on('unhandledRejection', e => console.error('⚠️  Network hiccup (will retry):', (e as Error)?.message ?? e));
process.on('uncaughtException', e => console.error('⚠️  Unexpected error (still running):', e.message));

async function ensureFunded() {
  let bal = 0;
  try {
    bal = await solana.getBalance(payer.publicKey);
  } catch (e) {
    console.log(`⚠️  Can't reach Solana devnet (${(e as Error).message}). Records will retry every 20s.`);
    return;
  }
  console.log(`💰 Company wallet ${payer.publicKey.toBase58()} has ${(bal / LAMPORTS_PER_SOL).toFixed(3)} devnet SOL`);
  if (bal >= 0.05 * LAMPORTS_PER_SOL) return;
  try {
    console.log('   Requesting a free devnet airdrop…');
    const sig = await solana.requestAirdrop(payer.publicKey, 1 * LAMPORTS_PER_SOL);
    await solana.confirmTransaction(sig, 'confirmed');
    console.log('   ✅ Airdrop received');
  } catch {
    console.log('   ⚠️  Airdrop was rate-limited. Get free devnet SOL here, then restart:');
    console.log(`      https://faucet.solana.com  (address: ${payer.publicKey.toBase58()})`);
  }
}

// ─── spacetime ────────────────────────────────────────────
function safe(p: unknown) {
  if (p && typeof (p as Promise<unknown>).catch === 'function') {
    (p as Promise<unknown>).catch(e => {
      const msg = (e as Error).message;
      console.error(`❌ Spacetime call failed: ${msg}${msg.includes('no such reducer') ? ' (backend not republished? run: spacetime publish -y)' : ''}`);
    });
  }
}

function fingerprint(rec: {
  id: bigint; kind: string; refId: bigint; techIds: bigint[]; summary: string;
  createdAt: { microsSinceUnixEpoch: bigint };
}) {
  const canonical = JSON.stringify({
    id: rec.id.toString(),
    kind: rec.kind,
    refId: rec.refId.toString(),
    techIds: rec.techIds.map(String),
    summary: rec.summary,
    at: rec.createdAt.microsSinceUnixEpoch.toString(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// One-at-a-time queue: devnet's free server rate-limits bursts, so records go out in order with a short gap.
const queue: bigint[] = [];
let draining = false;
let backoffMs = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function enqueue(conn: DbConnection, recordId: bigint) {
  const rec = conn.db.chainRecord.id.find(recordId);
  if (!rec || rec.txSignature || queue.includes(recordId)) return;
  queue.push(recordId);
  void drain(conn);
}

async function drain(conn: DbConnection) {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      if (backoffMs) {
        console.log(`⏸️  Solana is rate-limiting us, waiting ${Math.round(backoffMs / 1000)}s (${queue.length} record(s) queued)…`);
        await sleep(backoffMs);
      }
      const id = queue[0];
      const ok = await writeRecord(conn, id);
      if (ok === 'rate-limited') {
        backoffMs = Math.min(60_000, Math.max(5_000, backoffMs * 2));
        continue; // keep it at the front and try again after the wait
      }
      queue.shift();
      backoffMs = 0;
      await sleep(1_200); // be polite to the free devnet server
    }
  } finally {
    draining = false;
  }
}

async function writeRecord(conn: DbConnection, recordId: bigint): Promise<'ok' | 'skip' | 'failed' | 'rate-limited'> {
  const rec = conn.db.chainRecord.id.find(recordId);
  if (!rec || rec.txSignature) return 'skip';
  try {
    // The techs involved co-sign the memo, so the signature on-chain proves who it was.
    const signers = rec.techIds
      .map(id => conn.db.tech.id.find(id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map(x => walletFor(x.name));

    const memo = JSON.stringify({ app: 'night-watch', kind: rec.kind, ref: rec.refId.toString(), sha256: fingerprint(rec) });
    const ix = new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: signers.map(k => ({ pubkey: k.publicKey, isSigner: true, isWritable: false })),
      data: Buffer.from(memo, 'utf8'),
    });
    const sig = await sendAndConfirmTransaction(solana, new Transaction().add(ix), [payer, ...signers]);
    safe(conn.reducers.setTxSignature({ recordId, txSignature: sig }));
    console.log(`⛓️  ${rec.kind} #${recordId} on-chain → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    return 'ok';
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes('429') || /too many requests/i.test(msg)) return 'rate-limited';
    if (/prior credit|insufficient/i.test(msg)) {
      console.error(`❌ Company wallet is out of devnet SOL. Add some at https://faucet.solana.com (address: ${payer.publicKey.toBase58()})`);
      return 'rate-limited'; // wait and retry instead of hammering
    }
    console.error(`❌ Could not write record #${recordId}: ${msg.split('\n')[0]} (will retry)`);
    return 'failed';
  }
}

function retryPending(conn: DbConnection) {
  for (const rec of conn.db.chainRecord.iter()) if (!rec.txSignature) enqueue(conn, rec.id);
}

const walletSent = new Map<bigint, string>();
function syncWallets(conn: DbConnection) {
  for (const t of conn.db.tech.iter()) {
    const pk = walletFor(t.name).publicKey.toBase58();
    if (t.walletPubkey !== pk && walletSent.get(t.id) !== pk) {
      walletSent.set(t.id, pk);
      safe(conn.reducers.setTechWallet({ techId: t.id, walletPubkey: pk }));
      console.log(`🔑 ${t.name} → wallet ${pk}`);
    }
  }
}


await ensureFunded();

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : undefined)
  .onConnect((conn, _identity, token) => {
    writeFileSync(TOKEN_FILE, token);
    console.log(`🔌 Connected to Spacetime database ${DB_NAME}`);
    conn.db.chainRecord.onInsert((_ctx, rec) => enqueue(conn, rec.id));
    conn.db.tech.onInsert(() => syncWallets(conn));
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        syncWallets(conn);
        retryPending(conn);
        console.log('👀 Watching for claims, verified fixes and handoffs…');
      })
      .subscribe(['SELECT * FROM chain_record', 'SELECT * FROM tech']);
    // Safety net: retry anything that failed (e.g. a devnet hiccup) every 20 seconds.
    setInterval(() => retryPending(conn), 20_000);
  })
  .onConnectError((_ctx, err) => console.error('Spacetime connection error:', err))
  .onDisconnect(() => console.log('Disconnected from Spacetime'))
  .build();
