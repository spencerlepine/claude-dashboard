// Context-window usage for a session: how full the main agent's window was after its latest response.
// A snapshot, not a running total — it drops after /compact and only means "now" while the session is
// live; for a completed session it's the window as the session left it.
//
// Claude Code doesn't log the window size, so it's inferred from the model id (see LIMITS).

import { MAIN, type SessionTranscripts } from './subagents.js';

const DEFAULT_LIMIT = 200_000;
const ONE_MILLION = 1_000_000;

// Matched by prefix against the normalized model id, first match wins. Unlisted models get DEFAULT_LIMIT.
const LIMITS: [prefix: string, tokens: number][] = [
  ['claude-fable-5', ONE_MILLION],
  ['claude-mythos-5', ONE_MILLION],
  ['claude-opus-5', ONE_MILLION],
  ['claude-opus-4-8', ONE_MILLION],
  ['claude-opus-4-7', ONE_MILLION],
  ['claude-opus-4-6', ONE_MILLION],
  ['claude-sonnet-5', ONE_MILLION],
  ['claude-sonnet-4-6', ONE_MILLION],
];

export interface ContextWindow {
  model: string;
  used: number;
  limit: number;
  percent: number; // 0-100, one decimal
  at: number | null; // timestamp of the response it was read from
}

function limitFor(model: string, used: number): number {
  if (/\[1m\]$/i.test(model)) return ONE_MILLION;
  const i = model.indexOf('claude-');
  const id = (i >= 0 ? model.slice(i) : model).replace(/\[.*\]$/, '').toLowerCase();
  const limit = LIMITS.find(([prefix]) => id.startsWith(prefix))?.[1] ?? DEFAULT_LIMIT;
  // A prompt bigger than the assumed window proves the window is bigger (e.g. a 1M beta on an older model)
  return used > limit ? ONE_MILLION : limit;
}

// null = the main agent hasn't had a response yet
export function sessionContext({ indexes }: SessionTranscripts): ContextWindow | null {
  const snap = indexes.get(MAIN)?.context;
  if (!snap) return null;
  const limit = limitFor(snap.model, snap.used);
  return {
    model: snap.model,
    used: snap.used,
    limit,
    percent: Math.round((snap.used / limit) * 1000) / 10,
    at: snap.ts,
  };
}
