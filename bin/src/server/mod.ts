import { Hono } from "hono";
import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import {
  credentialToAddress,
  Data,
  Lucid,
  Network,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Koios } from "@lucid-evolution/provider";

import {
  eventChainValidator,
  ECT_UNIT,
  KOIOS_URL,
  NETWORK,
  ORACLE_ADDRESS,
  ORACLE_VKH,
  TREASURY_ADDRESS,
  FEE_BPS,
  REFUND_GRACE_MS,
} from "./contract.ts";
import { verifyCip30Signature } from "./cip30-auth.ts";
import {
  BetDatum,
  EventDatumSchema,
  EventRedeemerSchema,
  PayoutDatum,
  ResolutionDatum,
} from "./schema.ts";
import { notify } from "./discord.ts";

// ── Markets data (persisted to disk) ─────────────────────────────────────────

const MARKETS_PATH = new URL("../../data/markets.json", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1");

type Market = {
  id: string;
  title: string;
  category: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  deadline: number;          // market close time (POSIX ms) — no more bets after
  status: "open" | "resolved" | "refunded";
  resolutionUtxoRef: string | null;
  published?: boolean; // if false/missing after migration: visible only in admin
  hidden?: boolean;    // admin-only flag: hide from admin Open/Resolved view
  pendingResolveTxHash?: string; // resolve tx submitted but not yet confirmed (cleared by mark-resolved)
  // Wall-clock (POSIX ms) when pendingResolveTxHash was set. Used by the sweep
  // to expire a pending-resolve flag when the tx never confirms (dropped from
  // mempool, Phase-2 rejection, bad hash submitted via /pending-resolve).
  // Without this, L4 would permanently block force-refund for the market.
  // Missing field on old markets means "no age known" — sweep treats as fresh
  // and skips expiry, preserving prior behaviour.
  pendingResolveSetAt?: number;
  pendingRefunded?: boolean;     // force-refund submitted, awaiting Koios catch-up for mark-refunded (cleared by mark-refunded)
  // Snapshot captured when admin fires pending-refunded, used to populate the
  // Discord announce on the successful mark-refunded flip. Cleared alongside
  // pendingRefunded.
  pendingRefundedSummary?: {
    betCount: number;
    totalEct: number; // base units (1 ECT = 1_000_000)
  };
  // Snapshot of resolution totals captured when the oracle submits the
  // resolve tx. Used by mark-resolved to post the Discord announcement with
  // accurate pool numbers, even when the retry path (no body data) succeeds.
  // Cleared alongside pendingResolveTxHash once the flip lands.
  pendingResolveSummary?: {
    winnerSide: "Yes" | "No";
    totalYes: number;   // ECT base units (1 ECT = 1_000_000)
    totalNo: number;
    distributionPool: number;
    fee: number;
  };
};

async function loadMarkets(): Promise<Market[]> {
  const raw = JSON.parse(await Deno.readTextFile(MARKETS_PATH));
  // Backward compat: default published=true.
  return raw.map((m: Market) => ({
    ...m,
    published: m.published ?? true,
  }));
}

// ── Mutex ────────────────────────────────────────────────────────────────────
// Simple promise-chain mutex. Unlike the previous ad-hoc chaining scheme, this
// one explicitly serialises each runner and doesn't allow re-entrant calls to
// deadlock or reorder: `saveMarkets` (below) is now a RAW write that never
// re-enters the mutex, and `withMarketsLock` holds the lock across the entire
// read-modify-write.
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain off the tail regardless of whether the previous task succeeded,
    // so one failing handler can't poison every subsequent write.
    const runNext = this.tail.then(() => fn(), () => fn());
    this.tail = runNext.then(() => {}, () => {});
    return runNext;
  }
}
const marketsMutex = new Mutex();

// Atomic write with fsync + retry. On Windows `Deno.rename` can hit
// ERROR_SHARING_VIOLATION when AV / indexers / backup tools briefly hold the
// destination open — retry a few times with a tiny backoff. `file.sync()` on
// the tmp handle forces the data to disk before rename, so a power loss
// can't leave us with a zero-byte file after the rename completes.
async function atomicWriteJson(path: string, body: string): Promise<void> {
  const tmpPath = path + ".tmp";
  const file = await Deno.open(tmpPath, {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    await file.write(new TextEncoder().encode(body));
    await file.sync(); // fsync → durable on disk before rename
  } finally {
    file.close();
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await Deno.rename(tmpPath, path);
      return;
    } catch (e) {
      lastErr = e;
      // Back off 50ms, 100ms, 200ms. Transient AV / search-indexer locks on
      // NTFS typically clear within a few hundred ms.
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("atomicWriteJson: rename failed");
}

// Raw save — MUST be called from inside `withMarketsLock`. Doing otherwise
// re-introduces the lost-update race the mutex exists to prevent.
async function saveMarkets(markets: Market[]): Promise<void> {
  const body = JSON.stringify(markets, null, 2);
  await atomicWriteJson(MARKETS_PATH, body);
}

// Run a read-modify-write against markets.json under the mutex so two
// concurrent admin edits can't race on load → mutate → save.
function withMarketsLock<T>(
  fn: (markets: Market[]) => Promise<T> | T,
): Promise<T> {
  return marketsMutex.run(async () => {
    const markets = await loadMarkets();
    return await fn(markets);
  });
}

// ── Lucid / contract setup ────────────────────────────────────────────────────

// KOIOS_URL now comes from env via contract.ts.

// Bind address — loopback by default. Moved up from the startup block so the
// prod-mode auto-detection below can key off it.
const HOSTNAME = Deno.env.get("EVENTCHAIN_HOST") ?? "127.0.0.1";

// Prod flag — enables Secure cookies, generic error messages, disables debug
// routes. Auto-detects from the bind address so deploying behind a VPS without
// explicitly setting EVENTCHAIN_PROD doesn't silently leak stack traces to the
// internet. Override logic:
//   • EVENTCHAIN_PROD=1              → always prod (force — useful for testing
//                                      prod behavior on localhost)
//   • EVENTCHAIN_PROD=0              → always dev  (force — escape hatch for
//                                      LAN testing on a non-loopback bind)
//   • unset + loopback host          → dev  (default local run.bat behavior)
//   • unset + non-loopback host      → prod (the footgun-prevention case)
const _isLoopbackBind = HOSTNAME === "127.0.0.1" ||
  HOSTNAME === "localhost" ||
  HOSTNAME === "::1";
const _prodEnv = Deno.env.get("EVENTCHAIN_PROD");
const IS_PROD = _prodEnv === "1" || (_prodEnv !== "0" && !_isLoopbackBind);

// Cache protocol parameters — they change once per epoch (~5 days).
// Koios rate-limits free tier hard, so refetching on every request triggers 429.
let _pparamsCache: { data: unknown; expiresAt: number } | null = null;
let _pparamsInflight: Promise<unknown> | null = null;
const PPARAMS_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Backoff with jitter. Base delays: 500, 1000, 2000, 4000, 8000 (ms).
// Each attempt adds up-to-250ms jitter to avoid thundering-herd retries
// from multiple concurrent bettors hitting the same rate-limit window.
function backoffDelay(attempt: number): number {
  const base = 500 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function fetchPParamsWithRetry(
  fn: () => Promise<unknown>,
): Promise<unknown> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("429") && attempt < 5) {
        await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

async function getLucid(): Promise<Lucid> {
  const koios = new Koios(KOIOS_URL);
  const originalGetPP = koios.getProtocolParameters.bind(koios);
  koios.getProtocolParameters = async () => {
    const now = Date.now();
    if (_pparamsCache && _pparamsCache.expiresAt > now) {
      return _pparamsCache.data as Awaited<ReturnType<typeof originalGetPP>>;
    }
    // Coalesce concurrent callers onto a single in-flight request.
    if (!_pparamsInflight) {
      _pparamsInflight = fetchPParamsWithRetry(originalGetPP)
        .then((data) => {
          _pparamsCache = { data, expiresAt: Date.now() + PPARAMS_TTL_MS };
          return data;
        })
        .finally(() => {
          _pparamsInflight = null;
        });
    }
    return (await _pparamsInflight) as Awaited<ReturnType<typeof originalGetPP>>;
  };
  const lucid = await Lucid(koios, NETWORK);

  // Patch evaluateTx to call Koios Ogmios directly with empty additionalUtxo.
  // Both UTxOs we spend are already on-chain so Ogmios can find them itself.
  // Lucid's default call sends them as additionalUtxo which causes a 400.
  const provider = (lucid as unknown as { config: () => { provider: { evaluateTx: unknown } } }).config().provider;
  (provider as { evaluateTx: (tx: string) => Promise<unknown[]> }).evaluateTx = async (tx: string) => {
    const resp = await fetch(`${KOIOS_URL}/ogmios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "evaluateTransaction",
        params: { transaction: { cbor: tx }, additionalUtxo: [] },
        id: null,
      }),
    });
    const raw = await resp.json();
    console.log("[Ogmios eval]", JSON.stringify(raw));
    if (!resp.ok || "error" in raw) {
      notify.error({
        key: "koios-ogmios-eval",
        title: "Ogmios evaluateTransaction failed",
        detail: `HTTP ${resp.status}: ${JSON.stringify(raw).slice(0, 500)}`,
      });
      throw new Error(JSON.stringify(raw));
    }
    // Map Ogmios result → Lucid's EvalRedeemer format
    return (raw.result as Array<{
      validator: { purpose: string; index: number };
      budget: { memory: number; cpu: number };
    }>).map((item) => ({
      ex_units: { mem: item.budget.memory, steps: item.budget.cpu },
      redeemer_index: item.validator.index,
      redeemer_tag: item.validator.purpose,
    }));
  };

  return lucid;
}

function contractAddress(lucid: Lucid): string {
  return validatorToAddress(NETWORK, eventChainValidator);
}

// Retry wrapper for Koios POST requests — free tier rate-limits aggressively,
// so we back off on 429 (0.5s → 1s → 2s → 4s → 8s, max 5 attempts).
async function koiosPost(path: string, body: unknown): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`${KOIOS_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.status !== 429) {
        // Surface non-2xx (but not rate-limit retries) to the ops channel.
        // Keyed by path so every endpoint gets its own cooldown — a single
        // /address_utxos outage won't silence other Koios issues.
        if (!resp.ok) {
          notify.error({
            key: `koios-${path}`,
            title: `Koios ${path} returned ${resp.status}`,
            detail: `HTTP ${resp.status} on POST ${path}`,
          });
        }
        return resp;
      }
      const d = backoffDelay(attempt);
      console.log(`Koios 429 on ${path}, retry ${attempt + 1}/5 in ${d}ms`);
      await new Promise((r) => setTimeout(r, d));
    } catch (e) {
      // Network-level failure (DNS, timeout, TLS). Alert on final attempt
      // only — transient blips mid-retry aren't worth waking up for.
      if (attempt === 4) {
        notify.error({
          key: `koios-${path}-net`,
          title: `Koios ${path} network error`,
          detail: (e as Error)?.message ?? String(e),
        });
      }
      throw e;
    }
  }
  // Final attempt — return whatever we get (caller will handle !resp.ok)
  const finalResp = await fetch(`${KOIOS_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!finalResp.ok) {
    notify.error({
      key: `koios-${path}`,
      title: `Koios ${path} still failing after retries`,
      detail: `HTTP ${finalResp.status} after 5 attempts`,
    });
  }
  return finalResp;
}

// Fetch UTxOs at one or more addresses via Koios (returns Lucid UTxO objects).
// Koios address_utxos accepts a list — batch all wallet addresses in one call.
async function fetchUtxos(addresses: string | string[]): Promise<UTxO[]> {
  const addrList = Array.isArray(addresses) ? addresses : [addresses];
  const resp = await koiosPost("/address_utxos", {
    _addresses: addrList,
    _extended: true,
  });
  if (!resp.ok) throw new Error(`Koios address_utxos failed: ${resp.status}`);
  const rows = await resp.json();
  return rows.map((row: {
    tx_hash: string;
    tx_index: number;
    value: string;
    asset_list: Array<{ policy_id: string; asset_name: string; quantity: string }>;
    inline_datum: { bytes: string; value: unknown } | null;
    datum_hash: string | null;
    address: string;
  }) => {
    const assets: Record<string, bigint> = { lovelace: BigInt(row.value) };
    for (const a of row.asset_list ?? []) {
      assets[a.policy_id + a.asset_name] = BigInt(a.quantity);
    }
    const inlineDatum = row.inline_datum?.bytes ?? null;
    return {
      txHash: row.tx_hash,
      outputIndex: row.tx_index,
      assets,
      address: row.address,
      // If inline datum is present, clear datumHash — Lucid uses datumHash to decide
      // whether to look up the datum separately vs read it inline from the UTxO.
      datumHash: inlineDatum ? null : (row.datum_hash ?? null),
      datum: inlineDatum,
      scriptRef: null,
    } satisfies UTxO;
  });
}

// Fetch a single UTxO by txHash#index via Koios /utxo_info (supports inline datums)
async function fetchUtxoByRef(ref: string): Promise<UTxO> {
  const [txHash, idx] = ref.split("#");
  const resp = await koiosPost("/utxo_info", {
    _utxo_refs: [`${txHash}#${idx}`],
    _extended: true,
  });
  if (!resp.ok) throw new Error(`Koios utxo_info failed: ${resp.status}`);
  const rows = await resp.json();
  const row = rows[0];
  if (!row) throw new Error(`UTxO ${ref} not found`);
  const assets: Record<string, bigint> = { lovelace: BigInt(row.value) };
  for (const a of row.asset_list ?? []) {
    assets[a.policy_id + a.asset_name] = BigInt(a.quantity);
  }
  const inlineDatum = row.inline_datum?.bytes ?? null;
  return {
    txHash,
    outputIndex: Number(idx),
    assets,
    address: row.address,
    datumHash: inlineDatum ? null : (row.datum_hash ?? null),
    datum: inlineDatum,
    scriptRef: null,
  };
}

// ── Wallet UTxO helper ────────────────────────────────────────────────────────

// Serialised UTxO sent from the browser (assets stored as strings to survive JSON)
type SerializedUTxO = {
  txHash: string;
  outputIndex: number;
  assets: Record<string, string>;
  address: string;
  datum: string | null;
  datumHash: string | null;
};

// Convert browser-decoded UTxOs → Lucid UTxOs (bigint assets)
function deserializeUtxos(raw: SerializedUTxO[]): UTxO[] {
  return raw.map((u) => ({
    txHash: u.txHash,
    outputIndex: u.outputIndex,
    assets: Object.fromEntries(
      Object.entries(u.assets).map(([k, v]) => [k, BigInt(v)]),
    ),
    address: u.address,
    datum: u.datum,
    datumHash: u.datumHash,
    scriptRef: null,
  }));
}

// Resolve wallet UTxOs: prefer browser-provided list, fall back to Koios
async function resolveWalletUtxos(
  walletUtxos: SerializedUTxO[] | undefined,
  fallbackAddresses: string[],
): Promise<UTxO[]> {
  if (walletUtxos?.length) return deserializeUtxos(walletUtxos);
  return await fetchUtxos(fallbackAddresses);
}

// ── Encode datum / redeemer helpers ──────────────────────────────────────────

function encodeBetDatum(bet: BetDatum): string {
  return Data.to({ Bet: [bet] }, EventDatumSchema);
}

function encodeResolutionDatum(res: ResolutionDatum): string {
  return Data.to({ Resolution: [res] }, EventDatumSchema);
}

function encodePayoutDatum(pay: PayoutDatum): string {
  return Data.to({ Payout: [pay] }, EventDatumSchema);
}

// ── Admin auth (wallet-signature challenge → session cookie) ─────────────────

// Challenges: nonce → expiry (ms since epoch). Single-use; cleared on verify.
const challenges = new Map<string, number>();
// Sessions: token → expiry (ms since epoch). HttpOnly cookie.
const sessions = new Map<string, number>();

const CHALLENGE_TTL_MS = 60_000;         // 60 s to sign after requesting
const SESSION_TTL_MS = 15 * 60_000;      // 15 min admin session

// Hard caps — without these the challenge endpoint is unauthenticated and
// unbounded. A sustained request flood OOMs the server in minutes.
// At 1 req/s per attacker, 60s TTL → ≤60 entries; the cap is set generously
// to tolerate legitimate bursts while still bounding RAM. When at the cap
// the oldest entry is evicted (insertion-ordered Map gives LRU-by-arrival).
const MAX_CHALLENGES = 1000;
const MAX_SESSIONS = 200;

// L5: per-IP challenge bookkeeping. Without this, a flood from a single IP
// can evict legitimate pending challenges from other admins by pushing the
// global map past MAX_CHALLENGES. We now cap per-IP and reject early, so an
// attacker's own nonces are what get refused rather than someone else's.
const challengeIps = new Map<string, string>();      // nonce → ip
const perIpChallengeCount = new Map<string, number>(); // ip → live nonce count
const MAX_CHALLENGES_PER_IP = 20;

function trackChallengeForIp(nonce: string, ip: string): void {
  challengeIps.set(nonce, ip);
  perIpChallengeCount.set(ip, (perIpChallengeCount.get(ip) ?? 0) + 1);
}
function untrackChallenge(nonce: string): void {
  const ip = challengeIps.get(nonce);
  if (ip === undefined) return;
  challengeIps.delete(nonce);
  const n = (perIpChallengeCount.get(ip) ?? 1) - 1;
  if (n <= 0) perIpChallengeCount.delete(ip);
  else perIpChallengeCount.set(ip, n);
}

function newToken(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [k, t] of challenges) {
    if (t < now) {
      challenges.delete(k);
      untrackChallenge(k);
    }
  }
  for (const [k, t] of sessions) if (t < now) sessions.delete(k);
}

// Insert into a bounded Map, evicting the oldest entry (insertion order)
// when at capacity. Prevents unbounded growth under flood.
function boundedSet<K, V>(m: Map<K, V>, k: K, v: V, cap: number): void {
  if (m.size >= cap && !m.has(k)) {
    const first = m.keys().next();
    if (!first.done) m.delete(first.value);
  }
  m.set(k, v);
}

// ── Per-IP rate limiter (token bucket, in-memory) ────────────────────────────
// Bounds unauth'd endpoints (`/api/admin/auth/challenge`, public GETs,
// bet-scans) so a single IP can't exhaust the server. Bucket state itself is
// capped to MAX_RATE_BUCKETS LRU entries so the limiter can't be used to
// OOM the server.
type Bucket = { tokens: number; last: number };
const rateBuckets = new Map<string, Bucket>();
const MAX_RATE_BUCKETS = 10_000;

// deno-lint-ignore no-explicit-any
function clientIp(c: any): string {
  const peer = c.env?.remoteAddr?.hostname
    ? String(c.env.remoteAddr.hostname)
    : null;
  // L1: only honour X-Forwarded-For when the socket peer is a pre-declared
  // trusted proxy. Without the allowlist, an attacker on a directly-exposed
  // server could set `X-Forwarded-For: <victim-ip>` and bypass per-IP rate
  // limits + the per-IP challenge cap trivially. Requiring both
  // EVENTCHAIN_TRUST_XFF=1 AND a matching peer forces the operator to
  // explicitly acknowledge the proxy topology.
  if (Deno.env.get("EVENTCHAIN_TRUST_XFF") === "1") {
    const trustedProxy = Deno.env.get("EVENTCHAIN_TRUSTED_PROXY_IP");
    if (trustedProxy && peer === trustedProxy) {
      const xff = c.req?.raw?.headers?.get?.("X-Forwarded-For");
      if (xff) {
        const first = xff.split(",")[0].trim();
        if (first) return first;
      }
    }
    // Fall through to peer on misconfiguration (flag set but no trusted IP,
    // or peer mismatch, or missing header) — safer to rate-limit the peer
    // than to silently accept spoofed identities.
  }
  if (peer) return peer;
  // L2: fail closed rather than lumping every missing-remoteAddr request
  // into a single "unknown" bucket that would silently disable rate
  // limiting. Under Deno.serve this never fires; it only triggers if a
  // future transport drops remoteAddr, in which case a 500 is safer than
  // unbounded unauth'd traffic.
  throw new Error("clientIp: no remoteAddr available");
}

function rateLimit(
  ip: string,
  capacity: number,
  refillPerSec: number,
): boolean {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b) {
    b = { tokens: capacity, last: now };
    boundedSet(rateBuckets, ip, b, MAX_RATE_BUCKETS);
  } else {
    // Move-to-end for LRU: re-insert refreshes insertion order.
    rateBuckets.delete(ip);
    rateBuckets.set(ip, b);
  }
  const elapsedSec = (now - b.last) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get("Cookie") ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    // First-wins on duplicate names (RFC 6265 §5.4 recommendation). Prevents
    // a subdomain-set or otherwise-injected second `admin_session=…` cookie
    // from overriding the legitimate one just because it appears later in
    // the Cookie header. Neutralised in practice by SameSite=Strict and the
    // signed-nonce requirement to mint a valid session, but this closes the
    // theoretical gap cleanly.
    if (k && !(k in out)) out[k] = v.join("=");
  }
  return out;
}

function authAdmin(req: Request): boolean {
  sweepExpired();
  const token = parseCookies(req)["admin_session"];
  if (!token) return false;
  const exp = sessions.get(token);
  return !!exp && exp > Date.now();
}

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();

// ── Security headers (applied to every response) ─────────────────────────────
// CSP pinned to self — blocks CDN scripts, inline eval, data: iframes, etc.
// script-src is strict ('self' only): all JS lives in external files
// (app.js, admin-panel.js, wallet-shared.js, vendor/cborg.js). No inline
// <script> or onclick= handlers — audit P0-CSP.
// 'unsafe-inline' on style-src stays: inline <style> blocks hold static
// theme CSS and Tailwind utility classes can produce inline style="" on
// width bars. Style-based XSS is dramatically less exploitable than script.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
});

// ── Rate limits ──────────────────────────────────────────────────────────────
// Global cheap-request limit: 60 rps burst, refill 30 rps. Bounds any single
// IP's impact on CPU/Koios quota. Applied to all routes.
app.use("*", async (c, next) => {
  const ip = clientIp(c);
  if (!rateLimit("g:" + ip, 60, 30)) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
});

// Stricter limit for expensive routes that scan contract UTxOs, build txs,
// or allocate new challenge/session entries. 10 burst / 2 rps steady.
async function strictRateLimit(
  // deno-lint-ignore no-explicit-any
  c: any,
  // deno-lint-ignore no-explicit-any
  next: any,
) {
  const ip = clientIp(c);
  if (!rateLimit("s:" + ip, 10, 2)) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
}
app.use("/api/admin/auth/*", strictRateLimit);
app.use("/api/bets/*", strictRateLimit);
app.use("/api/tx/*", strictRateLimit);

// ── Body-size limits (audit P0-2) ────────────────────────────────────────────
// Without a cap Hono buffers the entire POST body into memory before any
// route sees it. A buggy extension or runaway client posting a huge array
// (e.g. an inflated walletUtxos list) can stall the event loop or OOM the
// process. We apply two tiers, sized generously so legitimate traffic never
// trips them:
//
//   • Tx endpoints — /api/tx/* carry walletUtxos. A power user with ~1000
//     UTxOs lands around ~600 KB; we cap at 4 MB (~6× headroom).
//   • Everything else — admin JSON, auth, small edits. 32 KB is already
//     huge for what actually ships (titles, bech32 addresses, signatures).
//
// If Content-Length is missing (chunked transfer encoding), we refuse: none
// of our endpoints need streaming uploads, and without a declared length we
// can't cheaply pre-flight the size.
const BODY_LIMIT_TX = 4 * 1024 * 1024; // 4 MB
const BODY_LIMIT_DEFAULT = 32 * 1024;  // 32 KB

app.use("*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE") {
    return next();
  }
  const cap = c.req.path.startsWith("/api/tx/")
    ? BODY_LIMIT_TX
    : BODY_LIMIT_DEFAULT;
  // L1: first-line defence via Content-Length header (cheap early reject for
  // well-behaved clients). Header is advisory only — a malicious client can
  // understate it and stream more. The streaming read below enforces the cap
  // regardless of what the header claims.
  const cl = c.req.header("content-length");
  if (cl === undefined) {
    return c.json({ error: "Content-Length required" }, 411);
  }
  const n = Number(cl);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return c.json({ error: "Invalid Content-Length" }, 400);
  }
  if (n > cap) {
    return c.json({ error: `Request body too large (${n} > ${cap} bytes)` }, 413);
  }

  // L1: streaming enforcement. Read the body with a running total, abort the
  // moment we cross `cap`. Then rebuild the Request from the buffered bytes
  // and swap it in so downstream `c.req.json()` parses the verified buffer.
  const rawBody = c.req.raw.body;
  if (rawBody) {
    const reader = rawBody.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return c.json(
            { error: `Request body too large (>${cap} bytes)` },
            413,
          );
        }
        chunks.push(value);
      }
    } catch (e) {
      return c.json(
        { error: `Body read failed: ${(e as Error)?.message ?? "unknown"}` },
        400,
      );
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
    // Rebuild Request from verified bytes. Reset bodyCache so HonoRequest's
    // memoised parse helpers (json/text/arrayBuffer) consume the new body.
    // deno-lint-ignore no-explicit-any
    const honoReq = c.req as any;
    honoReq.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: buf,
    });
    honoReq.bodyCache = {};
  }
  await next();
});

// ── CSRF guard for state-changing admin routes ───────────────────────────────
// SameSite=Strict on the session cookie is the first line of defence; this
// explicit Origin/Referer check is belt-and-suspenders against CSRF via
// cross-origin POSTs from a compromised subdomain or embedded page.
function sameOrigin(req: Request): boolean {
  const url = new URL(req.url);
  const origin = req.headers.get("Origin");
  const referer = req.headers.get("Referer");
  const expected = `${url.protocol}//${url.host}`;
  if (origin && origin === expected) return true;
  if (referer && referer.startsWith(expected + "/")) return true;
  // Same-origin requests from same host sometimes omit Origin on GET, but
  // admin-state-changing routes below are POST/PATCH/DELETE — browsers
  // always send Origin for those. Treat missing Origin+Referer as a fail.
  return false;
}

app.use("/api/admin/*", async (c, next) => {
  const m = c.req.method;
  if (m === "POST" || m === "PATCH" || m === "DELETE" || m === "PUT") {
    if (!sameOrigin(c.req.raw)) {
      return c.json({ error: "Bad Origin" }, 403);
    }
  }
  await next();
});

app.use("/api/tx/*", async (c, next) => {
  // Same guard on tx-building endpoints — CSRF here could build bogus txs
  // using a victim's wallet signature flow.
  if (c.req.method === "POST" && !sameOrigin(c.req.raw)) {
    return c.json({ error: "Bad Origin" }, 403);
  }
  await next();
});

// Return JSON for all unhandled errors (prevents "Internal Server Error" text).
// In prod we never leak stack traces / Lucid internals / raw error bodies to
// the client; only a short correlation id + a generic message. The full error
// still lands in server logs.
app.onError((err, c) => {
  const errObj = err as unknown as Record<string, unknown>;
  const raw = err.message ?? JSON.stringify(err);

  // Always log full detail to the operator.
  console.error("[ERROR]", raw);
  if (err.stack) console.error("[ERROR stack]", err.stack);
  if (typeof errObj.Complete === "object") {
    console.error("[ERROR Complete inner]", JSON.stringify(errObj.Complete));
  }

  // Fire a Discord alert (MODLOG) for every 500. Dedupe key is the first
  // line of the message so the same Lucid/Koios failure mode doesn't spam
  // — distinct errors (different messages) still each get one post per
  // ERROR_COOLDOWN_MS window.
  const firstLine = raw.split("\n")[0].slice(0, 120);
  const path = (() => {
    try { return new URL(c.req.url).pathname; } catch { return "?"; }
  })();
  notify.error({
    key: `onError:${firstLine}`,
    title: `Unhandled error on ${c.req.method} ${path}`,
    detail: raw.slice(0, 800),
  });

  if (IS_PROD) {
    // Short correlation id so the user can tell us what they saw and we can
    // look it up in logs without exposing the underlying error shape.
    const cid = newToken(6);
    console.error(`[ERROR cid=${cid}]`);
    return c.json({ error: `Internal error (ref ${cid})` }, 500);
  }

  // Dev mode: keep the existing user-friendly unwrap for ergonomic debugging.
  let msg = raw;
  if (typeof errObj.Complete === "object") {
    const inner = errObj.Complete as Record<string, unknown>;
    const innerMsg = inner?.message ?? JSON.stringify(inner);
    msg = `Script/tx building failed: ${innerMsg}`;
  } else if (msg.includes("does not have enough funds")) {
    msg = "Wallet has insufficient funds — you need more ADA or $ECT$ tokens";
  } else if (msg.includes("reference scripts")) {
    msg = "Wallet UTxOs contain reference scripts and can't be used for fees";
  }
  return c.json({ error: msg }, 500);
});

// Public: clients need the contract address to verify tx outputs client-side
// before signing (audit P0-1). Returns just the address — no UTxO dump. MUST
// stay outside the !IS_PROD guard below; verifyTxOutput calls this on every
// wallet-sign path (bet / claim / claim-all / refund). If moved back inside,
// prod builds 404 this route and the whole app breaks at signing time.
app.get("/api/contract-address", async (c) => {
  const lucid = await getLucid();
  return c.json({ contractAddress: contractAddress(lucid) });
});

// Admin-only tx confirmation poll. Used by the force-refund batch loop so it
// can wait for actual chain confirmation (instead of a fixed 90s sleep) before
// submitting the next batch — avoids stale-input errors on congested epochs.
// Admin-gated because only admin flows need it and we don't want a public
// Koios proxy. Returns {confirmations} ≥ 0 (0 if not yet seen/mempool-only).
app.get("/api/admin/tx-status/:txHash", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const txHash = c.req.param("txHash");
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    return c.json({ error: "Invalid txHash" }, 400);
  }
  const resp = await koiosPost("/tx_status", { _tx_hashes: [txHash] });
  if (!resp.ok) return c.json({ error: `Koios ${resp.status}` }, 502);
  const rows = await resp.json().catch(() => []);
  const row = Array.isArray(rows)
    ? rows.find((r: { tx_hash?: string }) => r.tx_hash === txHash)
    : null;
  const confirmations = row ? Number(row.num_confirmations ?? 0) : 0;
  return c.json({ confirmations: Number.isFinite(confirmations) ? confirmations : 0 });
});

// ── Debug: dump wallet assets from Koios (dev only) ──────────────────────────
// GET /api/debug/wallet-assets?address=addr1q...
// Disabled in production — attack surface with no user-facing purpose.
if (!IS_PROD) {
  app.get("/api/debug/wallet-assets", async (c) => {
    if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
    const address = c.req.query("address");
    if (!address || !vkhFromAddress(address)) {
      return c.json({ error: "valid ?address= required" }, 400);
    }
    const utxos = await fetchUtxos(address);
    const totals: Record<string, string> = {};
    for (const u of utxos) {
      for (const [unit, qty] of Object.entries(u.assets)) {
        totals[unit] = ((BigInt(totals[unit] ?? 0) + qty)).toString();
      }
    }
    return c.json({ address, utxoCount: utxos.length, totals });
  });

  app.get("/api/debug/contract", async (c) => {
    if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
    const lucid = await getLucid();
    const addr = contractAddress(lucid);
    const utxos = await fetchUtxos(addr);
    return c.json({
      contractAddress: addr,
      utxoCount: utxos.length,
      utxos: utxos.map(u => ({
        ref: `${u.txHash}#${u.outputIndex}`,
        assets: Object.fromEntries(Object.entries(u.assets).map(([k, v]) => [k, v.toString()])),
        hasDatum: !!u.datum,
        datumBytes: u.datum,
      })),
    });
  });
}

// ── Admin: challenge / verify / logout ───────────────────────────────────────

app.post("/api/admin/auth/challenge", (c) => {
  sweepExpired();
  // L5: per-IP cap. Blocks a single attacker from burning through 1000
  // challenge slots and evicting legitimate pending logins. 20 × 60s TTL
  // is already well past any legitimate retry pattern.
  const ip = clientIp(c);
  if ((perIpChallengeCount.get(ip) ?? 0) >= MAX_CHALLENGES_PER_IP) {
    return c.json({ error: "Too many pending challenges" }, 429);
  }
  const nonce = newToken(16);
  // If boundedSet evicts an oldest entry, decrement its IP counter too.
  if (challenges.size >= MAX_CHALLENGES && !challenges.has(nonce)) {
    const first = challenges.keys().next();
    if (!first.done) untrackChallenge(first.value);
  }
  boundedSet(challenges, nonce, Date.now() + CHALLENGE_TTL_MS, MAX_CHALLENGES);
  trackChallengeForIp(nonce, ip);
  const payload = `EventChain admin login: ${nonce}`;
  return c.json({ nonce, payload });
});

app.post("/api/admin/auth/verify", async (c) => {
  const { nonce, signature, key } = await c.req.json();
  if (!nonce || !signature || !key) {
    return c.json({ error: "Missing fields" }, 400);
  }
  sweepExpired();
  const exp = challenges.get(nonce);
  if (!exp) return c.json({ error: "Unknown or expired nonce" }, 400);
  challenges.delete(nonce); // single-use
  untrackChallenge(nonce);

  const expectedPayload = `EventChain admin login: ${nonce}`;
  try {
    await verifyCip30Signature(signature, key, expectedPayload, ORACLE_VKH);
  } catch (e) {
    console.warn("[admin/verify] rejected:", (e as Error).message);
    return c.json({ error: "Signature invalid or wrong wallet" }, 401);
  }

  const token = newToken(32);
  boundedSet(sessions, token, Date.now() + SESSION_TTL_MS, MAX_SESSIONS);
  c.header(
    "Set-Cookie",
    `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/;${
      IS_PROD ? " Secure;" : ""
    } Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
  return c.json({ ok: true, expiresInSec: Math.floor(SESSION_TTL_MS / 1000) });
});

app.post("/api/admin/auth/logout", (c) => {
  const token = parseCookies(c.req.raw)["admin_session"];
  if (token) sessions.delete(token);
  c.header(
    "Set-Cookie",
    `admin_session=; HttpOnly; SameSite=Strict; Path=/;${
      IS_PROD ? " Secure;" : ""
    } Max-Age=0`,
  );
  return c.json({ ok: true });
});

app.get("/api/admin/auth/status", (c) => {
  return c.json({ authenticated: authAdmin(c.req.raw) });
});

// ── Volume derivation ────────────────────────────────────────────────────────
// Volume is NOT stored — it's computed on demand by scanning Bet UTxOs at the
// contract address. Cached briefly so the public markets page doesn't hammer
// Koios on every refresh.
const VOLUME_CACHE_TTL_MS = 15_000;
type PoolInfo = { yes: number; no: number };
let volumeCache: { at: number; byId: Map<string, PoolInfo> } | null = null;

async function computePoolsByMarketId(): Promise<Map<string, PoolInfo>> {
  if (volumeCache && Date.now() - volumeCache.at < VOLUME_CACHE_TTL_MS) {
    return volumeCache.byId;
  }
  const byId = new Map<string, PoolInfo>();
  try {
    const lucid = await getLucid();
    const utxos = await fetchUtxos(contractAddress(lucid));
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      try {
        const datum = Data.from(utxo.datum, EventDatumSchema);
        if ("Bet" in datum) {
          const bet = datum.Bet[0];
          const idHex = bet.market_id as string;
          const micro = bet.ect_amount as bigint;
          const display = Number(micro) / 1_000_000;
          const pool = byId.get(idHex) ?? { yes: 0, no: 0 };
          if (bet.side === "Yes") pool.yes += display;
          else pool.no += display;
          byId.set(idHex, pool);
        }
      } catch { /* skip malformed datums */ }
    }
  } catch (err) {
    // Koios hiccup — serve stale cache if we have one, else zero pools.
    if (volumeCache) return volumeCache.byId;
    console.error("computePoolsByMarketId failed:", err);
  }
  volumeCache = { at: Date.now(), byId };
  return byId;
}

function applyVolumes(markets: Market[], byId: Map<string, PoolInfo>): Market[] {
  return markets.map((m) => {
    const idHex = bytesToHex(new TextEncoder().encode(m.id));
    const pool = byId.get(idHex) ?? { yes: 0, no: 0 };
    const total = pool.yes + pool.no;
    // Implied probability from pool sizes. With zero stakes, fall back to
    // 50/50 (nothing to infer). Rounded to nearest integer — client only
    // displays whole-percent bars.
    const yesPrice = total === 0 ? 50 : Math.round((pool.yes / total) * 100);
    const noPrice = 100 - yesPrice;
    return { ...m, volume: total, yesPrice, noPrice };
  });
}

// Markets list (PUBLIC — only published markets)
app.get("/api/markets", async (c) => {
  const markets = await loadMarkets();
  const byId = await computePoolsByMarketId();
  return c.json(applyVolumes(markets.filter((m) => m.published && !m.hidden && m.status === "open"), byId));
});

// Resolved markets (PUBLIC — for the "Resolved" sidebar tab with TX links)
app.get("/api/markets/resolved", async (c) => {
  const markets = await loadMarkets();
  const byId = await computePoolsByMarketId();
  return c.json(applyVolumes(markets.filter((m) => m.published && !m.hidden && m.status === "resolved"), byId));
});

// Markets list (ADMIN — all markets, including drafts)
app.get("/api/admin/markets", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const markets = await loadMarkets();
  const byId = await computePoolsByMarketId();
  return c.json(applyVolumes(markets, byId));
});

// ── Admin: create market ─────────────────────────────────────────────────────
app.post("/api/admin/markets", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const { id, title, category, yesPrice, noPrice, deadline } = body;

  // Validation
  if (!id || typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
    return c.json({ error: "ID must be lowercase letters, digits, hyphens" }, 400);
  }
  // Mirror the on-chain cap (audit L4): validator rejects market_ids over
  // 64 bytes at Resolve. Catch it here so the failure happens at creation
  // instead of months later when resolving.
  if (id.length > 64) {
    return c.json({ error: "ID must be 64 characters or fewer" }, 400);
  }
  if (!title || typeof title !== "string" || title.length > 200) {
    return c.json({ error: "Title required (max 200 chars)" }, 400);
  }
  if (!category || typeof category !== "string") {
    return c.json({ error: "Category required" }, 400);
  }
  const y = Number(yesPrice), n = Number(noPrice);
  if (!Number.isInteger(y) || !Number.isInteger(n) || y < 1 || n < 1 || y + n !== 100) {
    return c.json({ error: "YES + NO prices must be integers summing to 100" }, 400);
  }
  const dl = Number(deadline);
  if (!Number.isFinite(dl) || dl <= Date.now()) {
    return c.json({ error: "Deadline must be a future timestamp (ms)" }, 400);
  }

  const result = await withMarketsLock(async (markets) => {
    if (markets.some((m) => m.id === id)) {
      return { status: 409 as const, body: { error: "Market ID already exists" } };
    }
    markets.push({
      id, title, category,
      yesPrice: y, noPrice: n,
      volume: 0,
      deadline: dl,
      status: "open",
      resolutionUtxoRef: null,
      published: false, // drafts by default — admin must explicitly publish
    });
    await saveMarkets(markets);
    return { status: 200 as const, body: { ok: true } };
  });
  return c.json(result.body, result.status);
});

// ── Admin: publish / unpublish ────────────────────────────────────────────────
app.post("/api/admin/markets/:id/publish", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  let publishedMarket: Market | null = null;
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    const wasPublished = m.published === true;
    m.published = true;
    await saveMarkets(markets);
    // Only announce the first publish — re-publishing (after an unpublish)
    // shouldn't spam the channel.
    if (!wasPublished) publishedMarket = { ...m };
    return { status: 200 as const, body: { ok: true } };
  });
  // Fire-and-forget OUTSIDE the lock so Discord latency doesn't hold the mutex.
  if (publishedMarket) notify.marketPublished(publishedMarket);
  return c.json(result.body, result.status);
});

app.post("/api/admin/markets/:id/unpublish", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  // Cheap existence check outside the lock first.
  {
    const preview = await loadMarkets();
    if (!preview.find((x) => x.id === id)) return c.json({ error: "Not found" }, 404);
  }
  // Don't allow unpublishing if there are on-chain bets — they'd become invisible to bettors
  const lucid = await getLucid();
  const utxos = await fetchUtxos(contractAddress(lucid));
  const marketIdHex = bytesToHex(new TextEncoder().encode(id));
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    try {
      const datum = Data.from(utxo.datum, EventDatumSchema);
      if ("Bet" in datum) {
        const bet = datum.Bet[0];
        // Compare by hex — avoids lossy UTF-8 round-trip.
        if ((bet.market_id as string) === marketIdHex) {
          return c.json({ error: "Cannot unpublish: this market has bets on-chain" }, 400);
        }
      }
    } catch { /* skip */ }
  }
  let auditTitle: string | null = null;
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    const wasPublished = m.published === true;
    m.published = false;
    await saveMarkets(markets);
    if (wasPublished) auditTitle = m.title;
    return { status: 200 as const, body: { ok: true } };
  });
  if (auditTitle) notify.adminAction({ action: "unpublish", marketId: id, marketTitle: auditTitle });
  return c.json(result.body, result.status);
});

// ── Admin: hide / unhide (admin-view-only, never affects on-chain or users) ──
// Hidden markets still show in /api/admin/markets (so the Hidden tab works)
// but are filtered out of the public /api/markets regardless of `published`.
app.post("/api/admin/markets/:id/hide", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  let auditTitle: string | null = null;
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    const wasHidden = m.hidden === true;
    m.hidden = true;
    await saveMarkets(markets);
    if (!wasHidden) auditTitle = m.title;
    return { status: 200 as const, body: { ok: true } };
  });
  if (auditTitle) notify.adminAction({ action: "hide", marketId: id, marketTitle: auditTitle });
  return c.json(result.body, result.status);
});

app.post("/api/admin/markets/:id/unhide", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  let auditTitle: string | null = null;
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    const wasHidden = m.hidden === true;
    m.hidden = false;
    await saveMarkets(markets);
    if (wasHidden) auditTitle = m.title;
    return { status: 200 as const, body: { ok: true } };
  });
  if (auditTitle) notify.adminAction({ action: "unhide", marketId: id, marketTitle: auditTitle });
  return c.json(result.body, result.status);
});

// ── Admin: per-market bet stats (scans contract UTxOs) ───────────────────────
app.get("/api/admin/stats", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const lucid = await getLucid();
  const utxos = await fetchUtxos(contractAddress(lucid));
  const stats: Record<string, { betCount: number; totalEct: number }> = {};
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    try {
      const datum = Data.from(utxo.datum, EventDatumSchema);
      if ("Bet" in datum) {
        const bet = datum.Bet[0];
        const marketId = new TextDecoder().decode(hexToBytes(bet.market_id as string));
        const amt = Number(bet.ect_amount);
        const s = stats[marketId] ?? { betCount: 0, totalEct: 0 };
        s.betCount += 1;
        s.totalEct += amt;
        stats[marketId] = s;
      }
    } catch { /* skip */ }
  }
  return c.json(stats);
});

// ── Admin: edit market (title / category / prices / deadline) ────────────────
app.patch("/api/admin/markets/:id", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  // If deadline is being changed, first check for on-chain bets (outside the
  // lock — Koios is slow). Bets bake the original deadline into their datum;
  // changing it in markets.json creates a confusing UX mismatch.
  let deadlineEditBlocked = false;
  if (body.deadline !== undefined) {
    const lucid = await getLucid();
    const utxos = await fetchUtxos(contractAddress(lucid));
    const marketIdHex = bytesToHex(new TextEncoder().encode(id));
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      try {
        const datum = Data.from(utxo.datum, EventDatumSchema);
        if ("Bet" in datum && (datum.Bet[0].market_id as string) === marketIdHex) {
          deadlineEditBlocked = true;
          break;
        }
      } catch { /* skip */ }
    }
  }

  let auditTitle: string | null = null;
  const auditChanges: string[] = [];
  const result = await withMarketsLock(async (markets) => {
    const idx = markets.findIndex((m) => m.id === id);
    if (idx === -1) return { status: 404 as const, body: { error: "Not found" } };
    if (markets[idx].status !== "open") {
      return { status: 400 as const, body: { error: "Can only edit open markets" } };
    }

    const m = markets[idx];
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title || body.title.length > 200) {
        return { status: 400 as const, body: { error: "Title invalid" } };
      }
      if (m.title !== body.title) auditChanges.push(`title: "${m.title}" → "${body.title}"`);
      m.title = body.title;
    }
    if (body.category !== undefined) {
      if (typeof body.category !== "string" || !body.category) {
        return { status: 400 as const, body: { error: "Category invalid" } };
      }
      if (m.category !== body.category) auditChanges.push(`category: ${m.category} → ${body.category}`);
      m.category = body.category;
    }
    if (body.yesPrice !== undefined || body.noPrice !== undefined) {
      const y = Number(body.yesPrice ?? m.yesPrice);
      const n = Number(body.noPrice ?? m.noPrice);
      if (!Number.isInteger(y) || !Number.isInteger(n) || y < 1 || n < 1 || y + n !== 100) {
        return { status: 400 as const, body: { error: "YES + NO prices must be integers summing to 100" } };
      }
      if (m.yesPrice !== y) auditChanges.push(`yesPrice: ${m.yesPrice} → ${y}`);
      m.yesPrice = y;
      m.noPrice = n;
    }
    if (body.deadline !== undefined) {
      if (deadlineEditBlocked) {
        return {
          status: 400 as const,
          body: { error: "Cannot edit deadline: market already has on-chain bets whose datums reference the original deadline" },
        };
      }
      const dl = Number(body.deadline);
      if (!Number.isFinite(dl) || dl <= Date.now()) {
        return { status: 400 as const, body: { error: "Deadline must be a future timestamp" } };
      }
      if (m.deadline !== dl) {
        auditChanges.push(`deadline: ${new Date(m.deadline).toISOString().slice(0, 16)} → ${new Date(dl).toISOString().slice(0, 16)}`);
      }
      m.deadline = dl;
    }

    await saveMarkets(markets);
    auditTitle = m.title;
    return { status: 200 as const, body: { ok: true, market: m } };
  });
  if (auditTitle && auditChanges.length > 0) {
    notify.adminAction({
      action: "edit",
      marketId: id,
      marketTitle: auditTitle,
      details: auditChanges.join(", "),
    });
  }
  return c.json(result.body, result.status);
});

// ── Admin: delete market (only if zero bets on-chain) ────────────────────────
app.delete("/api/admin/markets/:id", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  // Check on-chain first (slow, outside the lock).
  const lucid = await getLucid();
  const utxos = await fetchUtxos(contractAddress(lucid));
  const marketIdHex = bytesToHex(new TextEncoder().encode(id));
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    try {
      const datum = Data.from(utxo.datum, EventDatumSchema);
      if ("Bet" in datum && (datum.Bet[0].market_id as string) === marketIdHex) {
        return c.json({ error: "Cannot delete: this market has bets on-chain" }, 400);
      }
    } catch { /* skip */ }
  }
  let auditTitle: string | null = null;
  const result = await withMarketsLock(async (markets) => {
    const idx = markets.findIndex((m) => m.id === id);
    if (idx === -1) return { status: 404 as const, body: { error: "Not found" } };
    if (markets[idx].status !== "open") {
      return { status: 400 as const, body: { error: "Can only delete open markets" } };
    }
    auditTitle = markets[idx].title;
    markets.splice(idx, 1);
    await saveMarkets(markets);
    return { status: 200 as const, body: { ok: true } };
  });
  if (auditTitle) notify.adminAction({ action: "delete", marketId: id, marketTitle: auditTitle });
  return c.json(result.body, result.status);
});

app.get("/api/markets/:id", async (c) => {
  const markets = await loadMarkets();
  const market = markets.find((m) => m.id === c.req.param("id"));
  if (!market) return c.json({ error: "Not found" }, 404);
  return c.json(market);
});

// ── User bets (contract UTxOs filtered by bettor) ────────────────────────────

// Decode bech32 address to raw bytes (header + PKH + optional staking key)
// ── Bech32 decoder with checksum verification (BIP-0173) ────────────────────
// This is the full, CIP-5 compliant check. The previous version trusted the
// HRP prefix and stripped the last 6 chars without verifying them, so any
// shaped-like string could pass. Verifying the checksum matters: an attacker
// can't forge arbitrary vkh bytes just by constructing a bech32-looking blob.

const BECH32_CS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

// Returns raw payload bytes on success; null on HRP mismatch, bad char, or
// checksum failure. `expectedHrp` is the required human-readable part
// (e.g. "addr" for mainnet, reject "addr_test" in prod).
function bech32Decode(str: string, expectedHrp: string): Uint8Array | null {
  if (typeof str !== "string" || str.length < 8 || str.length > 130) return null;
  // Mixed case is forbidden per BIP-0173; Cardano addresses are all lowercase.
  if (str.toLowerCase() !== str && str.toUpperCase() !== str) return null;
  const lower = str.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  if (hrp !== expectedHrp) return null;
  const dataPart = lower.slice(sep + 1);
  const data: number[] = [];
  for (const ch of dataPart) {
    const d = BECH32_CS.indexOf(ch);
    if (d < 0) return null;
    data.push(d);
  }
  // Verify checksum: polymod(hrp_expand || data) must equal 1.
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== 1) return null;
  // Convert 5-bit groups (minus last 6 checksum chars) → 8-bit bytes.
  const payload = data.slice(0, data.length - 6);
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const v of payload) {
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  // If leftover bits carry non-zero data, the input is malformed.
  if (bits >= 5 || ((value << (8 - bits)) & 0xff) !== 0) {
    // leftover — allow, Cardano uses bech32 not bech32m so some trailing bits
    // are tolerated, but reject if any of them are non-zero information bits.
    // (Strict: Cardano addresses always byte-align, so this branch shouldn't
    // happen for well-formed input.)
    if (bits >= 5) return null;
  }
  return new Uint8Array(bytes);
}

// Extract 28-byte payment key hash from a bech32 mainnet address.
// Rejects testnet ("addr_test"), malformed, or wrong-checksum input.
function vkhFromAddress(address: string): string | null {
  // Only mainnet bech32 addresses are accepted. Everything else is rejected.
  if (typeof address !== "string" || !/^addr1[0-9a-z]+$/.test(address)) return null;
  const bytes = bech32Decode(address, "addr");
  if (!bytes || bytes.length < 29) return null;
  // Header byte (Shelley-era encoding) varies by address type; payment VKH
  // is bytes [1..29] for type-0 (base), type-1 (script+stake), type-6
  // (enterprise VKH), etc. Reject script-origin addresses (type nibble 1,3,5,7)
  // — bet/payout datums must bind to a *verification-key* hash, not a script.
  const headerType = bytes[0] >> 4;
  // 0,2,4,6 = payment VKH; 1,3,5,7 = payment SCRIPT. Reject script-payment.
  if ((headerType & 1) !== 0) return null;
  return bytesToHex(bytes.slice(1, 29));
}

app.get("/api/bets/:address", async (c) => {
  const lucid = await getLucid();
  const addr = contractAddress(lucid);
  const utxos = await fetchUtxos(addr);
  const bettorAddress = c.req.param("address");

  // Extract VKH from the bech32 address so we can compare to stored bet/payout datums
  const bettorVkh = vkhFromAddress(bettorAddress);
  if (!bettorVkh) return c.json({ error: "Invalid address" }, 400);

  const openBets = [];
  const payouts = [];
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    try {
      const datum = Data.from(utxo.datum, EventDatumSchema);
      if ("Bet" in datum) {
        const bet = datum.Bet[0];
        if ((bet.bettor as string) === bettorVkh) {
          openBets.push({
            ref: `${utxo.txHash}#${utxo.outputIndex}`,
            marketId: new TextDecoder().decode(
              hexToBytes(bet.market_id as string),
            ),
            side: bet.side,
            ectAmount: Number(bet.ect_amount),
            deadline: Number(bet.deadline),
          });
        }
      } else if ("Payout" in datum) {
        const pay = datum.Payout[0];
        if ((pay.bettor as string) === bettorVkh) {
          payouts.push({
            ref: `${utxo.txHash}#${utxo.outputIndex}`,
            marketId: new TextDecoder().decode(
              hexToBytes(pay.market_id as string),
            ),
            payoutAmount: Number(pay.payout_amount),
          });
        }
      }
    } catch {
      // skip malformed datums
    }
  }
  return c.json({ openBets, payouts });
});

// ── POST /api/tx/place-bet ────────────────────────────────────────────────────

// Maximum allowed ECT in a single bet (in micro-ECT). 1 trillion micro-ECT
// = 1,000,000 whole ECT. ECT total supply is 10 billion (10^16 micro-ECT),
// so this caps a single bet well below anything sane.
const MAX_BET_MICRO_ECT = 1_000_000n * 1_000_000n;

app.post("/api/tx/place-bet", async (c) => {
  const { marketId, side, ectAmount, bettorAddress, walletUtxos } = await c.req.json();
  if (!marketId || typeof marketId !== "string") {
    return c.json({ error: "marketId required" }, 400);
  }
  if (!bettorAddress || typeof bettorAddress !== "string") {
    return c.json({ error: "bettorAddress required" }, 400);
  }
  // Strict side validation — rejecting "YeS" etc. means users can't silently
  // end up on the opposite side. The old `side === "Yes" ? "Yes" : "No"`
  // coerced everything non-Yes to No.
  if (side !== "Yes" && side !== "No") {
    return c.json({ error: "side must be 'Yes' or 'No'" }, 400);
  }
  // Strict amount validation. ectAmount must be a positive integer fitting
  // safely into a BigInt, below the per-bet cap, with no floats, no
  // scientific notation, no NaN.
  let needed: bigint;
  try {
    // Only accept a JS number that is a non-negative integer, or a digit-only
    // string. Reject floats and exponent notation to avoid ambiguity.
    if (typeof ectAmount === "number") {
      if (!Number.isInteger(ectAmount) || ectAmount <= 0) throw new Error();
      needed = BigInt(ectAmount);
    } else if (typeof ectAmount === "string" && /^[1-9][0-9]*$/.test(ectAmount)) {
      needed = BigInt(ectAmount);
    } else {
      throw new Error();
    }
    if (needed <= 0n || needed > MAX_BET_MICRO_ECT) throw new Error();
  } catch {
    return c.json({ error: "ectAmount must be a positive integer micro-ECT below the per-bet cap" }, 400);
  }

  // SECURITY: derive bettorVkh from the address — never trust a client-supplied
  // vkh, or wallet A could bet funds with wallet B stamped into the datum and
  // B could later claim/refund.
  const bettorVkh = vkhFromAddress(bettorAddress);
  if (!bettorVkh) return c.json({ error: "Invalid bettor address" }, 400);

  const markets = await loadMarkets();
  const market = markets.find((m) => m.id === marketId);
  if (!market) return c.json({ error: "Market not found" }, 404);
  if (market.status !== "open") return c.json({ error: "Market closed" }, 400);
  if (!market.published) return c.json({ error: "Market not published" }, 400);

  const lucid = await getLucid();

  // Reject bets after market close
  if (Date.now() > market.deadline) {
    return c.json({ error: "Market is closed for betting" }, 400);
  }

  const datum = encodeBetDatum({
    market_id: bytesToHex(new TextEncoder().encode(marketId)),
    bettor: bettorVkh,
    side,
    ect_amount: needed,
    // Market close deadline. Validator uses this as the lower-bound gate for
    // both Resolve and Refund (after close, whichever fires first wins — a
    // Resolution UTxO blocks refund).
    deadline: BigInt(market.deadline),
  });

  // Use browser-provided UTxOs (all wallet addresses) or fall back to Koios
  const utxos = await resolveWalletUtxos(walletUtxos, [bettorAddress]);

  if (!utxos.length) {
    return c.json({ error: "Wallet has no UTxOs — make sure your wallet has ADA and $ECT$ on Mainnet" }, 400);
  }

  // Pre-flight: check wallet has enough ECT
  const walletEct = utxos.reduce((sum, u) => sum + (u.assets[ECT_UNIT] ?? 0n), 0n);
  const walletLovelace = utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
  if (walletEct < needed) {
    const haveDisplay = Number(walletEct) / 1_000_000;
    const needDisplay = Number(needed) / 1_000_000;
    return c.json({
      error: `Insufficient $ECT$: wallet holds ${haveDisplay.toFixed(6)} ECT but this bet needs ${needDisplay.toFixed(6)} ECT. Try fewer shares.`,
    }, 400);
  }
  if (walletLovelace < 3_000_000n) {
    return c.json({ error: `Insufficient ADA: wallet has ${Number(walletLovelace) / 1_000_000} ADA but needs at least 3 ADA.` }, 400);
  }

  lucid.selectWallet.fromAddress(bettorAddress, utxos);

  const contractAddr = contractAddress(lucid);
  const ectUnit = ECT_UNIT;
  const assets = {
    lovelace: 2_000_000n,
    [ectUnit]: needed,
  };

  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      contractAddr,
      { kind: "inline", value: datum },
      assets,
    )
    .addSignerKey(bettorVkh)
    // Cap validity at market close so a signed-but-stashed place-bet tx
    // can't be submitted after the window. Also prevents long-lived pending
    // txs from sitting in wallets after the user has moved on.
    .validTo(market.deadline)
    .complete();

  return c.json({ unsignedTx: tx.toCBOR() });
});

// ── POST /api/tx/resolve-market ───────────────────────────────────────────────

app.post("/api/tx/resolve-market", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);

  const { marketId, winner } = await c.req.json();
  if (!marketId || typeof marketId !== "string") {
    return c.json({ error: "marketId required" }, 400);
  }
  if (winner !== "Yes" && winner !== "No") {
    return c.json({ error: "winner must be 'Yes' or 'No'" }, 400);
  }
  // Oracle address is fixed and hardcoded — do NOT accept a client-supplied
  // one. We also deliberately ignore any client-supplied `walletUtxos`: an
  // admin's compromised browser could feed crafted entries (claiming the
  // oracle address) that the old check only validated by the .address field
  // the client itself sets. Always fetch oracle UTxOs server-side from Koios.
  const oracleAddress = ORACLE_ADDRESS;
  const oracleVkh = ORACLE_VKH;

  const markets = await loadMarkets();
  const idx = markets.findIndex((m) => m.id === marketId);
  if (idx === -1) return c.json({ error: "Market not found" }, 404);
  if (markets[idx].status !== "open") {
    return c.json({ error: "Market already resolved" }, 400);
  }

  // SECURITY: only allow resolution after the market's betting deadline has
  // passed. Combined with the place-bet gate (rejects after deadline), this
  // closes the race where a new bet could arrive between us snapshotting
  // contract UTxOs and the oracle submitting the resolve tx.
  if (Date.now() < markets[idx].deadline) {
    return c.json({
      error: `Cannot resolve yet — market closes at ${new Date(markets[idx].deadline).toISOString()}`,
    }, 400);
  }

  const lucid = await getLucid();
  const contractAddr = contractAddress(lucid);
  const marketIdHex = bytesToHex(new TextEncoder().encode(marketId));

  // ── Gather all bet UTxOs for this market ────────────────────────────────────
  const allContractUtxos = await fetchUtxos(contractAddr);
  type ParsedBet = { utxo: UTxO; bet: BetDatum };
  const bets: ParsedBet[] = [];
  for (const u of allContractUtxos) {
    if (!u.datum) continue;
    try {
      const d = Data.from(u.datum, EventDatumSchema);
      if ("Bet" in d) {
        const bet = d.Bet[0];
        if ((bet.market_id as string) === marketIdHex) {
          bets.push({ utxo: u, bet });
        }
      }
    } catch {
      // skip non-bet UTxOs (Payout, Resolution, malformed)
    }
  }

  if (bets.length === 0) {
    return c.json({ error: "No bets to resolve for this market" }, 400);
  }

  // The validator enforces lower_bound_after(tx, bet.deadline) on EVERY bet
  // input. If the market deadline was shortened AFTER bets were placed, those
  // bets still carry their original (later) deadline in their datum. We must
  // wait until the LATEST bet deadline has passed, not just the current
  // market deadline.
  let maxBetDeadline = 0;
  for (const { bet } of bets) {
    const d = Number(bet.deadline);
    if (d > maxBetDeadline) maxBetDeadline = d;
  }
  if (Date.now() < maxBetDeadline) {
    return c.json({
      error:
        `Cannot resolve yet — existing bets carry deadlines up to ${new Date(maxBetDeadline).toISOString()}. ` +
        `(Market deadline was likely shortened after these bets were placed; bet datums can't be rewritten.)`,
    }, 400);
  }

  // ── Compute totals + per-winner payouts ────────────────────────────────────
  const winnerSide = winner === "Yes" ? "Yes" : "No";
  let totalYes = 0n;
  let totalNo = 0n;
  for (const { bet } of bets) {
    if (bet.side === "Yes") totalYes += BigInt(bet.ect_amount);
    else totalNo += BigInt(bet.ect_amount);
  }

  const winnerPool = winnerSide === "Yes" ? totalYes : totalNo;
  const loserPool = winnerSide === "Yes" ? totalNo : totalYes;

  if (winnerPool === 0n) {
    return c.json(
      { error: "No winning bets exist — cannot resolve to this side. Losers may refund after deadline." },
      400,
    );
  }

  // House fee = 3% of losers' pool (integer floor).
  const feeEct = (loserPool * BigInt(FEE_BPS)) / 10_000n;
  const distributionPool = loserPool - feeEct;

  // Compute each winner's payout: stake + pro-rata share of distribution pool.
  // Integer math: payout = stake + (stake * distributionPool) / winnerPool
  // Due to integer division, Σ shares may be slightly < distributionPool.
  // The remainder ("dust") is routed to the treasury output below — this
  // prevents value leaking into the oracle's change output.
  type Payout = {
    bettorVkh: string;
    payoutEct: bigint;
    origStake: bigint;
    betRef: { transaction_id: string; output_index: bigint };
  };
  const payouts: Payout[] = [];
  let totalSharesGiven = 0n;
  for (const { utxo, bet } of bets) {
    if (bet.side !== winnerSide) continue;
    // Invariant: Koios returns tx hashes as 64-char lowercase hex (32 bytes).
    // The validator-side OutputReference schema requires exactly 32 bytes.
    // If Lucid / a future upstream ever switches to raw-bytes or a prefixed
    // form, Data.to would silently emit the wrong size and validation would
    // fail on-chain. Assert here so a drift surfaces as a clear error.
    if (!/^[0-9a-f]{64}$/i.test(utxo.txHash)) {
      return c.json({
        error: `Unexpected txHash shape from upstream: ${utxo.txHash}`,
      }, 500);
    }
    if (!Number.isInteger(utxo.outputIndex) || utxo.outputIndex < 0) {
      return c.json({
        error: `Unexpected outputIndex from upstream: ${utxo.outputIndex}`,
      }, 500);
    }
    const stake = BigInt(bet.ect_amount);
    const share = (stake * distributionPool) / winnerPool;
    totalSharesGiven += share;
    payouts.push({
      bettorVkh: bet.bettor as string,
      payoutEct: stake + share,
      origStake: stake,
      // bet_ref must match the validator's OutputReference shape exactly —
      // binds this payout 1:1 to the source bet UTxO (audit P0-C2).
      betRef: {
        transaction_id: utxo.txHash,
        output_index: BigInt(utxo.outputIndex),
      },
    });
  }
  // Dust swept into treasury so ECT conservation is exact:
  //   Σ stakes_in = Σ winner_stakes + losers_pool
  //                = Σ winner_payouts + (losers_pool - Σ shares)
  //                = Σ winner_payouts + treasuryEct
  const dustEct = distributionPool - totalSharesGiven;
  const treasuryEct = feeEct + dustEct;

  // ── Build tx ────────────────────────────────────────────────────────────────
  // Always fetch oracle UTxOs server-side. Client-supplied walletUtxos are
  // deliberately NOT accepted here (see top-of-handler comment).
  const utxos = await fetchUtxos(oracleAddress);
  lucid.selectWallet.fromAddress(oracleAddress, utxos);

  const resolutionDatum = encodeResolutionDatum({
    market_id: marketIdHex,
    winner: winnerSide,
    oracle: oracleVkh,
    total_yes: totalYes,
    total_no: totalNo,
  });

  const resolveRedeemer = Data.to("Resolve", EventRedeemerSchema);

  // Min-ADA per output carrying a native asset: ~1.2 ADA. Use 1.5 to be safe; Lucid auto-adjusts.
  const MIN_ADA_WITH_ASSET = 1_500_000n;
  const MIN_ADA_PURE = 2_000_000n; // Resolution marker carries no assets

  let txBuilder = lucid
    .newTx()
    .collectFrom(bets.map((b) => b.utxo), resolveRedeemer)
    .attach.SpendingValidator(eventChainValidator)
    .addSignerKey(oracleVkh)
    // Validator requires lower_bound >= bet.deadline on Resolve — use max
    // across all bets (covers markets whose deadline was edited post-bet).
    //
    // validFrom(ms) FLOORS to the enclosing slot (1s on Cardano), so the
    // on-chain lower_bound can come back up to ~999 ms BEFORE the requested
    // ms. Pad by 1_500 ms (~1.5 slots) so the resulting lower_bound is
    // strictly >= maxBetDeadline and the Plutus check passes.
    .validFrom(maxBetDeadline + 1_500);

  // Emit one Payout UTxO per winner
  for (const p of payouts) {
    const payoutDatum = encodePayoutDatum({
      market_id: marketIdHex,
      bettor: p.bettorVkh,
      payout_amount: p.payoutEct,
      bet_ref: p.betRef,
    });
    txBuilder = txBuilder.pay.ToAddressWithData(
      contractAddr,
      { kind: "inline", value: payoutDatum },
      { lovelace: MIN_ADA_WITH_ASSET, [ECT_UNIT]: p.payoutEct },
    );
  }

  // Treasury output = fee + integer-division dust (ECT conservation).
  if (treasuryEct > 0n) {
    txBuilder = txBuilder.pay.ToAddress(
      TREASURY_ADDRESS,
      { lovelace: MIN_ADA_WITH_ASSET, [ECT_UNIT]: treasuryEct },
    );
  }

  // Resolution marker (pure ADA, used as reference by Claim if needed later)
  txBuilder = txBuilder.pay.ToAddressWithData(
    contractAddr,
    { kind: "inline", value: resolutionDatum },
    { lovelace: MIN_ADA_PURE },
  );

  const tx = await txBuilder.complete({ localUPLCEval: false });
  const unsignedTx = tx.toCBOR();
  const txHash = tx.toHash();

  // NOTE: we DO NOT flip markets.json status here anymore. If this tx fails
  // to submit, the on-chain state is still open and flipping the JSON would
  // desync the UI. Admin must call POST /api/admin/markets/:id/mark-resolved
  // with the submitted txHash AFTER confirming submission succeeded.

  return c.json({
    unsignedTx,
    txHash,
    summary: {
      totalBets: bets.length,
      winners: payouts.length,
      losers: bets.length - payouts.length,
      totalYes: totalYes.toString(),
      totalNo: totalNo.toString(),
      fee: feeEct.toString(),
      dust: dustEct.toString(),
      treasury: treasuryEct.toString(),
      distributionPool: distributionPool.toString(),
    },
  });
});

// ── POST /api/admin/markets/:id/mark-resolved ────────────────────────────────
// Admin calls this AFTER successfully submitting the resolve tx. Only flips
// the markets.json status once the tx is truly in-flight; prevents UI desync
// when submission fails.
app.post("/api/admin/markets/:id/mark-resolved", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const txHash = body?.txHash;
  if (!txHash || typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash)) {
    return c.json({ error: "Valid txHash required" }, 400);
  }

  // Verify the tx is actually visible on-chain before flipping status. This
  // closes an admin footgun where mark-resolved could be called with a
  // fabricated txHash, permanently blocking refunds (refund endpoint bails
  // on status==="resolved"). Koios returns an empty array for unknown txs.
  const verifyResp = await koiosPost("/tx_status", { _tx_hashes: [txHash] });
  if (!verifyResp.ok) {
    return c.json({ error: `Koios tx_status failed: ${verifyResp.status}` }, 502);
  }
  const statusRows = await verifyResp.json().catch(() => []);
  const txRow = Array.isArray(statusRows)
    ? statusRows.find(
      (r: { tx_hash?: string; num_confirmations?: number | null }) =>
        r.tx_hash === txHash,
    )
    : null;
  if (!txRow) {
    return c.json({ error: "Tx not found on-chain yet — wait for propagation and retry" }, 400);
  }
  // Koios `/tx_status` returns rows for mempool-only txs too (num_confirmations
  // is null or 0). Mempool txs can still be dropped or rolled back — flipping
  // status=resolved here would permanently block refunds (refund endpoint
  // gates on status !== "resolved"). Require a small confirmation depth so a
  // 1-block rollback can't brick the market. 3 is conservative for mainnet.
  const REQUIRED_CONFIRMATIONS = 3;
  const confs = Number(txRow.num_confirmations ?? 0);
  if (!Number.isFinite(confs) || confs < REQUIRED_CONFIRMATIONS) {
    return c.json(
      {
        error:
          `Tx has only ${confs} confirmations — wait for at least ${REQUIRED_CONFIRMATIONS} before marking resolved ` +
          `(mempool-only or shallowly-confirmed txs can still roll back and would permanently lock refunds).`,
      },
      400,
    );
  }

  // N3: verify the tx actually contains a Resolution output for THIS market.
  // Defense-in-depth: admin is trusted, but if the admin UI were compromised
  // an attacker could pass a random confirmed txHash and flip an unrelated
  // market to "resolved", permanently blocking refunds. We fetch tx_info,
  // scan outputs at the contract address, and require at least one inline
  // datum whose bytes contain this market_id (utf8, hex-encoded). The market
  // ID regex is `[a-z0-9-]+` so there's no injection surface in the substring
  // check, and CBOR-encoded bytestrings of the id are always present for a
  // legitimate Resolve (both ResolutionDatum and every per-winner PayoutDatum
  // embed it).
  const infoResp = await koiosPost("/tx_info", {
    _tx_hashes: [txHash],
    _inputs: false,
    _metadata: false,
    _assets: false,
    _withdrawals: false,
    _certs: false,
    _scripts: false,
    _bytecode: false,
  });
  if (!infoResp.ok) {
    return c.json({ error: `Koios tx_info failed: ${infoResp.status}` }, 502);
  }
  const infoRows = await infoResp.json().catch(() => []);
  const infoRow = Array.isArray(infoRows)
    ? infoRows.find((r: { tx_hash?: string }) => r.tx_hash === txHash)
    : null;
  if (!infoRow || !Array.isArray(infoRow.outputs)) {
    return c.json({ error: "tx_info missing outputs — retry shortly" }, 502);
  }
  const lucid = await getLucid();
  const contractAddr = contractAddress(lucid);
  // Build the CBOR-framed form of the market-id bytestring. In a CBOR-encoded
  // Plutus datum the market_id field appears as `<frame><idBytes>` where the
  // frame is the bytestring header byte(s). Matching the framed form — not
  // the raw id hex — prevents prefix-id collisions: without the frame byte,
  // a confirmed resolve of "btc-100k-june" (hex contains "btc-100k"'s hex as
  // a substring) would falsely satisfy mark-resolved for "btc-100k" and
  // permanently brick its refunds. The frame byte pins length, so "btc-100k"
  // with frame 0x48 can never appear inside the encoding of a 13-byte id.
  const idBytes = new TextEncoder().encode(id);
  const idLen = idBytes.length;
  const idHex = Array.from(idBytes)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  // Major type 2 (bytestring). Short form packs length in the low 5 bits
  // (0x40..0x57); lengths 24..255 use 0x58 <len>; 256..65535 use 0x59 <lenHi><lenLo>.
  // Market-id regex is [a-z0-9-]+ so realistic ids are <100 bytes; the long
  // form is a belt-and-suspenders defensive path.
  let frameHex: string;
  if (idLen < 24) {
    frameHex = (0x40 + idLen).toString(16).padStart(2, "0");
  } else if (idLen < 256) {
    frameHex = "58" + idLen.toString(16).padStart(2, "0");
  } else if (idLen < 65536) {
    frameHex = "59" + idLen.toString(16).padStart(4, "0");
  } else {
    return c.json({ error: "Market id too long to frame" }, 400);
  }
  const framedHex = (frameHex + idHex).toLowerCase();
  const matched = infoRow.outputs.some((o: {
    payment_addr?: { bech32?: string };
    inline_datum?: { bytes?: string } | null;
  }) => {
    if (o?.payment_addr?.bech32 !== contractAddr) return false;
    const dh = o?.inline_datum?.bytes;
    return typeof dh === "string" && dh.toLowerCase().includes(framedHex);
  });
  if (!matched) {
    return c.json(
      {
        error:
          "Tx does not contain a Resolution output for this market at the contract address. " +
          "Refusing to flip status — this would permanently block refunds.",
      },
      400,
    );
  }

  let resolvedSnapshot: { title: string; summary: NonNullable<Market["pendingResolveSummary"]> } | null = null;
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    const alreadyResolved = m.status === "resolved";
    if (!alreadyResolved && m.pendingResolveSummary) {
      resolvedSnapshot = { title: m.title, summary: m.pendingResolveSummary };
    }
    m.status = "resolved";
    m.resolutionUtxoRef = `${txHash}#resolution`;
    delete m.pendingResolveTxHash;
    delete m.pendingResolveSetAt;
    delete m.pendingResolveSummary;
    await saveMarkets(markets);
    return { status: 200 as const, body: { ok: true } };
  });
  // Fire-and-forget Discord announcement. Only when we actually flipped from
  // open → resolved AND we have summary data (retry path without a stored
  // summary still succeeds silently — better than a broken/empty announce).
  if (resolvedSnapshot) {
    const snap = resolvedSnapshot as { title: string; summary: NonNullable<Market["pendingResolveSummary"]> };
    const toEct = (b: number) => b / 1_000_000;
    const winnerPool = snap.summary.winnerSide === "Yes"
      ? snap.summary.totalYes
      : snap.summary.totalNo;
    notify.marketResolved({
      title: snap.title,
      winnerSide: snap.summary.winnerSide,
      totalDistributedEct: toEct(winnerPool + snap.summary.distributionPool),
      winnerPoolEct: toEct(winnerPool),
      distributionEct: toEct(snap.summary.distributionPool),
    });
    // Private admin-only revenue ledger. Same snapshot, different channel.
    const loserPool = snap.summary.winnerSide === "Yes"
      ? snap.summary.totalNo
      : snap.summary.totalYes;
    notify.treasuryIn({
      marketTitle: snap.title,
      feeEct: toEct(snap.summary.fee),
      loserPoolEct: toEct(loserPool),
    });
  }
  return c.json(result.body, result.status);
});

// ── POST /api/admin/markets/:id/mark-refunded ────────────────────────────────
// Admin calls this after /api/tx/admin/force-refund reports remaining === 0.
// Instead of trusting a client-supplied txHash, we verify reality against
// Koios: no bet UTxOs for this market may remain at the contract address.
// That's a stronger guarantee than tx confirmation — the market is truly
// refunded if and only if the contract holds nothing for it.
app.post("/api/admin/markets/:id/mark-refunded", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");

  const lucid = await getLucid();
  const contractAddr = contractAddress(lucid);
  const marketIdHex = bytesToHex(new TextEncoder().encode(id));

  const allContractUtxos = await fetchUtxos(contractAddr);
  for (const u of allContractUtxos) {
    if (!u.datum) continue;
    try {
      const d = Data.from(u.datum, EventDatumSchema);
      if ("Bet" in d && (d.Bet[0].market_id as string) === marketIdHex) {
        return c.json({
          error:
            "Bet UTxOs still present at contract — run force-refund to empty the market first.",
        }, 400);
      }
    } catch {
      // skip non-Bet UTxOs
    }
  }

  // Fires the announce Discord webhook EXACTLY ONCE — only when the status
  // actually flips from open → refunded. Retry calls to mark-refunded on an
  // already-refunded market are no-ops and fire nothing.
  let refundedSnapshot: { title: string; summary?: NonNullable<Market["pendingRefundedSummary"]> } | null = null;
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    if (m.status === "resolved") {
      return { status: 400 as const, body: { error: "Market already resolved" } };
    }
    if (m.status === "refunded") {
      return { status: 200 as const, body: { ok: true, alreadyRefunded: true } };
    }
    refundedSnapshot = { title: m.title, summary: m.pendingRefundedSummary };
    m.status = "refunded";
    delete m.pendingRefunded;
    delete m.pendingRefundedSummary;
    // Defensive cleanup: pending-resolve fields should never coexist with a
    // refund flip (force-refund refuses to start while pendingResolveTxHash
    // is set, L4). If a future code path ever breaks that invariant — e.g.
    // admin cancels a stale resolve then immediately refunds — we don't
    // want dangling hash/timestamp/summary fields left in markets.json.
    delete m.pendingResolveTxHash;
    delete m.pendingResolveSetAt;
    delete m.pendingResolveSummary;
    await saveMarkets(markets);
    return { status: 200 as const, body: { ok: true } };
  });
  if (refundedSnapshot) {
    const snap = refundedSnapshot as { title: string; summary?: NonNullable<Market["pendingRefundedSummary"]> };
    notify.marketRefunded({
      title: snap.title,
      betCount: snap.summary?.betCount ?? 0,
      totalEct: (snap.summary?.totalEct ?? 0) / 1_000_000,
    });
  }
  return c.json(result.body, result.status);
});

// ── POST /api/admin/markets/:id/pending-refunded ─────────────────────────────
// Admin UI calls this after the last force-refund batch submits, BEFORE it
// tries mark-refunded. If Koios lag makes mark-refunded 400 ("bets still
// present"), the flag persists and `retryPendingRefunded` on the admin page
// retries silently until Koios catches up and the flip succeeds.
app.post("/api/admin/markets/:id/pending-refunded", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  // Body carries the pre-refund snapshot (bet count + ECT total) so the
  // Discord announce on mark-refunded can include accurate numbers. By then
  // the bets are gone from the contract and can't be counted post-hoc.
  const body = await c.req.json().catch(() => null);
  const betCount = Number(body?.betCount);
  const totalEct = Number(body?.totalEct);
  const summary = (Number.isFinite(betCount) && Number.isFinite(totalEct) &&
      betCount >= 0 && totalEct >= 0)
    ? { betCount, totalEct }
    : undefined;

  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    if (m.status === "resolved") {
      return { status: 400 as const, body: { error: "Market resolved, not refunded" } };
    }
    m.pendingRefunded = true;
    if (summary) m.pendingRefundedSummary = summary;
    await saveMarkets(markets);
    return { status: 200 as const, body: { ok: true } };
  });
  return c.json(result.body, result.status);
});

// ── POST /api/admin/markets/:id/pending-resolve ──────────────────────────────
// Admin calls this the moment the wallet returns a submitted txHash. We persist
// it so the next admin page load can auto-retry mark-resolved after the
// 3-confirmation gate clears — even if the admin closed the browser.
app.post("/api/admin/markets/:id/pending-resolve", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const txHash = body?.txHash;
  if (!txHash || typeof txHash !== "string" || !/^[0-9a-f]{64}$/i.test(txHash)) {
    return c.json({ error: "Valid txHash required" }, 400);
  }
  // Optional summary: validate shape strictly to avoid persisting garbage that
  // would later be fed into the Discord announcement. Numeric fields accept
  // either number or numeric-string — the resolve-market response serialises
  // the BigInts as strings for JSON safety, so the client forwards them verbatim.
  const rawSummary = body?.summary;
  let summary: Market["pendingResolveSummary"] | undefined;
  const toFiniteNonNeg = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  if (rawSummary && typeof rawSummary === "object") {
    const { winnerSide } = rawSummary;
    const totalYes = toFiniteNonNeg(rawSummary.totalYes);
    const totalNo = toFiniteNonNeg(rawSummary.totalNo);
    const distributionPool = toFiniteNonNeg(rawSummary.distributionPool);
    const fee = toFiniteNonNeg(rawSummary.fee);
    if (
      (winnerSide === "Yes" || winnerSide === "No") &&
      totalYes !== null && totalNo !== null &&
      distributionPool !== null && fee !== null
    ) {
      summary = { winnerSide, totalYes, totalNo, distributionPool, fee };
    }
  }
  const result = await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return { status: 404 as const, body: { error: "Not found" } };
    // Don't clobber an existing pending hash for a different resolve attempt.
    if (m.status === "resolved") {
      return { status: 200 as const, body: { ok: true, note: "already resolved" } };
    }
    m.pendingResolveTxHash = txHash;
    m.pendingResolveSetAt = Date.now();
    if (summary) m.pendingResolveSummary = summary;
    await saveMarkets(markets);
    return { status: 200 as const, body: { ok: true } };
  });
  return c.json(result.body, result.status);
});

// ── POST /api/tx/claim ────────────────────────────────────────────────────────
// Winner spends their Payout UTxO to collect their winnings.

app.post("/api/tx/claim", async (c) => {
  const { payoutUtxoRef, bettorAddress, walletUtxos } = await c.req.json();
  if (!payoutUtxoRef || !bettorAddress) {
    return c.json({ error: "Missing fields" }, 400);
  }

  const bettorVkh = vkhFromAddress(bettorAddress);
  if (!bettorVkh) return c.json({ error: "Invalid bettor address" }, 400);

  const lucid = await getLucid();
  const claimRedeemer = Data.to("Claim", EventRedeemerSchema);

  const payoutUtxo = await fetchUtxoByRef(payoutUtxoRef);

  // Verify the Payout datum actually belongs to this address — prevents a
  // caller from building a tx against someone else's payout UTxO. (The
  // validator will reject it anyway, but bail early with a clear error.)
  if (!payoutUtxo.datum) return c.json({ error: "Payout UTxO has no datum" }, 400);
  const parsed = Data.from(payoutUtxo.datum, EventDatumSchema);
  if (!("Payout" in parsed)) return c.json({ error: "Not a payout UTxO" }, 400);
  if ((parsed.Payout[0].bettor as string) !== bettorVkh) {
    return c.json({ error: "Payout does not belong to this address" }, 403);
  }

  const feeUtxos = await resolveWalletUtxos(walletUtxos, [bettorAddress]);
  lucid.selectWallet.fromAddress(bettorAddress, feeUtxos);

  // Explicitly pay the ECT payout back to the bettor. Two reasons:
  //   1. Validator requires an output to bettor >= payout_amount.
  //   2. If we left this to Lucid's change handler alone, it would try to
  //      stuff the ECT into the change output. When the payout UTxO has
  //      more ADA than the tx fee (~1.5 vs ~0.2), Lucid decides no wallet
  //      inputs are needed — so the change output gets ~1.3 ADA + ECT,
  //      below the min-UTxO requirement for a bundle with native assets.
  //      By explicitly paying out with MIN_ADA_WITH_ASSET (1.5) here, any
  //      leftover ADA under the min-UTxO threshold forces Lucid to add a
  //      wallet input to fund change properly.
  const payoutEct = parsed.Payout[0].payout_amount as bigint;
  const tx = await lucid
    .newTx()
    .collectFrom([payoutUtxo], claimRedeemer)
    .attach.SpendingValidator(eventChainValidator)
    .pay.ToAddress(bettorAddress, {
      lovelace: 1_500_000n, // min-UTxO for a bundle with one native asset
      [ECT_UNIT]: payoutEct,
    })
    .addSignerKey(bettorVkh)
    .complete({ localUPLCEval: false });

  return c.json({ unsignedTx: tx.toCBOR() });
});

// ── POST /api/tx/claim-all ───────────────────────────────────────────────────
// Batches every PayoutDatum UTxO belonging to the caller into a single tx.
// Saves the N×0.5 ADA fee + N wallet signatures users would pay if they
// clicked Claim once per payout.
//
// Safety:
//   • Only Payout UTxOs whose datum.bettor matches the caller's vkh are
//     consumed — the validator also enforces this per-run.
//   • Validator runs once per input; each sees the same total outputs.
//     Algebra (documented in event_chain.ak): ledger requires Σ in = Σ out,
//     all inputs belong to the bettor, so the bettor always receives the
//     full sum. No cross-user leak possible.
//   • Capped at 20 inputs per tx (Cardano ~16 KB tx size limit). If the user
//     has more, they run Claim All again — fresh UTxO fetch each call means
//     already-consumed payouts drop out naturally.

app.post("/api/tx/claim-all", async (c) => {
  const { bettorAddress, walletUtxos, limit = 20 } = await c.req.json();
  if (!bettorAddress || typeof bettorAddress !== "string") {
    return c.json({ error: "bettorAddress required" }, 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    return c.json({ error: "limit must be an integer in [1, 25]" }, 400);
  }

  const bettorVkh = vkhFromAddress(bettorAddress);
  if (!bettorVkh) return c.json({ error: "Invalid bettor address" }, 400);

  const lucid = await getLucid();
  const contractAddr = contractAddress(lucid);

  // Scan contract for all Payout UTxOs owned by this vkh.
  const allContractUtxos = await fetchUtxos(contractAddr);
  const myPayouts: UTxO[] = [];
  let totalEct = 0n;
  for (const u of allContractUtxos) {
    if (!u.datum) continue;
    try {
      const d = Data.from(u.datum, EventDatumSchema);
      if ("Payout" in d && (d.Payout[0].bettor as string) === bettorVkh) {
        myPayouts.push(u);
        totalEct += d.Payout[0].payout_amount as bigint;
      }
    } catch {
      // skip malformed / non-Payout UTxOs
    }
  }

  if (myPayouts.length === 0) {
    return c.json({ error: "No payouts to claim" }, 400);
  }

  // Deterministic order so repeated calls process the same slice first.
  myPayouts.sort((a, b) =>
    a.txHash === b.txHash
      ? a.outputIndex - b.outputIndex
      : a.txHash.localeCompare(b.txHash)
  );

  const slice = myPayouts.slice(0, limit);
  // Recompute sum over the slice only — may differ from total if limit cut.
  let sliceEct = 0n;
  for (const u of slice) {
    const d = Data.from(u.datum!, EventDatumSchema);
    if ("Payout" in d) sliceEct += d.Payout[0].payout_amount as bigint;
  }

  const claimRedeemer = Data.to("Claim", EventRedeemerSchema);
  const feeUtxos = await resolveWalletUtxos(walletUtxos, [bettorAddress]);
  lucid.selectWallet.fromAddress(bettorAddress, feeUtxos);

  const tx = await lucid
    .newTx()
    .collectFrom(slice, claimRedeemer)
    .attach.SpendingValidator(eventChainValidator)
    // One consolidated output with the full sum — validator per-run check
    // `ect_paid_to(outputs, bettor) >= payout_amount` is satisfied for each
    // input because the single output covers the grand total.
    .pay.ToAddress(bettorAddress, {
      lovelace: 1_500_000n, // min-UTxO for a bundle with one native asset
      [ECT_UNIT]: sliceEct,
    })
    .addSignerKey(bettorVkh)
    .complete({ localUPLCEval: false });

  return c.json({
    unsignedTx: tx.toCBOR(),
    count: slice.length,
    totalEct: sliceEct.toString(),
    remaining: Math.max(0, myPayouts.length - slice.length),
  });
});

// ── POST /api/tx/admin/force-refund ──────────────────────────────────────────
// Oracle-signed mass refund for a market. Each bet UTxO is spent with the
// `ForceRefund` redeemer and its ECT returned to the original bettor's
// enterprise address (payment credential only — validator only checks
// payment-credential match, stake credential is ignored).
//
// Validator gates per-bet: signed_by(oracle) && lower_bound_after(bet.deadline)
// && ect_paid_to(outputs, bet.bettor) >= bet.ect_amount. No grace wait — this
// is the admin's escape hatch for markets that need to be unwound (winner
// pool = 0, cancelled market, etc.).
//
// Batching: tx size caps at ~16 KB, so refunding all bets in one tx fails
// beyond ~50 inputs. Each call builds a tx for up to `limit` bet UTxOs; the
// admin UI polls and re-calls after confirmation until `remaining === 0`.
// UTxOs are always fetched fresh from Koios, so in-flight / confirmed inputs
// are naturally excluded — no paging state to maintain server-side.

app.post("/api/tx/admin/force-refund", async (c) => {
  if (!authAdmin(c.req.raw)) return c.json({ error: "Unauthorized" }, 401);

  const { marketId, limit = 40 } = await c.req.json();
  if (!marketId || typeof marketId !== "string") {
    return c.json({ error: "marketId required" }, 400);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) {
    return c.json({ error: "limit must be an integer in [1, 60]" }, 400);
  }

  const markets = await loadMarkets();
  const m = markets.find((x) => x.id === marketId);
  if (!m) return c.json({ error: "Market not found" }, 404);
  if (m.status === "resolved") {
    return c.json({ error: "Market already resolved" }, 400);
  }
  if (m.status === "refunded") {
    return c.json({ error: "Market already refunded" }, 400);
  }
  // Reject if a resolve tx is in-flight. Both paths spend the same Bet UTxOs,
  // so whichever lands first wins and the other fails with a confusing
  // "no bet UTxOs" — surface the real state to the admin instead.
  if (m.pendingResolveTxHash) {
    return c.json({
      error:
        "Resolve tx is pending confirmation — cannot force-refund while a resolve is in-flight. Wait for the resolve to confirm or expire.",
    }, 400);
  }

  const lucid = await getLucid();
  const contractAddr = contractAddress(lucid);
  const marketIdHex = bytesToHex(new TextEncoder().encode(marketId));

  // Gather all bet UTxOs for this market.
  const allContractUtxos = await fetchUtxos(contractAddr);
  type ParsedBet = { utxo: UTxO; bet: BetDatum };
  const bets: ParsedBet[] = [];
  for (const u of allContractUtxos) {
    if (!u.datum) continue;
    try {
      const d = Data.from(u.datum, EventDatumSchema);
      if ("Bet" in d) {
        const bet = d.Bet[0];
        if ((bet.market_id as string) === marketIdHex) {
          bets.push({ utxo: u, bet });
        }
      }
    } catch {
      // skip non-bet UTxOs
    }
  }

  if (bets.length === 0) {
    return c.json({ error: "No bet UTxOs to refund for this market" }, 400);
  }

  // Deterministic order so repeated calls process bets in a stable sequence.
  bets.sort((a, b) =>
    a.utxo.txHash === b.utxo.txHash
      ? a.utxo.outputIndex - b.utxo.outputIndex
      : a.utxo.txHash.localeCompare(b.utxo.txHash)
  );

  const slice = bets.slice(0, limit);

  // Validator requires lower_bound >= bet.deadline on every bet input — use
  // max across this batch (plus slot-boundary pad, same as other endpoints).
  let maxBetDeadline = 0;
  for (const { bet } of slice) {
    const d = Number(bet.deadline);
    if (d > maxBetDeadline) maxBetDeadline = d;
  }
  if (Date.now() < maxBetDeadline) {
    return c.json({
      error:
        `Cannot force-refund yet — bets in this batch carry deadlines up to ${new Date(maxBetDeadline).toISOString()}.`,
    }, 400);
  }

  // Fetch oracle UTxOs server-side (do NOT trust client-supplied wallet data;
  // same rationale as resolve-market).
  const utxos = await fetchUtxos(ORACLE_ADDRESS);
  lucid.selectWallet.fromAddress(ORACLE_ADDRESS, utxos);

  const forceRefundRedeemer = Data.to("ForceRefund", EventRedeemerSchema);
  const MIN_ADA_WITH_ASSET = 1_500_000n;

  let txBuilder = lucid
    .newTx()
    .collectFrom(slice.map((b) => b.utxo), forceRefundRedeemer)
    .attach.SpendingValidator(eventChainValidator)
    .addSignerKey(ORACLE_VKH)
    .validFrom(maxBetDeadline + 1_500);

  // Pay each bettor back their stake. Aggregate by vkh so wallets that placed
  // multiple bets receive a single consolidated output (saves min-ADA).
  const byBettor = new Map<string, bigint>();
  for (const { bet } of slice) {
    const k = bet.bettor as string;
    byBettor.set(k, (byBettor.get(k) ?? 0n) + BigInt(bet.ect_amount));
  }
  for (const [vkh, ectAmount] of byBettor) {
    // Enterprise address from the payment vkh only. Validator's paid_to_vkh
    // inspects payment_credential alone, so the missing stake credential is
    // fine — no value leaks.
    const bettorAddr = credentialToAddress(
      NETWORK,
      { type: "Key", hash: vkh },
    );
    txBuilder = txBuilder.pay.ToAddress(
      bettorAddr,
      { lovelace: MIN_ADA_WITH_ASSET, [ECT_UNIT]: ectAmount },
    );
  }

  const tx = await txBuilder.complete({ localUPLCEval: false });
  const unsignedTx = tx.toCBOR();
  const txHash = tx.toHash();

  return c.json({
    unsignedTx,
    txHash,
    batchSize: slice.length,
    remaining: Math.max(0, bets.length - slice.length),
    totalBets: bets.length,
  });
});

// ── POST /api/tx/refund ───────────────────────────────────────────────────────

app.post("/api/tx/refund", async (c) => {
  const { betUtxoRef, bettorAddress, walletUtxos } = await c.req.json();
  if (!betUtxoRef || !bettorAddress) {
    return c.json({ error: "Missing fields" }, 400);
  }

  const bettorVkh = vkhFromAddress(bettorAddress);
  if (!bettorVkh) return c.json({ error: "Invalid bettor address" }, 400);

  const lucid = await getLucid();

  const betUtxo = await fetchUtxoByRef(betUtxoRef);
  if (!betUtxo.datum) return c.json({ error: "Bet UTxO has no datum" }, 400);

  const betDatum = Data.from(betUtxo.datum, EventDatumSchema);
  if (!("Bet" in betDatum)) return c.json({ error: "Not a bet UTxO" }, 400);
  const bet = betDatum.Bet[0];
  const deadline = Number(bet.deadline);

  // Datum binds the bet to a vkh — reject if caller isn't that vkh.
  if ((bet.bettor as string) !== bettorVkh) {
    return c.json({ error: "Bet does not belong to this address" }, 403);
  }

  // Belt-and-suspenders: reject if the market is already marked resolved.
  // On-chain validator also blocks this via the Resolution-present check,
  // but fail fast with a clear error.
  //
  // NOTE: we intentionally do NOT block status === "refunded" here. If a bet
  // UTxO is still physically present at the contract (fetchUtxoByRef above
  // would have thrown otherwise), the bettor has a legitimate claim on those
  // funds — even if the market is marked "refunded" in markets.json. This
  // handles the Koios-propagation race where `mark-refunded` flips status
  // while a Bet UTxO was briefly mis-counted as spent. Validator enforces
  // correctness regardless (signed_by(bettor) + deadline-after-grace).
  const marketIdBytes = hexToBytes(bet.market_id as string);
  const marketId = new TextDecoder().decode(marketIdBytes);
  const markets = await loadMarkets();
  const m = markets.find((x) => x.id === marketId);
  if (m && m.status === "resolved") {
    return c.json({ error: "Market resolved — refund not available" }, 400);
  }

  // Reject early refunds — validator also enforces this on-chain.
  // Grace window: users can only self-refund after `deadline + REFUND_GRACE_MS`.
  // This gives the oracle an exclusive window to resolve (or ForceRefund)
  // without racing bettors. Admin can bypass via /api/tx/admin/force-refund.
  const refundOpensAt = deadline + REFUND_GRACE_MS;
  if (Date.now() < refundOpensAt) {
    return c.json({
      error: `Refund not available until ${new Date(refundOpensAt).toISOString()}`,
    }, 400);
  }

  const redeemer = Data.to("Refund", EventRedeemerSchema);
  const feeUtxos = await resolveWalletUtxos(walletUtxos, [bettorAddress]);
  lucid.selectWallet.fromAddress(bettorAddress, feeUtxos);

  const tx = await lucid
    .newTx()
    .collectFrom([betUtxo], redeemer)
    .attach.SpendingValidator(eventChainValidator)
    .addSignerKey(bettorVkh)
    // +1_500 ms to cross the slot boundary so on-chain lower_bound is
    // strictly >= deadline + grace (same rationale as resolve-market).
    .validFrom(refundOpensAt + 1_500)
    // Cap validity at +2h to prevent long-lived stale txs that could be
    // submitted well after client assumed failure.
    .validTo(Date.now() + 2 * 60 * 60 * 1000)
    .complete({ localUPLCEval: false }); // Ogmios evaluator for PlutusV3

  return c.json({ unsignedTx: tx.toCBOR() });
});

// ── Static files ──────────────────────────────────────────────────────────────

// Resolve public/ relative to THIS source file so the server keeps working
// no matter what the current working directory is (run.bat, Explorer
// double-click, systemd, etc.).
const PUBLIC_ROOT = new URL("../../public", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ADMIN_HTML_PATH = new URL("../../public/admin.html", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1");

app.get("/admin", async (c) => {
  const html = await Deno.readTextFile(ADMIN_HTML_PATH);
  return c.html(html);
});

app.get("/*", async (c) => {
  // serveDir returns a fresh Response that bypasses Hono's response
  // assembly, so the security-headers middleware can't stamp it. Wrap
  // the response and copy the CSP/etc. headers onto it directly.
  const resp = await serveDir(c.req.raw, {
    fsRoot: PUBLIC_ROOT,
    urlRoot: "",
    quiet: true,
  });
  const h = new Headers(resp.headers);
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  return new Response(resp.body, { status: resp.status, headers: h });
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Start ─────────────────────────────────────────────────────────────────────

// Derive contract address from the validator + current network.
const _lucidForStartup = await getLucid();
const CONTRACT_ADDR = contractAddress(_lucidForStartup);

// HOSTNAME is defined near the top of the file (before IS_PROD derivation).
// Bind to loopback by default — public-interface binding enables LAN access
// to admin/tx endpoints on shared networks. Override with EVENTCHAIN_HOST=0.0.0.0
// behind a proper reverse proxy + HTTPS when deploying publicly.
const PORT = Number(Deno.env.get("EVENTCHAIN_PORT") ?? 8000);

// Pass Deno's ConnInfo into Hono as `c.env` so the rate limiter can key on
// the real socket peer (see clientIp).
Deno.serve({ port: PORT, hostname: HOSTNAME }, (req, info) =>
  app.fetch(req, { remoteAddr: info.remoteAddr })
);
console.log(`EventChain server running on http://${HOSTNAME}:${PORT}`);
console.log("Mode:            ", IS_PROD ? "PROD (strict)" : "DEV (verbose errors, debug routes)");
console.log("Network:         ", NETWORK);
console.log("Contract address:", CONTRACT_ADDR);
console.log("Oracle address:  ", ORACLE_ADDRESS);
console.log("Treasury address:", TREASURY_ADDRESS);
console.log("Fee:              ", `${FEE_BPS / 100}% of losers' pool`);

// Fire-and-forget heartbeat to the modlog webhook. Confirms the webhook pipe
// is alive on every boot, doubles as a passive "restart count" log.
notify.serverStarted({ host: HOSTNAME, port: PORT, network: NETWORK });

// ── Background sweep for pending status flips ────────────────────────────────
// Resolve/refund txs take time to confirm on-chain (resolve: 3 blocks = ~60s)
// and Koios has its own indexing lag for contract scans (refund). The admin
// UI retries on every page load, but nobody should have to babysit the tab —
// a market that resolves at 3am should flip to "resolved" in markets.json
// without a human refresh. This sweep runs every 60s and attempts the same
// flip logic the HTTP endpoints use, skipping anything that isn't ready.
//
// Safety properties:
//   • Non-reentrant: `sweepInFlight` prevents overlapping runs when Koios is
//     slow enough that one sweep outlives the interval.
//   • Fail-isolated: per-market try/catch keeps one bad market from killing
//     the sweep; top-level try/catch keeps the interval alive through any
//     surprise (Koios 502, lucid init hiccup, fs error, etc.).
//   • Race-safe: the lock-held flip guards on `status === "open"`, so a
//     concurrent HTTP call from the admin UI and this sweep can't double-
//     flip or double-notify. The snapshot-then-notify pattern ensures the
//     Discord announce fires exactly once per real flip.
//   • Cheap early-exit: if no markets have pending flags, the sweep does a
//     single `loadMarkets()` and returns.

const SWEEP_INTERVAL_MS = 60_000;
let sweepInFlight = false;

async function sweepPendingStatus(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const markets = await loadMarkets();
    const pendingResolves = markets.filter(
      (m) => m.status === "open" && typeof m.pendingResolveTxHash === "string",
    );
    const pendingRefunds = markets.filter(
      (m) => m.status === "open" && m.pendingRefunded === true,
    );
    if (pendingResolves.length === 0 && pendingRefunds.length === 0) return;

    for (const m of pendingResolves) {
      try {
        await trySweepResolve(m.id, m.pendingResolveTxHash!, m.pendingResolveSetAt);
      } catch (e) {
        console.warn(
          `[sweep] resolve retry failed for ${m.id}:`,
          (e as Error)?.message ?? e,
        );
      }
    }
    for (const m of pendingRefunds) {
      try {
        await trySweepRefund(m.id);
      } catch (e) {
        console.warn(
          `[sweep] refund retry failed for ${m.id}:`,
          (e as Error)?.message ?? e,
        );
      }
    }
  } catch (e) {
    console.warn("[sweep] top-level error:", (e as Error)?.message ?? e);
  } finally {
    sweepInFlight = false;
  }
}

// How long we'll keep a pendingResolveTxHash around with no trace of the tx
// on-chain before assuming it's gone for good (dropped from mempool, bad
// hash submitted, phase-2 reject). 6 hours is well past realistic mainnet
// propagation + confirmation time (<1h in practice), so clearing the flag
// here cannot race a late confirmation in any scenario the operator would
// actually see. Worst case on a late confirm: force-refund becomes
// available, admin might try it, the refund tx would fail on stale inputs
// if resolve unexpectedly landed — no fund loss, just admin confusion.
const PENDING_RESOLVE_EXPIRY_MS = 6 * 60 * 60 * 1000;

// Mirrors POST /api/admin/markets/:id/mark-resolved minus auth/HTTP. Only
// flips when the resolve tx has ≥3 confirmations, exactly like the handler.
async function trySweepResolve(
  id: string,
  txHash: string,
  setAt: number | undefined,
): Promise<void> {
  const verifyResp = await koiosPost("/tx_status", { _tx_hashes: [txHash] });
  if (!verifyResp.ok) return; // Koios hiccup — try next tick.
  const statusRows = await verifyResp.json().catch(() => []);
  const txRow = Array.isArray(statusRows)
    ? statusRows.find(
      (r: { tx_hash?: string; num_confirmations?: number | null }) =>
        r.tx_hash === txHash,
    )
    : null;
  if (!txRow) {
    // M1: if the tx has been pending for longer than expiry and Koios still
    // has no record of it, assume it's gone (dropped from mempool, bad hash,
    // phase-2 fail) and clear the pending-resolve flag so force-refund is
    // unblocked. Only runs when setAt is known; older markets without the
    // timestamp retain the previous never-expire behaviour.
    if (typeof setAt === "number" && Number.isFinite(setAt)) {
      const age = Date.now() - setAt;
      if (age > PENDING_RESOLVE_EXPIRY_MS) {
        await withMarketsLock(async (markets) => {
          const m = markets.find((x) => x.id === id);
          if (!m) return;
          // Re-check under lock: don't clear if status already flipped or if
          // another sweep/handler swapped the hash for a new attempt.
          if (m.status !== "open") return;
          if (m.pendingResolveTxHash !== txHash) return;
          delete m.pendingResolveTxHash;
          delete m.pendingResolveSetAt;
          delete m.pendingResolveSummary;
          await saveMarkets(markets);
          console.warn(
            `[sweep] cleared stale pending-resolve for ${id} after ${
              Math.round(age / 60000)
            }m with no on-chain trace of tx ${txHash}`,
          );
        });
      }
    }
    return; // tx not propagated yet (or just cleared as stale).
  }
  const confs = Number(txRow.num_confirmations ?? 0);
  if (!Number.isFinite(confs) || confs < 3) return;

  let resolvedSnapshot:
    | { title: string; summary: NonNullable<Market["pendingResolveSummary"]> }
    | null = null;
  await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return;
    if (m.status !== "open") return; // raced by HTTP handler or prior sweep.
    if (m.pendingResolveSummary) {
      resolvedSnapshot = { title: m.title, summary: m.pendingResolveSummary };
    }
    m.status = "resolved";
    m.resolutionUtxoRef = `${txHash}#resolution`;
    delete m.pendingResolveTxHash;
    delete m.pendingResolveSetAt;
    delete m.pendingResolveSummary;
    await saveMarkets(markets);
  });
  if (resolvedSnapshot) {
    const snap = resolvedSnapshot as {
      title: string;
      summary: NonNullable<Market["pendingResolveSummary"]>;
    };
    const toEct = (b: number) => b / 1_000_000;
    const winnerPool = snap.summary.winnerSide === "Yes"
      ? snap.summary.totalYes
      : snap.summary.totalNo;
    notify.marketResolved({
      title: snap.title,
      winnerSide: snap.summary.winnerSide,
      totalDistributedEct: toEct(winnerPool + snap.summary.distributionPool),
      winnerPoolEct: toEct(winnerPool),
      distributionEct: toEct(snap.summary.distributionPool),
    });
    const loserPool = snap.summary.winnerSide === "Yes"
      ? snap.summary.totalNo
      : snap.summary.totalYes;
    notify.treasuryIn({
      marketTitle: snap.title,
      feeEct: toEct(snap.summary.fee),
      loserPoolEct: toEct(loserPool),
    });
    console.log(`[sweep] market ${id} flipped open→resolved`);
  }
}

// Mirrors POST /api/admin/markets/:id/mark-refunded minus auth/HTTP. Only
// flips when no Bet UTxOs for this market remain at the contract address.
async function trySweepRefund(id: string): Promise<void> {
  const lucid = await getLucid();
  const contractAddr = contractAddress(lucid);
  const marketIdHex = bytesToHex(new TextEncoder().encode(id));
  const allContractUtxos = await fetchUtxos(contractAddr);
  for (const u of allContractUtxos) {
    if (!u.datum) continue;
    try {
      const d = Data.from(u.datum, EventDatumSchema);
      if ("Bet" in d && (d.Bet[0].market_id as string) === marketIdHex) {
        return; // bets still present — wait for next tick.
      }
    } catch {
      // skip non-Bet UTxOs
    }
  }

  let refundedSnapshot:
    | { title: string; summary?: NonNullable<Market["pendingRefundedSummary"]> }
    | null = null;
  await withMarketsLock(async (markets) => {
    const m = markets.find((x) => x.id === id);
    if (!m) return;
    if (m.status !== "open") return; // raced by HTTP handler or prior sweep.
    refundedSnapshot = { title: m.title, summary: m.pendingRefundedSummary };
    m.status = "refunded";
    delete m.pendingRefunded;
    delete m.pendingRefundedSummary;
    // Same defensive cleanup as the HTTP handler — see comment there.
    delete m.pendingResolveTxHash;
    delete m.pendingResolveSetAt;
    delete m.pendingResolveSummary;
    await saveMarkets(markets);
  });
  if (refundedSnapshot) {
    const snap = refundedSnapshot as {
      title: string;
      summary?: NonNullable<Market["pendingRefundedSummary"]>;
    };
    notify.marketRefunded({
      title: snap.title,
      betCount: snap.summary?.betCount ?? 0,
      totalEct: (snap.summary?.totalEct ?? 0) / 1_000_000,
    });
    console.log(`[sweep] market ${id} flipped open→refunded`);
  }
}

setInterval(sweepPendingStatus, SWEEP_INTERVAL_MS);
