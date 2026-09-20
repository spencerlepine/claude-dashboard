// Incremental indexer for Claude Code .jsonl transcripts. Transcripts are append-only, so each file
// is parsed once and later calls only read the bytes appended since. The index keeps just the facts
// the dashboard needs (spawned tool calls, tool results, task notifications, cron jobs).

import fs from 'node:fs';
import path from 'node:path';
import { describe, noteClaudeVersion, report, type Issue } from './diagnostics.js';

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  input?: Record<string, unknown>;
  content?: unknown;
}

interface LogEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean; // synthetic user entry (command caveats, skill expansions, queued deliveries)
  content?: unknown; // queue-operation payload
  timestamp?: string;
  version?: string; // Claude Code version that wrote the entry
  turnOrigin?: string;
  origin?: { kind?: string };
  uuid?: string;
  requestId?: string;
  totalCostUSD?: number; // cost-state payload
  message?: { id?: string; model?: string; stop_reason?: string | null; content?: unknown; usage?: Usage };
  toolUseResult?: unknown;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  server_tool_use?: { web_search_requests?: number };
  speed?: string;
}

// Token counts for one API response.
export interface UsageRecord {
  model: string;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  webSearches: number;
  fast: boolean;
}

export interface SpawnInfo {
  description: string | null;
  agentType: string | null;
}

export interface ToolResultInfo {
  ts: number;
  isError: boolean;
  isAsync: boolean; // "Async agent launched" ack, not a real completion
  interrupted: boolean;
  agentId: string | null;
}

export interface Notification {
  status: string;
  ts: number;
}

export interface CronJobRecord {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  humanSchedule: string | null;
  createdAt: number;
}

// How full the agent's context window was after its latest API response: that response's whole prompt
// (fresh + cached input) plus its output, which the next request carries forward.
export interface ContextSnapshot {
  model: string;
  used: number;
  ts: number | null;
}

// What the tail of a transcript says about the agent writing it.
export type TailState = 'active' | 'ended' | 'interrupted' | null;

export interface FileIndex {
  file: string;
  line: number; // 1-based number of the line being indexed, for diagnostics
  version: string | null; // Claude Code version of the latest entry, for diagnostics
  ino: number;
  offset: number;
  leftover: Buffer; // partial last line, completed on the next read
  lastAccess: number;
  subagent: boolean; // agent-<id>.jsonl, a sub-agent's own transcript
  firstTs: number | null;
  lastTs: number | null;
  tail: TailState;
  spawns: Map<string, SpawnInfo>; // tool_use ids issued by this transcript
  toolResults: Map<string, ToolResultInfo>; // keyed by tool_use_id
  notifications: Map<string, Notification>; // keyed by agentId (task-id); latest wins
  cronCalls: Map<string, { name: string; input: Record<string, unknown> }>; // pending Cron* tool_use ids
  cronJobs: Map<string, CronJobRecord>; // keyed by job id
  cronDeletes: Map<string, number>; // job id -> deleted at
  scheduledFires: Map<string, number>; // fired prompt text -> latest fire time
  usage: Map<string, UsageRecord>; // API message id -> usage (one response spans several entries)
  copied: boolean; // holds history copied from another transcript (see recordUsage)
  reportedCost: number | null; // Claude Code's own session total (latest cost-state entry), USD
  usageAfterReport: boolean; // a response was logged after that entry, so reportedCost is stale
  context: ContextSnapshot | null; // latest non-sidechain response
  initialPrompt: string | null; // first prompt, truncated (see recordInitialPrompt)
  initialCommand: string | null; // first slash command, as "/name args"; fallback when no prompt follows
}

const CHUNK_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, FileIndex>();

const parseTs = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

const blocksOf = (content: unknown): ContentBlock[] =>
  Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as ContentBlock[]) : [];

// Flattens string | [{type:'text', text}] into one string.
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n');
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// API fields fed by each kind of fact in the index (see diagnostics.ts, Issue.affects)
const AFFECTS_USAGE = [
  'GET /fetch-single-session/:id → cost, tokens, context',
  'GET /fetch-session-ids?status=completed → sessions (ones under $0.01 are left out, so real sessions may be missing)',
];
const AFFECTS_SUBAGENTS = ['GET /fetch-single-session/:id → subagents[].status, startedAt, lastActivityAt'];
const AFFECTS_JOBS = ['GET /fetch-single-session/:id → scheduledJobs'];
const AFFECTS_PROMPT = ['GET /fetch-single-session/:id → initialPrompt, subagents[].initialPrompt'];

// The transcript entry at idx.line doesn't have the shape this indexer relies on.
function drift(idx: FileIndex, where: string, issue: Omit<Issue, 'severity' | 'where' | 'source' | 'line'>): void {
  report({ severity: 'warn', where: `server/transcripts.ts ${where}`, source: idx.file, line: idx.line, claudeVersion: idx.version, ...issue });
}

// One API response is logged as several entries (one per content block), each repeating the usage, and
// output_tokens grows while streaming. Keyed by message id, the last entry wins = final counts.
//
// A forked or SDK-copied session starts a new transcript that replays the source's history, usage and
// original timestamps included. Those responses were already counted in the source transcript, so a
// response stamped before this transcript's first entry is left out of usage (context still tracks it).
function recordUsage(idx: FileIndex, e: LogEntry, ts: number | null): void {
  const m = e.message;
  const u = m?.usage;
  if (!m || m.model === '<synthetic>') return;
  if (typeof m.model !== 'string' || !u || typeof u !== 'object') {
    drift(idx, 'recordUsage()', {
      code: 'TRANSCRIPT_USAGE_MISSING',
      message: 'assistant entry has no message.model string or no message.usage object',
      expected: 'message.model: string, message.usage: { input_tokens, output_tokens, cache_read_input_tokens, ... }',
      actual: `message.model: ${describe(m.model)}; message.usage: ${describe(u)}; message keys: [${Object.keys(m).join(', ')}]`,
      sample: e,
      fallback: 'this response is left out of cost, tokens and context',
      affects: AFFECTS_USAGE,
    });
    return;
  }
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') {
    drift(idx, 'recordUsage()', {
      code: 'TRANSCRIPT_USAGE_SHAPE',
      message: 'message.usage.input_tokens / output_tokens are not numbers (renamed or restructured?)',
      expected: 'message.usage.input_tokens: number, message.usage.output_tokens: number',
      actual: `input_tokens: ${describe(u.input_tokens)}; output_tokens: ${describe(u.output_tokens)}; usage: ${describe(u)}`,
      sample: u,
      fallback: 'missing counts are taken as 0, so cost and tokens run low',
      affects: AFFECTS_USAGE,
    });
  }
  const key = m.id ?? e.requestId ?? e.uuid;
  if (!key) {
    drift(idx, 'recordUsage()', {
      code: 'TRANSCRIPT_USAGE_NO_ID',
      message: 'assistant entry has none of message.id, requestId, uuid, so its usage cannot be de-duplicated',
      expected: 'message.id (or requestId / uuid): string',
      actual: `entry keys: [${Object.keys(e).join(', ')}]; message keys: [${Object.keys(m).join(', ')}]`,
      sample: e,
      fallback: 'this response is left out of cost and tokens',
      affects: AFFECTS_USAGE,
    });
    return;
  }
  const write1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const write5m = u.cache_creation
    ? num(u.cache_creation.ephemeral_5m_input_tokens)
    : num(u.cache_creation_input_tokens); // older logs: no TTL split, assume 5m
  if (!e.isSidechain) {
    idx.context = {
      model: m.model,
      used: num(u.input_tokens) + num(u.cache_read_input_tokens) + write5m + write1h + num(u.output_tokens),
      ts,
    };
  }
  if (ts !== null && idx.firstTs !== null && ts < idx.firstTs) {
    idx.copied = true;
    return;
  }
  idx.usage.set(key, {
    model: m.model,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: num(u.cache_read_input_tokens),
    webSearches: num(u.server_tool_use?.web_search_requests),
    fast: u.speed === 'fast',
  });
  idx.usageAfterReport = true;
}

const TASK_ID_RE = /<task-id>\s*([^<\s]+)\s*<\/task-id>/;
const STATUS_RE = /<status>\s*([a-z_]+)\s*<\/status>/i;
const CRON_JOB_ID_RE = /\bjob ([0-9a-zA-Z_-]+)/;

function recordNotifications(idx: FileIndex, text: string, ts: number | null): void {
  if (ts === null || !text.includes('<task-notification>')) return;
  for (const chunk of text.split('<task-notification>').slice(1)) {
    const id = TASK_ID_RE.exec(chunk)?.[1];
    const status = STATUS_RE.exec(chunk)?.[1]?.toLowerCase();
    if (!id || !status) {
      drift(idx, 'recordNotifications()', {
        code: 'TRANSCRIPT_NOTIFICATION_SHAPE',
        message: '<task-notification> without a parseable <task-id> or <status>',
        expected: '<task-notification> … <task-id>ID</task-id> … <status>completed|failed|killed|…</status>',
        actual: `task-id: ${id ?? 'not found'}; status: ${status ?? 'not found'}`,
        sample: chunk,
        fallback: "notification ignored; the background agent's status comes from its own transcript instead",
        affects: AFFECTS_SUBAGENTS,
      });
      continue;
    }
    const prev = idx.notifications.get(id);
    if (!prev || ts >= prev.ts) idx.notifications.set(id, { status, ts });
  }
}

function recordCronResult(idx: FileIndex, b: ContentBlock, tur: Record<string, unknown> | null, ts: number): void {
  const call = idx.cronCalls.get(b.tool_use_id!);
  if (!call) return;
  idx.cronCalls.delete(b.tool_use_id!);
  if (b.is_error) return;

  if (call.name === 'CronCreate') {
    const id = str(tur?.id) ?? CRON_JOB_ID_RE.exec(textOf(b.content))?.[1] ?? null;
    const cron = str(call.input.cron);
    if (!id || !cron) {
      drift(idx, 'recordCronResult()', {
        code: 'TRANSCRIPT_CRON_SHAPE',
        message: 'successful CronCreate without a job id in its result, or without a cron expression in its input',
        expected: 'toolUseResult.id (or "job <id>" in the result text), tool_use input.cron: string',
        actual: `job id: ${id ?? 'not found'}; toolUseResult: ${describe(tur)}; input: ${describe(call.input)}`,
        sample: { input: call.input, toolUseResult: tur, content: b.content },
        fallback: 'job not listed',
        affects: AFFECTS_JOBS,
      });
      return;
    }
    idx.cronJobs.set(id, {
      id,
      cron,
      prompt: str(call.input.prompt) ?? '',
      recurring: typeof tur?.recurring === 'boolean' ? tur.recurring : call.input.recurring !== false,
      humanSchedule: str(tur?.humanSchedule),
      createdAt: ts,
    });
  } else if (call.name === 'CronDelete') {
    const id = str(call.input.id);
    if (id) idx.cronDeletes.set(id, ts);
  }
}

export const PROMPT_CHARS = 250;

// Whitespace collapsed, cut to PROMPT_CHARS code points (never mid-emoji).
const clip = (s: string): string => Array.from(s.replace(/\s+/g, ' ').trim()).slice(0, PROMPT_CHARS).join('');

const COMMAND_NAME_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const PASTED_TAG_RE = /<\/?pasted_content\b[^>]*>/g;

// The prompt that started this transcript. In a session's own transcript that's the first entry the
// human typed (origin.kind 'human'; /model output, caveats and tool results carry no origin). In a
// sub-agent's transcript it's the first non-meta user text: the prompt its parent spawned it with.
// Slash commands (/sonnet, ...) are kept aside, used only if no prompt follows.
// Known gap: a prompt typed while an earlier command was still running is delivered from the queue as
// an untagged meta entry, so it's skipped.
function recordInitialPrompt(idx: FileIndex, e: LogEntry, text: string): void {
  if (idx.initialPrompt !== null) return;
  if (idx.subagent ? e.isMeta : e.origin?.kind !== 'human') return;
  const name = COMMAND_NAME_RE.exec(text)?.[1];
  if (name) {
    idx.initialCommand ??= clip(`${name} ${COMMAND_ARGS_RE.exec(text)?.[1] ?? ''}`);
    return;
  }
  const prompt = clip(text.replace(PASTED_TAG_RE, ' '));
  if (prompt) idx.initialPrompt = prompt; // empty = image-only or tool results; keep looking
}

function indexEntry(idx: FileIndex, e: LogEntry): void {
  if (!e || typeof e !== 'object' || typeof e.type !== 'string') {
    drift(idx, 'indexEntry()', {
      code: 'TRANSCRIPT_ENTRY_SHAPE',
      message: 'transcript line is not an object with a string "type"',
      expected: '{ type: "user" | "assistant" | "queue-operation" | ..., timestamp, message, ... }',
      actual: describe(e),
      sample: e,
      fallback: 'line skipped',
      affects: [...AFFECTS_USAGE, ...AFFECTS_SUBAGENTS],
    });
    return;
  }
  noteClaudeVersion(e.version);
  if (typeof e.version === 'string') idx.version = e.version;
  const ts = parseTs(e.timestamp);
  if (ts === null && (e.type === 'user' || e.type === 'assistant')) {
    drift(idx, 'indexEntry()', {
      code: 'TRANSCRIPT_TIMESTAMP',
      message: `${e.type} entry has no parseable timestamp`,
      expected: 'timestamp: ISO 8601 string',
      actual: `timestamp: ${describe(e.timestamp)}`,
      sample: e,
      fallback: 'entry indexed without a time: start/end times, tool results and notifications from it are dropped',
      affects: ['GET /fetch-single-session/:id → subagents[].startedAt, lastActivityAt, status', ...AFFECTS_JOBS],
    });
  }
  if (ts !== null) {
    if (idx.firstTs === null) idx.firstTs = ts;
    if (idx.lastTs === null || ts > idx.lastTs) idx.lastTs = ts;
  }

  // Background agents report back via <task-notification>; it's enqueued first, delivered as a user turn later.
  if (e.type === 'queue-operation') {
    recordNotifications(idx, textOf(e.content), ts);
    return;
  }

  // Claude Code snapshots its running cost total into the transcript (what /usage shows), typically as
  // a session ends. It counts API calls that never become assistant entries, so it beats summing usage.
  if (e.type === 'cost-state') {
    if (typeof e.totalCostUSD === 'number' && Number.isFinite(e.totalCostUSD)) {
      idx.reportedCost = e.totalCostUSD;
      idx.usageAfterReport = false;
    } else {
      drift(idx, 'indexEntry()', {
        code: 'TRANSCRIPT_COST_STATE_SHAPE',
        message: 'cost-state entry without a numeric totalCostUSD',
        expected: 'totalCostUSD: number',
        actual: `totalCostUSD: ${describe(e.totalCostUSD)}; entry: ${describe(e)}`,
        sample: e,
        fallback: 'cost computed from token usage × list prices instead (a few % low)',
        affects: ['GET /fetch-single-session/:id → cost'],
      });
    }
    return;
  }

  const content = e.message?.content;

  if (e.type === 'assistant') {
    if (!e.message || typeof e.message !== 'object' || !Array.isArray(content) || !('stop_reason' in e.message)) {
      drift(idx, 'indexEntry()', {
        code: 'TRANSCRIPT_ASSISTANT_SHAPE',
        message: 'assistant entry without message.content[] or message.stop_reason',
        expected: 'message: { content: ContentBlock[], stop_reason: string | null, model, usage, ... }',
        actual: `message: ${describe(e.message)}; content: ${describe(content)}`,
        sample: e,
        fallback: 'tool calls and turn state from this entry are missed',
        affects: ['GET /fetch-session-ids → sessions[].status', ...AFFECTS_SUBAGENTS, ...AFFECTS_JOBS],
      });
    }
    recordUsage(idx, e, ts);
    const blocks = blocksOf(content);
    for (const b of blocks) {
      if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
      idx.spawns.set(b.id, {
        description: str(b.input?.description),
        agentType: str(b.input?.subagent_type),
      });
      if (b.name === 'CronCreate' || b.name === 'CronDelete') {
        idx.cronCalls.set(b.id, { name: b.name, input: b.input ?? {} });
      }
    }
    if (e.message?.stop_reason === 'end_turn') idx.tail = 'ended';
    else if (blocks.length) idx.tail = 'active'; // thinking / text / tool_use in flight
    return;
  }

  if (e.type === 'user') {
    const text = textOf(content);
    recordNotifications(idx, text, ts);
    recordInitialPrompt(idx, e, text);
    if (text.startsWith('[Request interrupted by user')) {
      idx.tail = 'interrupted';
    } else {
      idx.tail = 'active'; // new prompt or tool result -> model is about to respond
    }
    if (ts !== null && (e.turnOrigin === 'scheduled' || e.origin?.kind === 'scheduled')) {
      idx.scheduledFires.set(text, ts);
    }

    const tur = e.toolUseResult && typeof e.toolUseResult === 'object' ? (e.toolUseResult as Record<string, unknown>) : null;
    for (const b of blocksOf(content)) {
      if (b.type !== 'tool_result' || ts === null) continue;
      if (typeof b.tool_use_id !== 'string') {
        drift(idx, 'indexEntry()', {
          code: 'TRANSCRIPT_TOOL_RESULT_SHAPE',
          message: 'tool_result block without a string tool_use_id',
          expected: '{ type: "tool_result", tool_use_id: string, content, is_error? }',
          actual: describe(b),
          sample: b,
          fallback: 'tool result ignored; sub-agents it finished may show as running',
          affects: [...AFFECTS_SUBAGENTS, ...AFFECTS_JOBS],
        });
        continue;
      }
      const resultText = textOf(b.content);
      idx.toolResults.set(b.tool_use_id, {
        ts,
        isError: b.is_error === true,
        isAsync: tur?.isAsync === true || tur?.status === 'async_launched',
        interrupted: resultText.includes('[Request interrupted by user'),
        agentId: str(tur?.agentId),
      });
      recordCronResult(idx, b, tur, ts);
    }
  }
  // attachment, system, progress, file-history-snapshot, ...: no bearing on what we track
}

function freshIndex(file: string, ino: number, subagent: boolean): FileIndex {
  return {
    file,
    line: 0,
    version: null,
    ino,
    offset: 0,
    leftover: Buffer.alloc(0),
    lastAccess: 0,
    subagent,
    firstTs: null,
    lastTs: null,
    tail: null,
    spawns: new Map(),
    toolResults: new Map(),
    notifications: new Map(),
    cronCalls: new Map(),
    cronJobs: new Map(),
    cronDeletes: new Map(),
    scheduledFires: new Map(),
    usage: new Map(),
    copied: false,
    reportedCost: null,
    usageAfterReport: false,
    context: null,
    initialPrompt: null,
    initialCommand: null,
  };
}

// Reads only bytes appended since the last call. Resets if the file was replaced or truncated.
export function indexFile(file: string): FileIndex | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    cache.delete(file);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // ENOENT = deleted between listing and reading; anything else (EACCES, EISDIR, ...) is unexpected
      report({
        code: 'TRANSCRIPT_OPEN_FAILED',
        severity: 'error',
        message: 'could not open a transcript',
        where: 'server/transcripts.ts indexFile()',
        source: file,
        fallback: 'transcript skipped',
        affects: AFFECTS_USAGE,
        error,
      });
    }
    return null;
  }
  try {
    const { size, ino } = fs.fstatSync(fd);
    let idx = cache.get(file);
    if (!idx || idx.ino !== ino || size < idx.offset) {
      idx = freshIndex(file, ino, path.basename(file).startsWith('agent-'));
      cache.set(file, idx);
    }
    idx.lastAccess = Date.now();

    while (idx.offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - idx.offset));
      const n = fs.readSync(fd, buf, 0, buf.length, idx.offset);
      if (n <= 0) break;
      idx.offset += n;

      // Split on the '\n' byte so multi-byte UTF-8 chars are never cut in half.
      let data = Buffer.concat([idx.leftover, buf.subarray(0, n)]);
      let nl: number;
      while ((nl = data.indexOf(0x0a)) !== -1) {
        const line = data.subarray(0, nl).toString('utf8').trim();
        data = data.subarray(nl + 1);
        idx.line++;
        if (!line) continue;
        let entry: LogEntry;
        try {
          entry = JSON.parse(line) as LogEntry;
        } catch (error) {
          // A complete line (partial last lines wait in leftover), so this is real corruption, not a write in progress
          report({
            code: 'TRANSCRIPT_BAD_JSON',
            severity: 'warn',
            message: 'transcript line is not valid JSON',
            where: 'server/transcripts.ts indexFile()',
            source: file,
            line: idx.line,
            expected: 'one JSON object per line (JSONL)',
            sample: line,
            fallback: 'line skipped',
            claudeVersion: idx.version,
            error: (error as Error).message,
          });
          continue;
        }
        try {
          indexEntry(idx, entry);
        } catch (error) {
          // The line parsed but indexing it threw: almost certainly a field changed type or shape
          report({
            code: 'TRANSCRIPT_ENTRY_THREW',
            severity: 'error',
            message: 'indexing a transcript entry threw; its shape probably changed',
            where: 'server/transcripts.ts indexEntry()',
            source: file,
            line: idx.line,
            actual: describe(entry),
            sample: entry,
            fallback: 'entry skipped; facts it carried (usage, tool calls, results) are missing',
            affects: [...AFFECTS_USAGE, ...AFFECTS_SUBAGENTS, ...AFFECTS_JOBS, ...AFFECTS_PROMPT],
            claudeVersion: typeof entry?.version === 'string' ? entry.version : idx.version,
            error,
          });
        }
      }
      idx.leftover = Buffer.from(data);
    }
    return idx;
  } finally {
    fs.closeSync(fd);
  }
}

export function sweepCache(): void {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [file, idx] of cache) if (idx.lastAccess < cutoff) cache.delete(file);
}
