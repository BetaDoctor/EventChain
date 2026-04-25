import {
  Network,
  SpendingValidator,
} from "@lucid-evolution/lucid";

// ── Env loader ────────────────────────────────────────────────────────────────
// Every personal / deployment-specific value lives in `.env` at the project
// root. This module fails loudly if anything is missing — we refuse to boot
// with a half-configured contract layer rather than silently default to
// someone else's oracle/treasury/token.

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var: ${name}. ` +
      `Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

// ── Plutus blueprint ──────────────────────────────────────────────────────────

const blueprintPath = new URL(
  "../../contracts/plutus.json",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, "$1"); // fix Windows path

const blueprint = JSON.parse(await Deno.readTextFile(blueprintPath));

const validatorEntry = blueprint.validators.find(
  (v: { title: string }) => v.title === "event_chain.event_chain.spend",
);

if (!validatorEntry) {
  throw new Error("event_chain.event_chain.spend not found in plutus.json");
}

// Pinned script hash — asserting this at startup prevents a silent validator
// swap from a fumbled `aiken build` or a tampered plutus.json. If the hash
// doesn't match, the server refuses to start rather than loading a different
// validator (which would strand all UTxOs at the old contract address).
// UPDATE THIS in .env after every intentional `aiken build` by copying the new
// `hash` field out of plutus.json.
export const EXPECTED_SCRIPT_HASH = requireEnv("EVENTCHAIN_SCRIPT_HASH");

if (validatorEntry.hash !== EXPECTED_SCRIPT_HASH) {
  throw new Error(
    `plutus.json script hash mismatch! expected=${EXPECTED_SCRIPT_HASH} ` +
    `got=${validatorEntry.hash}. Did aiken build change the validator? ` +
    `If intentional, update EVENTCHAIN_SCRIPT_HASH in .env.`,
  );
}

export const eventChainValidator: SpendingValidator = {
  type: "PlutusV3",
  script: validatorEntry.compiledCode,
};

// ── Network ───────────────────────────────────────────────────────────────────

const _net = requireEnv("EVENTCHAIN_NETWORK");
if (_net !== "Mainnet" && _net !== "Preprod" && _net !== "Preview" && _net !== "Custom") {
  throw new Error(
    `EVENTCHAIN_NETWORK must be one of Mainnet|Preprod|Preview|Custom, got: ${_net}`,
  );
}
export const NETWORK: Network = _net as Network;

// ── Koios API endpoint ───────────────────────────────────────────────────────

export const KOIOS_URL = requireEnv("EVENTCHAIN_KOIOS_URL");

// ── Public site URL (used in Discord announcements) ──────────────────────────

export const PUBLIC_URL = requireEnv("EVENTCHAIN_PUBLIC_URL");

// ── ECT unit (policyId + assetName hex, no separator) ────────────────────────

export const ECT_UNIT = requireEnv("EVENTCHAIN_ECT_UNIT");

// ── Oracle / Admin ────────────────────────────────────────────────────────────
// The one and only wallet allowed to resolve markets and manage the admin panel.
// MUST match the oracle_vkh constant hardcoded in event_chain.ak — if you
// change the wallet you also have to rebuild the validator.
export const ORACLE_ADDRESS = requireEnv("EVENTCHAIN_ORACLE_ADDRESS");
export const ORACLE_VKH = requireEnv("EVENTCHAIN_ORACLE_VKH");

// ── Treasury / Fee ────────────────────────────────────────────────────────────
// House takes this cut off the losers' pool at resolution time.
// Dedicated treasury wallet (separate seed from the oracle) — this is the
// wallet that cashes out fee revenue on Minswap. MUST match treasury_vkh
// hardcoded in event_chain.ak.
export const TREASURY_ADDRESS = requireEnv("EVENTCHAIN_TREASURY_ADDRESS");

// Fee is NOT read from env — it's baked into the compiled validator as
// `fee_bps = 300`. Changing it here without rebuilding the contract would
// desync server and validator and every resolve tx would fail. Leave it
// hardcoded; if you ever change the fee, bump both this constant AND the
// Aiken source, then redeploy.
export const FEE_BPS = 300; // 3% = 300 basis points

// Refund grace period — matches `refund_grace_ms` hardcoded in event_chain.ak.
// Bettors cannot self-refund until `bet.deadline + REFUND_GRACE_MS`. During
// the grace window the oracle has an exclusive chance to resolve (or to
// ForceRefund if the market needs to be unwound). Changing this value
// requires a validator rebuild + redeploy.
export const REFUND_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
