// _cost-logger.mjs
// Lightweight cost/usage logger for Netlify functions. Writes one row per
// invocation to the shared Supabase `function_invocations` table.
//
// Naming convention: underscore prefix tells Netlify this is a helper, not
// a deployable function endpoint.
//
// Two log signals on every row:
//   1. Netlify compute (duration_ms + estimated_credits).
//   2. Anthropic API spend (metadata.anthropic = { input_tokens,
//      output_tokens, model, cost_usd, ... }) when the handler calls
//      recordAnthropic() after any Anthropic .messages.create() response.
//
// Required env vars (set at the Netlify team level for every site):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Safety: this helper never throws. If Supabase is down or env vars are
// missing, it logs a warning and moves on. Cost tracking must never break
// the underlying function.

import { AsyncLocalStorage } from 'node:async_hooks';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Netlify Functions default Lambda memory: 1024 MB.
// If a repo sets a different size in netlify.toml, pass `memory_mb` explicitly
// when calling logInvocation, or update this constant in a per-repo wrapper.
const DEFAULT_MEMORY_MB = 1024;

// Netlify bills function compute at 10 credits per GB-HOUR, not per GB-second.
// This used to record raw GB-seconds and call them credits, which overstated
// compute by 3600/10 = 360x and made function runtime look like the thing
// eating the monthly allowance. It isn't: production deploys (15 credits each)
// are the real driver. Keep the unit honest so the dashboard stays trustworthy.
//   estimated_credits = GB-hours * 10
const CREDITS_PER_GB_HOUR = 10;

function calcCredits(durationMs, memoryMb = DEFAULT_MEMORY_MB) {
  const gbHours = (memoryMb / 1024) * (durationMs / 1000 / 3600);
  return gbHours * CREDITS_PER_GB_HOUR;
}

// ---------- Anthropic pricing ----------
//
// Per-million-token rates in USD. Updated 2026-01. Sourced from the public
// Anthropic pricing page. Update here when rates change; this is the single
// source of truth for token-cost math across every function.
//
// Matched longest-prefix-first. Add new model IDs at the top of the list as
// they ship so they beat the family fallback.
const ANTHROPIC_PRICING = [
  // Verified against Anthropic's published per-MTok pricing, 2026-08-23.
  // Order matters: first regex that matches wins, so specific rows come first.
  // When a new model ships, add a row. Anything unmatched is priced by
  // FALLBACK_PRICING and says so in the log rather than failing quietly.
  { match: /^claude-fable-5/,          input: 10.00, output: 50.00 },
  { match: /^claude-mythos-5/,         input: 10.00, output: 50.00 },
  { match: /^claude-opus-5/,           input:  5.00, output: 25.00 },
  { match: /^claude-opus-4-[678]/,     input:  5.00, output: 25.00 },
  // claude-opus-4-5 is deliberately absent: its rate is not in the reference
  // used here, and a guess would be silently wrong. It falls through, flagged.
  { match: /^claude-opus-4/,           input: 15.00, output: 75.00 },
  { match: /^claude-3-opus/,           input: 15.00, output: 75.00 },
  { match: /^claude-sonnet-5/,         input:  3.00, output: 15.00 },
  { match: /^claude-sonnet-4/,         input:  3.00, output: 15.00 },
  { match: /^claude-3-7-sonnet/,       input:  3.00, output: 15.00 },
  { match: /^claude-3-5-sonnet/,       input:  3.00, output: 15.00 },
  { match: /^claude-3-sonnet/,         input:  3.00, output: 15.00 },
  { match: /^claude-haiku-4/,          input:  1.00, output:  5.00 },
  { match: /^claude-3-5-haiku/,        input:  0.80, output:  4.00 },
  { match: /^claude-3-haiku/,          input:  0.25, output:  1.25 },
];

// Default if model unrecognised: assume Sonnet rates so we never silently
// undercount on a new model id.
const FALLBACK_PRICING = { input: 3.00, output: 15.00 };

// Cache multipliers per Anthropic docs.
const CACHE_WRITE_MULTIPLIER = 1.25;   // cache_creation_input_tokens
const CACHE_READ_MULTIPLIER  = 0.10;   // cache_read_input_tokens

function rateFor(model) {
  if (!model) return FALLBACK_PRICING;
  for (const r of ANTHROPIC_PRICING) {
    if (r.match.test(model)) return { input: r.input, output: r.output };
  }
  // A model with no row is priced at the Sonnet fallback, which understates an
  // Opus or Fable model badly. Say so loudly rather than file a wrong number.
  console.warn('[cost-logger] no price row for model "' + model + '", using fallback rate. Add it to ANTHROPIC_PRICING.');
  return FALLBACK_PRICING;
}

// Given a usage block and model id, compute USD cost.
// usage = { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
//
// The three input buckets are mutually exclusive in the Anthropic response:
// input_tokens counts ONLY the uncached tokens, and never includes the
// cache_creation / cache_read counts. Add them, never subtract.
export function computeAnthropicCost(usage, model) {
  if (!usage) return 0;
  const rate = rateFor(model);
  const fresh   = usage.input_tokens || 0;
  const write   = usage.cache_creation_input_tokens || 0;
  const read    = usage.cache_read_input_tokens || 0;
  const output  = usage.output_tokens || 0;
  const inputCost  = (fresh * rate.input
                    + write * rate.input * CACHE_WRITE_MULTIPLIER
                    + read  * rate.input * CACHE_READ_MULTIPLIER) / 1e6;
  const outputCost = (output * rate.output) / 1e6;
  return inputCost + outputCost;
}

// ---------- AsyncLocalStorage for per-invocation Anthropic accumulation ----
//
// Handlers wrapped by wrapHandler() run inside an ALS context. They call
// recordAnthropic() after each Anthropic response and we accumulate token
// counts + cost. When wrapHandler logs at the end, it reads the totals out
// of ALS and attaches them to metadata.anthropic.
//
// Handlers that don't use wrapHandler can call logInvocation() directly
// and pass metadata.anthropic themselves.
const als = new AsyncLocalStorage();

// Public. Call this after every Anthropic API response.
//   recordAnthropic(response);
// or, if you only have raw usage + model:
//   recordAnthropic({ usage, model });
export function recordAnthropic(arg) {
  const store = als.getStore();
  if (!store) return; // not inside a wrapped handler; silently no-op
  if (!arg) return;

  // Accept either a full Anthropic response or { usage, model }.
  const usage = arg.usage || (arg.message && arg.message.usage) || null;
  const model = arg.model || (arg.message && arg.message.model) || null;
  if (!usage) return;

  store.anthropic.calls += 1;
  store.anthropic.input_tokens           += usage.input_tokens           || 0;
  store.anthropic.output_tokens          += usage.output_tokens          || 0;
  store.anthropic.cache_creation_tokens  += usage.cache_creation_input_tokens || 0;
  store.anthropic.cache_read_tokens      += usage.cache_read_input_tokens     || 0;
  store.anthropic.cost_usd               += computeAnthropicCost(usage, model);
  // Last model wins for the per-row "model" field. Most handlers only call
  // one model, so this is fine. If a handler fans out across models, the
  // totals still add correctly; only the displayed model id is approximate.
  if (model) store.anthropic.model = model;
}

// Public. Attributes the current invocation to a coach/workspace once the
// handler has parsed its body. wrapHandler builds the row in a `finally`, so
// anything set here lands on the row even when the handler throws.
//
//   setInvocationContext({ workspace_id, user_id, metadata });
//
// Without this, the rows that carry the Anthropic spend have no coach on them
// and per-coach cost cannot be worked out after the fact.
export function setInvocationContext(fields) {
  const store = als.getStore();
  if (!store || !fields) return;
  if (fields.workspace_id) store.ctx.workspace_id = fields.workspace_id;
  if (fields.user_id) store.ctx.user_id = fields.user_id;
  if (fields.metadata) Object.assign(store.ctx.metadata, fields.metadata);
}

function newStore() {
  return {
    ctx: {
      workspace_id: null,
      user_id: null,
      metadata: {},
    },
    anthropic: {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      model: null,
    },
  };
}

// ---------- Public API ----------

export function startTimer() {
  return { start: Date.now() };
}

// Convenience wrapper. Use when you just want to log the full handler
// duration and don't need request-specific fields (workspace_id, user_id,
// custom metadata). For richer logging (like slack-events extracting team
// and user from the payload), call logInvocation directly.
//
// Usage:
//   const _handler = async (req, context) => { ...existing handler... };
//   export default wrapHandler(_handler, {
//     project: 'alli-dm-coach',
//     function_name: 'dm-coach',
//   });
//
// Inside the handler, call recordAnthropic(response) after each
// Anthropic API call to attach token/cost data automatically.
export function wrapHandler(handler, options) {
  return async (...args) => {
    const store = newStore();
    return await als.run(store, async () => {
      const timer = startTimer();
      let statusCode = 200;
      let res;
      try {
        res = await handler(...args);
        statusCode = (res && res.status) || 200;
        return res;
      } catch (err) {
        statusCode = 500;
        throw err;
      } finally {
        const metadata = { ...(options.metadata || {}), ...store.ctx.metadata };
        if (store.anthropic.calls > 0) {
          metadata.anthropic = {
            calls: store.anthropic.calls,
            input_tokens: store.anthropic.input_tokens,
            output_tokens: store.anthropic.output_tokens,
            cache_creation_tokens: store.anthropic.cache_creation_tokens,
            cache_read_tokens: store.anthropic.cache_read_tokens,
            cost_usd: Number(store.anthropic.cost_usd.toFixed(6)),
            model: store.anthropic.model,
          };
        }
        await logInvocation({
          ...options,
          workspace_id: store.ctx.workspace_id || options.workspace_id || null,
          user_id: store.ctx.user_id || options.user_id || null,
          status_code: statusCode,
          metadata,
        }, timer);
      }
    });
  };
}

export async function logInvocation(fields, timer) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.warn('[cost-logger] SUPABASE env vars missing, skipping log');
      return;
    }

    const durationMs = timer ? Date.now() - timer.start : 0;
    const memoryMb = fields.memory_mb || DEFAULT_MEMORY_MB;
    const estimatedCredits = calcCredits(durationMs, memoryMb);

    // Merge any ALS-recorded Anthropic totals if the caller didn't supply
    // their own metadata.anthropic. Lets handlers that bypass wrapHandler
    // still benefit from recordAnthropic.
    let metadata = fields.metadata || null;
    const store = als.getStore();
    if (store && store.anthropic.calls > 0
        && (!metadata || !metadata.anthropic)) {
      metadata = {
        ...(metadata || {}),
        anthropic: {
          calls: store.anthropic.calls,
          input_tokens: store.anthropic.input_tokens,
          output_tokens: store.anthropic.output_tokens,
          cache_creation_tokens: store.anthropic.cache_creation_tokens,
          cache_read_tokens: store.anthropic.cache_read_tokens,
          cost_usd: Number(store.anthropic.cost_usd.toFixed(6)),
          model: store.anthropic.model,
        },
      };
    }

    const row = {
      project: fields.project,
      function_name: fields.function_name,
      workspace_id: fields.workspace_id || null,
      user_id: fields.user_id || null,
      duration_ms: durationMs,
      memory_mb: memoryMb,
      estimated_credits: Number(estimatedCredits.toFixed(6)),
      status_code: fields.status_code || null,
      metadata,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/function_invocations`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[cost-logger] supabase ${res.status}: ${errText}`);
    }
  } catch (err) {
    console.warn('[cost-logger] caught error:', err && err.message);
  }
}
