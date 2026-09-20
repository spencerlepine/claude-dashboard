// Token usage for a session: the parent transcript and every sub-agent transcript counted separately,
// plus a reduce over both for the session total.
//
// Same source as cost.ts (the usage records in each transcript index), but counting tokens instead of
// pricing them, so models missing from the rate table still contribute.

import { MAIN, type SessionTranscripts } from './subagents.js';
import type { FileIndex, UsageRecord } from './transcripts.js';

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number; // new tokens: input + cacheWrite + output (cacheRead left out, see add)
}

const empty = (): TokenCounts => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });

// Every request re-sends the whole conversation, and the cached part comes back as cacheRead on each
// turn, so summing it counts the same history once per turn (~95% of a long session's raw sum). The
// total counts each token once: when it's first sent (input, or cacheWrite) and when it's generated.
function add(acc: TokenCounts, u: UsageRecord): void {
  const cacheWrite = u.cacheWrite5m + u.cacheWrite1h;
  acc.input += u.input;
  acc.output += u.output;
  acc.cacheWrite += cacheWrite;
  acc.cacheRead += u.cacheRead;
  acc.total += u.input + u.output + cacheWrite;
}

function transcriptTokens(idx: FileIndex): TokenCounts {
  const counts = empty();
  for (const u of idx.usage.values()) add(counts, u);
  return counts;
}

// The parent agent's own transcript, excluding anything a sub-agent spent.
export function mainTokens({ indexes }: SessionTranscripts): TokenCounts {
  const main = indexes.get(MAIN);
  return main ? transcriptTokens(main) : empty();
}

// One entry per sub-agent, keyed by agentId. Sub-agent transcripts sit flat on disk however deeply the
// spawns nest (see subagents.ts), so this covers the whole tree at any depth. Each entry is that agent
// alone, not its descendants — roll them up through SubagentNode.children when that's what's wanted.
export function subagentTokens({ indexes }: SessionTranscripts): Record<string, TokenCounts> {
  const perAgent: Record<string, TokenCounts> = {};
  for (const [key, idx] of indexes) {
    if (key !== MAIN) perAgent[key] = transcriptTokens(idx);
  }
  return perAgent;
}

export interface SessionTokens {
  total: number; // main + every sub-agent; the only figure the dashboard renders today
  main: TokenCounts;
  subagents: Record<string, TokenCounts>;
}

export function sessionTokens(transcripts: SessionTranscripts): SessionTokens {
  const main = mainTokens(transcripts);
  const subagents = subagentTokens(transcripts);
  const total = Object.values(subagents).reduce((sum, t) => sum + t.total, main.total);
  return { total, main, subagents };
}
