// Estimated USD cost of a session. Preferred source is Claude Code's own total (the cost-state entry in
// the main transcript, the same figure /usage shows; it already covers sub-agents and calls that never
// become assistant entries). When that's missing, stale (a live session that logged usage after it) or
// inherited (a transcript copied from another session),
// fall back to computing it: token usage from every transcript (main + all sub-agents, finished or not,
// since they're all billed) × Anthropic first-party API list prices, which runs a few % low. Either way
// it's a list-price estimate and won't match a subscription plan's billing (Pro/Max aren't per-token).

import { report } from './diagnostics.js';
import { MAIN, type SessionTranscripts } from './subagents.js';
import type { UsageRecord } from './transcripts.js';

interface Rate {
  input: number; // $ per 1M tokens
  output: number;
  cacheRead?: number; // default 0.1 × input
  fast?: { input: number; output: number }; // speed: "fast"
}

// Cache writes: 1.25 × input (5-minute TTL), 2 × input (1-hour TTL).
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;
const WEB_SEARCH_USD = 10 / 1000;

// Matched by prefix against the model id, first match wins, so more specific prefixes go first.
const RATES: [prefix: string, rate: Rate][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-5', { input: 5, output: 25, fast: { input: 10, output: 50 } }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 15, output: 75 }], // Opus 4 / 4.1
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }], // Sonnet 4 / 4.5 / 4.6
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25 }],
];

// "us.anthropic.claude-opus-5", "claude-opus-5[1m]", "claude-haiku-4-5-20251001" -> matchable id
const normalize = (model: string): string => {
  const i = model.indexOf('claude-');
  return (i >= 0 ? model.slice(i) : model).replace(/\[.*\]$/, '').toLowerCase();
};

const rateFor = (model: string): Rate | null => {
  const id = normalize(model);
  return RATES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? null;
};

function costOf(u: UsageRecord, rate: Rate): number {
  const input = u.fast && rate.fast ? rate.fast.input : rate.input;
  const output = u.fast && rate.fast ? rate.fast.output : rate.output;
  const cacheRead = rate.cacheRead ?? input * CACHE_READ;
  return (
    (u.input * input +
      u.cacheWrite5m * input * CACHE_WRITE_5M +
      u.cacheWrite1h * input * CACHE_WRITE_1H +
      u.cacheRead * cacheRead +
      u.output * output) /
      1_000_000 +
    u.webSearches * WEB_SEARCH_USD
  );
}

export interface SessionCost {
  usd: number;
  unpricedModels: string[]; // models seen but missing from RATES (their tokens aren't in usd)
}

export function sessionCost({ indexes }: SessionTranscripts): SessionCost {
  const main = indexes.get(MAIN);
  // A copied transcript carries its source's cost-state too, so its reported total includes the source's
  // spend; only the computed figure (which skips copied responses) is this session's own.
  if (main?.reportedCost != null && !main.usageAfterReport && !main.copied) {
    return { usd: main.reportedCost, unpricedModels: [] };
  }

  let usd = 0;
  const unpriced = new Set<string>();
  for (const idx of indexes.values()) {
    for (const u of idx.usage.values()) {
      const rate = rateFor(u.model);
      if (rate) usd += costOf(u, rate);
      else if (!unpriced.has(u.model)) {
        unpriced.add(u.model);
        report({
          code: 'MODEL_UNPRICED',
          severity: 'warn',
          message: `model ${u.model} has no entry in the RATES table (a new model?)`,
          where: 'server/cost.ts RATES',
          expected: 'a [prefix, { input, output }] entry matching the model id (list prices in $ per 1M tokens)',
          actual: `normalized id: ${normalize(u.model)}`,
          fallback: "its tokens are left out of cost.usd and the model is listed in cost.unpricedModels (context.ts LIMITS may need it too)",
          affects: ['GET /fetch-single-session/:id → cost.usd (low), cost.unpricedModels'],
          dedupeKey: `MODEL_UNPRICED|${u.model}`,
        });
      }
    }
  }
  return { usd, unpricedModels: [...unpriced] };
}
