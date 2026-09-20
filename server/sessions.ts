// Finds every live Claude Code session on this machine and reports its status
// (idle | working | permission | question) by reading the tail of its .jsonl log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionContext, type ContextWindow } from './context.js';
import { sessionCost, type SessionCost } from './cost.js';
import { describe, guard, noteClaudeVersion, report } from './diagnostics.js';
import { findScheduledJobs, type ScheduledJob } from './scheduled.js';
import { findSubagents, loadSessionTranscripts, MAIN, type SubagentNode } from './subagents.js';
import { sessionTokens, type SessionTokens } from './tokens.js';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const TAIL_BYTES = 128 * 1024;
const STREAMING_STALE_MS = 8000; // text-only assistant entry newer than this = still streaming

// 'completed' = the process has exited (see completed.ts); the others are live states.
export type SessionStatus = 'idle' | 'working' | 'permission' | 'question' | 'completed';

export interface SessionSummary {
  sessionId: string;
  pid: number | null; // null once the process has exited
  name: string | null;
  cwd: string;
  startedAt: number;
  endedAt: number | null; // last transcript write; null while live
  status: SessionStatus;
  reportedStatus: string | null; // what Claude itself wrote in the session file
  logPath: string | null;
}

// Shape of ~/.claude/sessions/<pid>.json (only the fields we use)
interface SessionFile {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  name?: string;
  status?: string;
  version?: string; // Claude Code version
}

const AFFECTS_LIST = ['GET /fetch-session-ids?status=active → sessions, sessionIds', 'GET /fetch-single-session/:id?status=active'];
const AFFECTS_STATUS = ['GET /fetch-session-ids → sessions[].status', 'GET /fetch-single-session/:id → status'];

interface ContentBlock {
  type: string;
  name?: string;
  text?: string;
}

interface LogEntry {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  message?: { stop_reason?: string | null; content?: unknown };
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

// ~/.claude/projects/<encoded-cwd>: every non-alphanumeric char becomes '-'
const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function readSessions(): SessionFile[] {
  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch (error) {
    // Missing before Claude Code's first run is normal; missing once ~/.claude exists means it moved
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || fs.existsSync(CLAUDE_DIR)) {
      report({
        code: 'SESSIONS_DIR_UNREADABLE',
        severity: 'error',
        message: 'cannot list the live-session directory (moved or renamed by a Claude Code update?)',
        where: 'server/sessions.ts readSessions()',
        source: SESSIONS_DIR,
        expected: '<claude dir>/sessions/<pid>.json, one file per running Claude Code process',
        actual: `entries in ${CLAUDE_DIR}: ${describe(safeReaddir(CLAUDE_DIR))}`,
        fallback: 'no active sessions are listed',
        affects: AFFECTS_LIST,
        error,
      });
    }
    return [];
  }
  const sessions: SessionFile[] = [];
  for (const f of files) {
    const file = path.join(SESSIONS_DIR, f);
    let s: SessionFile;
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionFile;
    } catch (error) {
      // ENOENT = the process exited between listing and reading
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report({
          code: 'SESSION_FILE_UNREADABLE',
          severity: 'warn',
          message: 'session file is unreadable or not valid JSON (a half-written file is harmless if this does not repeat)',
          where: 'server/sessions.ts readSessions()',
          source: file,
          expected: 'JSON object { pid, sessionId, cwd, startedAt, name?, status? }',
          fallback: 'session left out of the active list',
          affects: AFFECTS_LIST,
          error,
        });
      }
      continue;
    }
    noteClaudeVersion(s?.version);
    if (!s || typeof s.pid !== 'number' || typeof s.sessionId !== 'string' || !s.sessionId) {
      report({
        code: 'SESSION_FILE_SHAPE',
        severity: 'warn',
        message: 'session file has no numeric pid or string sessionId (renamed?)',
        where: 'server/sessions.ts readSessions()',
        source: file,
        expected: '{ pid: number, sessionId: string, cwd?: string, startedAt?: number (epoch ms), name?: string, status?: string }',
        actual: describe(s),
        sample: s,
        fallback: 'session left out of the active list',
        affects: AFFECTS_LIST,
      });
      continue;
    }
    if (s.cwd !== undefined && typeof s.cwd !== 'string' || s.startedAt !== undefined && typeof s.startedAt !== 'number') {
      report({
        code: 'SESSION_FILE_FIELD_TYPE',
        severity: 'warn',
        message: 'session file cwd / startedAt have unexpected types',
        where: 'server/sessions.ts readSessions()',
        source: file,
        expected: 'cwd: string, startedAt: number (epoch ms)',
        actual: `cwd: ${describe(s.cwd)}; startedAt: ${describe(s.startedAt)}`,
        sample: s,
        fallback: 'the bad fields are treated as missing (cwd "", startedAt 0)',
        affects: ['GET /fetch-session-ids → sessions[].cwd, startedAt', 'GET /fetch-single-session/:id → cwd, startedAt, subagents[].status'],
      });
      if (typeof s.cwd !== 'string') delete s.cwd;
      if (typeof s.startedAt !== 'number') delete s.startedAt;
    }
    if (isAlive(s.pid)) sessions.push(s);
  }
  return sessions;
}

function safeReaddir(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

export const liveSessionIds = (): Set<string> => new Set(readSessions().map((s) => s.sessionId));

// The log is <projects>/<encoded-cwd>/<sessionId>.jsonl. Long paths can be encoded differently
// (and a completed session has no known cwd), so fall back to scanning every project dir.
export function findLog(sessionId: string, cwd = ''): string | null {
  const name = `${sessionId}.jsonl`;
  const direct = path.join(PROJECTS_DIR, encodeCwd(cwd), name);
  if (cwd && fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, dir, name);
      if (fs.existsSync(p)) {
        // Only long paths are expected to be encoded differently; a short one means encodeCwd is out of date
        if (cwd && cwd.length < 200) {
          report({
            code: 'PROJECT_DIR_ENCODING',
            severity: 'warn',
            message: "transcript is not in the project dir encodeCwd() predicts for its cwd (encoding rule changed?)",
            where: 'server/sessions.ts findLog()',
            source: p,
            expected: `${direct}`,
            actual: `found in ${dir} (cwd ${cwd})`,
            fallback: 'found by scanning every project dir, which is slower but correct',
          });
        }
        return p;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      report({
        code: 'PROJECTS_DIR_UNREADABLE',
        severity: 'error',
        message: 'cannot list the projects directory where transcripts live',
        where: 'server/sessions.ts findLog()',
        source: PROJECTS_DIR,
        fallback: 'no transcript found for this session',
        affects: [...AFFECTS_STATUS, 'GET /fetch-single-session/:id → every transcript-derived field'],
        error,
      });
    }
  }
  return null;
}

function readTailLines(file: string): { lines: string[]; mtimeMs: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const { size, mtimeMs } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably cut mid-entry
    return { lines: lines.filter(Boolean), mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

const contentBlocks = (entry: LogEntry): ContentBlock[] => {
  const c = entry.message && entry.message.content;
  return Array.isArray(c) ? (c as ContentBlock[]) : [];
};

const wasInterrupted = (entry: LogEntry): boolean =>
  contentBlocks(entry).some(
    (b) => b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Request interrupted by user')
  );

// Walk the log backwards; the first entry that says something about state wins.
export function detectStatusFromLog(file: string, now = Date.now()): SessionStatus {
  const { lines, mtimeMs } = readTailLines(file);
  const stale = now - mtimeMs > STREAMING_STALE_MS;
  let parsed = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    let e: LogEntry;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue; // the last line may be mid-write; indexFile reports real corruption
    }
    parsed++;
    if (!e || typeof e !== 'object') continue;
    if (e.isSidechain) continue; // subagent chatter

    switch (e.type) {
      case 'system':
        if (e.subtype === 'turn_duration') return 'idle';
        continue;

      case 'assistant': {
        const stop = e.message && e.message.stop_reason;
        const toolUses = contentBlocks(e).filter((b) => b.type === 'tool_use');
        if (stop === 'end_turn') return 'idle';
        if (toolUses.length) {
          // tool_use is the last thing logged, so the tool hasn't produced a result yet
          return toolUses.some((b) => b.name === 'AskUserQuestion') ? 'question' : 'permission';
        }
        return stale ? 'idle' : 'working'; // text/thinking only
      }

      case 'user':
        return wasInterrupted(e) ? 'idle' : 'working';

      case 'progress':
        return 'working';

      default:
        continue; // file-history-snapshot, attachment, mode, ai-title, last-prompt, ...
    }
  }
  report({
    code: 'STATUS_NOT_DETERMINED',
    severity: 'warn',
    message: parsed
      ? `none of the last ${parsed} transcript entries is a user / assistant / system turn_duration / progress entry (entry types renamed?)`
      : `none of the last ${lines.length} transcript lines parsed as JSON`,
    where: 'server/sessions.ts detectStatusFromLog()',
    source: file,
    expected: 'entries with type "user" | "assistant" | "progress" | "system" (subtype "turn_duration") near the end of the file',
    actual: `last line: ${lines.length ? describe(safeParse(lines[lines.length - 1])) : 'file is empty'}`,
    sample: lines[lines.length - 1],
    fallback: 'status reported as idle',
    affects: AFFECTS_STATUS,
  });
  return 'idle';
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

function toSummary(s: SessionFile): SessionSummary {
  const logPath = guard(() => findLog(s.sessionId, s.cwd), null, {
    message: 'finding the transcript of a live session threw',
    where: 'server/sessions.ts findLog()',
    source: s.cwd,
    fallback: 'session shown without a transcript',
    affects: AFFECTS_STATUS,
  });
  const status = logPath
    ? guard(() => detectStatusFromLog(logPath), 'idle' as SessionStatus, {
        message: "reading a live session's status from its transcript tail threw",
        where: 'server/sessions.ts detectStatusFromLog()',
        source: logPath,
        fallback: 'status reported as idle',
        affects: AFFECTS_STATUS,
      })
    : 'idle'; // no log yet = brand-new session
  return {
    sessionId: s.sessionId,
    pid: s.pid,
    name: typeof s.name === 'string' && s.name ? s.name : null,
    cwd: s.cwd || '',
    startedAt: s.startedAt || 0,
    endedAt: null,
    status,
    reportedStatus: typeof s.status === 'string' && s.status ? s.status : null,
    logPath,
  };
}

// Last resort for a session whose summary threw: still listed, with only what the session file says.
const bareSummary = (s: SessionFile): SessionSummary => ({
  sessionId: s.sessionId,
  pid: s.pid,
  name: typeof s.name === 'string' ? s.name : null,
  cwd: s.cwd || '',
  startedAt: s.startedAt || 0,
  endedAt: null,
  status: 'idle',
  reportedStatus: typeof s.status === 'string' ? s.status : null,
  logPath: null,
});

const summarize = (s: SessionFile): SessionSummary =>
  guard(() => toSummary(s), bareSummary(s), {
    message: 'summarizing a live session threw',
    where: 'server/sessions.ts toSummary()',
    source: path.join(SESSIONS_DIR, `${s.pid}.json`),
    sample: s,
    fallback: 'session listed with only its session-file fields, status idle, logPath null',
    affects: AFFECTS_STATUS,
  });

export function findActiveSessions(): SessionSummary[] {
  return readSessions()
    .map(summarize)
    .sort((a, b) => a.startedAt - b.startedAt);
}

// Static note for an AI agent handed this JSON, so it knows where to read the transcripts.
const LLM_HELPER =
  'logPath is the full chat transcript of this session (JSONL, one entry per line; entries with isSidechain: true are ' +
  'sub-agent chatter). Sub-agents are supported: each one in subagents[] (nested ones under .children) has its own ' +
  'transcript at <dirname(logPath)>/<sessionId>/subagents/agent-<agentId>.jsonl, next to an agent-<agentId>.meta.json ' +
  'with its agentType and description.';

export interface SessionDetail extends SessionSummary {
  llmHelper: string; // same for every session; see LLM_HELPER
  initialPrompt: string | null; // first thing the human typed, 100 chars max (see transcripts.ts)
  subagents: SubagentNode[]; // top-level Agent spawns; nested spawns live in .children
  scheduledJobs: ScheduledJob[]; // live CronCreate jobs, soonest first
  cost: SessionCost | null; // estimated API cost, main session + all sub-agents; null = couldn't be computed
  tokens: SessionTokens | null; // token usage, main session + every sub-agent, with a per-agent breakdown; null = couldn't be computed
  context: ContextWindow | null; // main agent's context-window fill; for a completed session, as it ended
}

const DETAIL = 'GET /fetch-single-session/:id';

// Adds sub-agents, scheduled jobs, cost and tokens to a summary. A live session shows only its running
// agents and live cron jobs; a completed one shows every agent it spawned and no jobs (they die with it).
export function withDetail(session: SessionSummary): SessionDetail {
  const completed = session.status === 'completed';
  const query = {
    sessionId: session.sessionId,
    logPath: session.logPath,
    projectsDir: PROJECTS_DIR,
    // An agent whose last write predates this is reported interrupted; for an exited process that's
    // every agent that never finished.
    startedAt: completed ? Date.now() : session.startedAt,
  };
  const { sessionId, ...rest } = session; // so initialPrompt sits right after sessionId in the JSON
  const source = session.logPath ?? undefined;
  // Each section is computed separately, so one that breaks is reported and blanked without taking the rest down.
  const transcripts = guard(() => loadSessionTranscripts(query), null, {
    message: "indexing the session's transcripts threw",
    where: 'server/subagents.ts loadSessionTranscripts()',
    source,
    fallback: 'initialPrompt, cost, tokens and context are null; subagents and scheduledJobs are empty',
    affects: [`${DETAIL} → initialPrompt, subagents, scheduledJobs, cost, tokens, context`],
  });
  if (!transcripts) {
    return { sessionId, llmHelper: LLM_HELPER, initialPrompt: null, ...rest, subagents: [], scheduledJobs: [], cost: null, tokens: null, context: null };
  }
  const main = transcripts.indexes.get(MAIN);
  return {
    sessionId,
    llmHelper: LLM_HELPER,
    initialPrompt: main ? main.initialPrompt ?? main.initialCommand : null,
    ...rest,
    subagents: guard(() => findSubagents(query, transcripts, { includeFinished: completed }), [], {
      message: 'building the sub-agent tree threw',
      where: 'server/subagents.ts findSubagents()',
      source,
      fallback: 'subagents is empty',
      affects: [`${DETAIL} → subagents`],
    }),
    scheduledJobs: completed
      ? []
      : guard(() => findScheduledJobs(transcripts, session.startedAt), [], {
          message: 'finding scheduled jobs threw',
          where: 'server/scheduled.ts findScheduledJobs()',
          source,
          fallback: 'scheduledJobs is empty',
          affects: [`${DETAIL} → scheduledJobs`],
        }),
    cost: guard(() => sessionCost(transcripts), null, {
      message: 'computing session cost threw',
      where: 'server/cost.ts sessionCost()',
      source,
      fallback: 'cost is null',
      affects: [`${DETAIL} → cost`],
    }),
    tokens: guard(() => sessionTokens(transcripts), null, {
      message: 'computing session tokens threw',
      where: 'server/tokens.ts sessionTokens()',
      source,
      fallback: 'tokens is null',
      affects: [`${DETAIL} → tokens`],
    }),
    context: guard(() => sessionContext(transcripts), null, {
      message: 'computing context-window fill threw',
      where: 'server/context.ts sessionContext()',
      source,
      fallback: 'context is null',
      affects: [`${DETAIL} → context`],
    }),
  };
}

// null = no live process owns this sessionId any more (closed, or never existed)
export function findSession(sessionId: string): SessionDetail | null {
  const s = readSessions().find((x) => x.sessionId === sessionId);
  return s ? withDetail(summarize(s)) : null;
}
