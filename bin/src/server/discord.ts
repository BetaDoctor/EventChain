// ─── Discord webhook notifications ───────────────────────────────────────────
// Thin fire-and-forget layer that posts event summaries to the configured
// Discord channels. Two webhooks:
//   • ANNOUNCE  → #announcements  (public-facing: new markets, resolutions)
//   • MODLOG    → #admin-log      (private ops: treasury, errors, admin actions)
//
// Design rules:
//   1. Never throw. A Discord outage, a bad URL, a 429 — none of it can break
//      a tx-building handler. Every call is wrapped in try/catch + logged.
//   2. Never `await` a post from inside a user-facing request handler. Always
//      fire-and-forget: call `notify.x(...)` without awaiting so the HTTP
//      response doesn't depend on Discord's latency.
//   3. Never log the webhook URL. Treat it like a password.
//   4. If the env var is missing, every notify call is a silent no-op — lets
//      devs run the server locally without Discord spam.

import { PUBLIC_URL } from "./contract.ts";

const ANNOUNCE_URL = Deno.env.get("DISCORD_ANNOUNCE_WEBHOOK");
const MODLOG_URL = Deno.env.get("DISCORD_MODLOG_WEBHOOK");
const ADMIN_URL = Deno.env.get("DISCORD_ADMIN_WEBHOOK");
const AUDIT_URL = Deno.env.get("DISCORD_AUDIT_WEBHOOK");

// Low-level poster. Never throws.
async function post(url: string | undefined, content: string): Promise<void> {
  if (!url) return; // no webhook configured → silent no-op
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 2000 char limit on Discord messages; cap defensively.
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
    if (!resp.ok) {
      // Don't log `url` — it's a secret. Log just the channel hint.
      console.warn(
        `[discord] POST failed: status=${resp.status} len=${content.length}`,
      );
    }
  } catch (e) {
    console.warn("[discord] post errored:", (e as Error)?.message ?? e);
  }
}

// Format an ISO timestamp into something readable for announcements.
function fmtDeadline(deadlineMs: number): string {
  const d = new Date(deadlineMs);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// ─── Public API ──────────────────────────────────────────────────────────────
// Each function: fire-and-forget, returns void synchronously from the caller's
// perspective. Internally we don't await the post() either — caller should
// still ignore the returned Promise.

export const notify = {
  /** New market published (goes live for trading). → #announcements */
  marketPublished(m: {
    id: string;
    title: string;
    category: string;
    deadline: number;
  }): void {
    const msg =
      `🎲 **New market: ${m.title}**\n` +
      `Category: ${m.category}\n` +
      `Closes: ${fmtDeadline(m.deadline)}\n` +
      `Trade → ${PUBLIC_URL}`;
    void post(ANNOUNCE_URL, msg);
  },

  /** Market resolved — winners can claim their payout. → #announcements */
  marketResolved(args: {
    title: string;
    winnerSide: "Yes" | "No";
    // All amounts in DISPLAY ECT (not base units).
    totalDistributedEct: number;
    winnerPoolEct: number;   // total stake on the winning side
    distributionEct: number; // = losers' pool × 0.97 (what gets paid out on top of stakes)
  }): void {
    // Payout % = how much extra winners get on top of their original stake.
    // e.g. winnerPool=75, distribution=48.5 → +64.7%
    const pct = args.winnerPoolEct > 0
      ? Math.round((args.distributionEct / args.winnerPoolEct) * 100)
      : 0;
    const side = args.winnerSide === "Yes" ? "YES 🟢" : "NO 🔴";
    const msg =
      `🎰 Market closed: **${args.title}**\n\n` +
      `Winning side: **${side}**\n` +
      `Payout: **+${pct}%** for winners\n` +
      `Total distributed: ${args.totalDistributedEct.toFixed(2)} ECT\n\n` +
      `Winners → Claim now → ${PUBLIC_URL}`;
    void post(ANNOUNCE_URL, msg);
  },

  /** Market refunded by admin (cancelled / unwound). → #announcements */
  marketRefunded(args: {
    title: string;
    betCount: number;
    totalEct: number; // DISPLAY ECT (not base units)
  }): void {
    const msg =
      `🔁 Market cancelled: **${args.title}**\n\n` +
      `All bets have been refunded to their original wallets.\n` +
      `${args.betCount} bet${args.betCount === 1 ? "" : "s"} · ${args.totalEct.toFixed(2)} ECT returned\n\n` +
      `No fee charged. Check your wallet → ${PUBLIC_URL}`;
    void post(ANNOUNCE_URL, msg);
  },

  /**
   * Server-startup heartbeat → #eventchain-site-errors (MODLOG).
   * Fires once on every boot. Serves two purposes:
   *   1. Proves the modlog webhook is alive (no "hope it works when it breaks").
   *   2. Gives a passive log of restarts — if you see 6 in an hour, something's
   *      crashing and auto-restarting.
   * No shutdown counterpart by design: planned shutdowns are already known to
   * you, and crashes don't run handlers, so a shutdown ping would be either
   * redundant or silent. Startup alone is the honest signal.
   */
  /**
   * Treasury fee received → #admin-finances (ADMIN).
   * Fires once per resolve, alongside marketResolved. Owner-eyes-only:
   * reveals revenue numbers that shouldn't be in mod-visible channels.
   * Amounts are in DISPLAY ECT (not base units).
   */
  treasuryIn(args: {
    marketTitle: string;
    feeEct: number;      // 3% of losers' pool
    loserPoolEct: number; // full losers' pool (pre-fee), for context
  }): void {
    const msg =
      `💰 **Treasury +${args.feeEct.toFixed(2)} ECT**\n` +
      `Market: ${args.marketTitle}\n` +
      `Losers' pool: ${args.loserPoolEct.toFixed(2)} ECT (3% fee)`;
    void post(ADMIN_URL, msg);
  },

  /**
   * Admin action audit trail → #admin-log (AUDIT).
   * Fires after a destructive or visibility-changing admin action lands.
   * Skips `publish` (already goes to #announcements) and `create` (drafts
   * aren't interesting until published). `details` is free-form text for
   * context — e.g. "deadline: X → Y" on edits.
   */
  adminAction(args: {
    action: "hide" | "unhide" | "unpublish" | "edit" | "delete";
    marketId: string;
    marketTitle: string;
    details?: string;
  }): void {
    const icon: Record<typeof args.action, string> = {
      hide: "🙈",
      unhide: "👁️",
      unpublish: "📴",
      edit: "✏️",
      delete: "🗑️",
    };
    const msg =
      `${icon[args.action]} **${args.action.toUpperCase()}** — ${args.marketTitle}\n` +
      `ID: \`${args.marketId}\`` +
      (args.details ? `\nDetails: ${args.details}` : "");
    void post(AUDIT_URL, msg);
  },

  serverStarted(info: { host: string; port: number; network: string }): void {
    const msg =
      `🟢 **EventChain server started**\n` +
      `Network: ${info.network}\n` +
      `Listening: http://${info.host}:${info.port}\n` +
      `Boot: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;
    void post(MODLOG_URL, msg);
  },

  /**
   * Server error / upstream outage → #eventchain-site-errors (MODLOG).
   *
   * Rate-limited per error "key" so a burst of the same failure (e.g. Koios
   * down, every request throws) doesn't spam the channel. Key is user-
   * supplied — pass something stable per error-class (e.g. "koios-utxos",
   * "koios-eval", "onError"). First hit posts immediately; repeats within
   * ERROR_COOLDOWN_MS are suppressed but counted; when the cooldown expires
   * the next post includes "(N suppressed)".
   *
   * Never throws. Never awaits. Safe to call from any error path.
   */
  error(args: {
    key: string;         // stable dedupe key, e.g. "koios-utxos"
    title: string;       // short headline, e.g. "Koios /address_utxos failed"
    detail?: string;     // optional extra context (status code, path, message)
  }): void {
    const now = Date.now();
    const state = errorState.get(args.key) ?? { lastSentAt: 0, suppressed: 0 };
    if (now - state.lastSentAt < ERROR_COOLDOWN_MS) {
      state.suppressed++;
      errorState.set(args.key, state);
      return;
    }
    const suffix = state.suppressed > 0
      ? `\n_(${state.suppressed} similar suppressed in last ${Math.round(ERROR_COOLDOWN_MS / 1000)}s)_`
      : "";
    errorState.set(args.key, { lastSentAt: now, suppressed: 0 });
    // Bound the map: if it has grown beyond MAX_ERROR_KEYS, prune entries
    // whose cooldown is already expired (lastSentAt is ancient). Any key
    // that makes it to this point has been quiet long enough that losing
    // its suppressed counter is fine.
    if (errorState.size > MAX_ERROR_KEYS) {
      const cutoff = now - ERROR_COOLDOWN_MS * 2;
      for (const [k, v] of errorState) {
        if (v.lastSentAt < cutoff) errorState.delete(k);
      }
      // If pruning didn't free enough, drop oldest by insertion order until
      // we're back under cap. Map iteration is insertion-ordered in JS.
      while (errorState.size > MAX_ERROR_KEYS) {
        const oldest = errorState.keys().next().value;
        if (oldest === undefined) break;
        errorState.delete(oldest);
      }
    }
    const detail = args.detail ? `\n\`\`\`\n${args.detail.slice(0, 800)}\n\`\`\`` : "";
    const msg =
      `🔴 **${args.title}**\n` +
      `Key: \`${args.key}\`\n` +
      `Time: ${new Date(now).toISOString().replace("T", " ").slice(0, 19)} UTC` +
      detail +
      suffix;
    void post(MODLOG_URL, msg);
  },
};

// ─── Error rate-limit state ──────────────────────────────────────────────────
// One cooldown per error key. 60s default — tuned for "noisy burst during an
// outage" not "quiet long-term trickle." Adjust if Discord gets too chatty.
const ERROR_COOLDOWN_MS = 60_000;
// Cap to prevent unbounded growth if error keys are ever derived from
// client-influenced strings. 500 is generous — at steady state a well-behaved
// server has <20 distinct error keys.
const MAX_ERROR_KEYS = 500;
const errorState = new Map<string, { lastSentAt: number; suppressed: number }>();
