# EventChain

A pari-mutuel prediction market on Cardano. Users bet a fungible token on binary (yes/no) markets. Winners split the losers' pool pro-rata by stake. The operator takes a 3% house fee on the losers' pool at resolution.

This repo contains the Plutus V3 validator (Aiken), a Deno + Hono backend that builds unsigned transactions, and a vanilla-JS frontend with CIP-30 wallet integration.

---

# Setup

End-to-end, fresh-clone to running server. Plan ~1–2 hours the first time.

## 1. Toolchain

Three CLI binaries are required and not bundled in the repo. Download each, then place them in `bin/` with these exact filenames:

| Tool | Download | Place at |
|---|---|---|
| **Aiken** (Plutus V3 compiler) | https://github.com/aiken-lang/aiken/releases | `bin/aiken.exe` (Windows) or `bin/aiken` |
| **Deno** (server runtime) | https://github.com/denoland/deno/releases | `bin/deno.exe` or `bin/deno` |
| **Tailwind CSS** (standalone CLI) | https://github.com/tailwindlabs/tailwindcss/releases | `bin/tailwindcss.exe` or `bin/tailwindcss` |

Pick the binary matching your OS + arch (e.g. `aiken-x86_64-pc-windows-msvc.zip` for 64-bit Windows). Extract from the archive and rename if needed so the filenames match exactly — the rest of the project assumes these paths.

## 2. Pick a network

Strongly recommended: start on **Preprod** or **Preview** testnet. Only point at Mainnet once you've verified the full flow end-to-end with test funds.

Will be set later in `.env`:

```
EVENTCHAIN_NETWORK=Preprod
EVENTCHAIN_KOIOS_URL=https://preprod.koios.rest/api/v1
```

## 3. Generate oracle + treasury wallets

Use any Cardano wallet software to generate **two separate seed phrases**:

- **Oracle wallet** — signs resolution transactions. Needs a small ADA float (~50 ADA) for fees.
- **Treasury wallet** — receives the 3% fee. Can be cold.

From each wallet you'll need:
- The bech32 address (`addr1…`).
- The payment verification key hash (vkh) — the 28-byte hex of the payment credential.

**Deriving the vkh** from a bech32 address: most wallet tools expose this directly, or use `cardano-cli address info --address <addr>` / a Lucid script:

```js
import { getAddressDetails } from "@lucid-evolution/lucid";
console.log(getAddressDetails("addr1…").paymentCredential.hash);
```

## 4. Pick (or mint) a token

Every bet is denominated in a single fungible token. You can:

- **Use an existing token** — note its policy id and asset name (both hex).
- **Mint your own** — any Cardano minting tutorial works; CIP-68 label 333 prefix (`0014df10`) is the standard for fungibles.

You need:
- 28-byte policy id (hex).
- Asset name (hex; may be empty `""`).
- The concatenated `policyId + assetName` for `EVENTCHAIN_ECT_UNIT` in `.env`.

## 5. Wire the four constants into the validator

Open `bin/contracts/validators/event_chain.ak` and replace the four placeholder constants near the top:

```aiken
const oracle_vkh: VerificationKeyHash = #"<your-oracle-vkh-hex>"
const treasury_vkh: VerificationKeyHash = #"<your-treasury-vkh-hex>"
const ect_policy_id: PolicyId = #"<your-policy-id-hex>"
const ect_asset_name: AssetName = #"<your-asset-name-hex-or-empty>"
```

All four values must match what you'll put in `.env`. Mismatches mean your oracle wallet can't sign resolutions, or users' bets won't pass validation.

## 6. Build the validator

```
bin/aiken.exe build
```

This writes `bin/contracts/plutus.json`. Copy the `hash` field — that's your `EVENTCHAIN_SCRIPT_HASH`. Any change to the four constants above produces a different hash and therefore a different on-chain contract address.

## 7. Fill `.env`

```
cp .env.example .env
```

Edit every field. In particular:

- `EVENTCHAIN_SCRIPT_HASH` — from step 6.
- `EVENTCHAIN_ECT_UNIT` — policy id + asset name concatenated.
- `EVENTCHAIN_ORACLE_ADDRESS`, `EVENTCHAIN_ORACLE_VKH` — from step 3.
- `EVENTCHAIN_TREASURY_ADDRESS` — from step 3.
- `EVENTCHAIN_PUBLIC_URL` — the domain your frontend will be reachable at.
- `DISCORD_*_WEBHOOK` — four webhook URLs (or leave blank to disable Discord).

## 8. Set up Discord (optional)

If you want announcement / ops / admin / audit posts:

1. Create four channels in your Discord server:
   - `#announcements` — public market posts (ANNOUNCE webhook).
   - `#site-errors` — server errors, boot notifications (MODLOG webhook).
   - `#admin-finances` — owner-only treasury movement (ADMIN webhook).
   - `#admin-log` — admin action audit trail (AUDIT webhook).
2. Create a webhook in each channel → copy the URL → paste into the matching `DISCORD_*_WEBHOOK` in `.env`.

See `bin/src/server/discord.ts` for exactly what each webhook posts.

## 9. Seed the admin list

Admin wallets are authorized by address. Check `bin/src/server/mod.ts` for the `ADMIN_*` configuration — set at least one admin wallet to your own address.

## 10. Run

```
run.bat
```

(or on Linux/macOS: replicate the command inside `run.bat` with the platform Deno binary.)

The server binds to `127.0.0.1:8000` by default. Point a reverse proxy (nginx / caddy) at it for public access — do not expose Deno directly.

If using a reverse proxy, set in `.env`:

```
EVENTCHAIN_TRUST_XFF=1
EVENTCHAIN_TRUSTED_PROXY_IP=127.0.0.1
```

(or whatever IP your proxy connects from).

## 11. Verify

Visit `http://127.0.0.1:8000` — landing page should load.

Connect a wallet with test funds. Open the admin panel (only authorized wallets see it) → create a test market → place a small bet → wait past deadline → resolve → claim. If all four flows work without errors, you're live.

## 12. Going to mainnet

Before flipping `EVENTCHAIN_NETWORK=Mainnet`:

- Run through every admin flow on testnet at least once, including edge cases: force-refund, hidden markets, deletion of unpublished drafts.
- Fund the oracle wallet with enough ADA to cover ~0.5 ADA per resolution.
- Set `EVENTCHAIN_PROD=1`.
- Set up a proper reverse proxy with TLS.
- Monitor the `#site-errors` channel for the first few days.

## Backups

`bin/data/markets.json` is the canonical off-chain state (market metadata, deadlines, status flags). Back it up. Loss of this file means loss of all market metadata — bets on chain are still there, but the server can no longer render them without the `marketId → title / deadline / status` mapping.

## Troubleshooting

- **"Address mismatch" on resolve:** oracle vkh in the validator doesn't match the wallet signing the tx. Rebuild the validator with the correct vkh, redeploy.
- **Bet transaction fails with "script validation":** token policy/asset in the validator doesn't match the token being bet. Redeploy with the correct policy.
- **Discord silently not posting:** check `EVENTCHAIN_PROD` is set — in dev mode some webhooks are rate-limited locally. Check the webhook URLs work with a curl ping.
- **Koios rate limits:** consider running your own Cardano node + Koios fork for higher-traffic deployments.

---

# Project details

## Repo layout

- `bin/contracts/validators/event_chain.ak` — the Plutus V3 validator. Handles `Bet`, `Resolve`, `Claim`, `Refund`, `ForceRefund` redeemers with enforced pari-mutuel math and a 30-day oracle-dead escape hatch.
- `bin/contracts/aiken.toml`, `aiken.lock` — Aiken project config, pins stdlib v2.2.0.
- `bin/src/server/` — Deno + Hono backend. Builds unsigned transactions, verifies submissions against Koios, posts to Discord, serves the frontend.
- `bin/src/frontend/` — TypeScript modules used by the public site (wallet connect, tx signing helpers).
- `bin/public/` — landing page, trade UI, admin panel. Vanilla HTML/CSS/JS, CIP-30 wallet connect via `@lucid-evolution`.
- `bin/public/docs/WHITEPAPER.md` — design doc, trust model, audit notes.
- `bin/data/markets.json` — local off-chain state (gitignored at runtime).
- `bin/deno.json` — Deno import map and tasks.
- `.env.example` — environment template; copy to `.env` and fill in.
- `run.bat` — Windows launcher; passes the right flags to `bin/deno.exe`.

The project is designed to be **self-contained inside `bin/`** with no OS-level package dependencies once the three toolchain binaries are in place.

## Mechanic — pari-mutuel payouts

Resolution distributes the **losers' pool** to winners pro-rata by stake, after a flat 3% house fee.

**Worked example.** Market resolves YES. Stakes:
- YES: Alice 100, Bob 400 → winner pool = 500
- NO: Carol 200, Dave 100 → loser pool = 300

Payouts:
- House fee: `300 × 3% = 9 ECT` → treasury
- Distributable: `300 − 9 = 291 ECT`
- Alice: `100 + (100 / 500) × 291 = 158.2 ECT` (+58%)
- Bob: `400 + (400 / 500) × 291 = 632.8 ECT` (+58%)
- Carol & Dave: 0

Every winner on a given side earns the same % return. The validator enforces the math against oracle-declared totals, so the oracle cannot silently overpay specific winners.

## Trust model

The oracle is trusted to:
1. Pick the correct winner.
2. Declare correct YES / NO totals at resolution.

The validator mechanically enforces:
- Each winner's payout matches `stake + (stake / winner_pool) × loser_pool × 0.97`.
- Treasury receives exactly `loser_pool × 0.03`.
- Declared totals equal the sum of all consumed bet UTxOs.

If the oracle disappears (no resolution within 30 days of the market deadline), any bettor can refund their own stake via the `Refund` / `ForceRefund` branches. Funds are never permanently locked.

## Scale ceiling

A single resolution tx consumes every bet UTxO for the market and emits one payout UTxO per winner. This caps a market at **~150 bets** (Cardano tx-size limit, ~16 KB). Beyond that, batched resolution would be needed — not implemented.

## Tech choices

- **Aiken** for the validator. Smaller and more readable than PlutusTx; mature stdlib.
- **Deno + Hono** for the server. No `node_modules` headache, single binary, tiny footprint.
- **Koios** for chain reads. No API key required; swap in Blockfrost if preferred.
- **Lucid-Evolution** for transaction building. CIP-30 wallet integration on the frontend.

## Security

This code has been through six rounds of self-audit. It has not been audited by a third party. Do not deploy with real value before an independent review.

Known trust assumptions and audit history are documented in `bin/public/docs/WHITEPAPER.md`.

---

## License

MIT — see `LICENSE`. No warranty.
