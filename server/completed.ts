// Finds sessions whose process has exited, from the transcripts they left in <projects>/<encoded-cwd>/.
// Nothing else survives the process (its ~/.claude/sessions/<pid>.json is removed), so the transcript
// supplies everything: start time and cwd from its first entries, end time from its last write.

import fs from 'node:fs';
import path from 'node:path';
import { findLog, liveSessionIds, PROJECTS_DIR, withDetail, type SessionDetail, type SessionSummary } from './sessions.js';
import type { TimeRange } from './range.js';
import { sessionCost } from './cost.js';
import { guard, report } from './diagnostics.js';
import { loadSessionTranscripts } from './subagents.js';

const HEAD_BYTES = 64 * 1024;
const TRANSCRIPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

// First timestamp and cwd in the transcript. Early entries (queue operations) carry a timestamp but no cwd.
export function readHead(file: string): { startedAt: number | null; cwd: string } {
  let startedAt: number | null = null;
  let cwd = '';
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      report({
        code: 'TRANSCRIPT_OPEN_FAILED',
        severity: 'error',
        message: 'could not open a transcript to read its first entries',
        where: 'server/completed.ts readHead()',
        source: file,
        fallback: 'start time taken from the file mtime, cwd empty',
        affects: ['GET /fetch-session-ids?status=completed → sessions[].startedAt, cwd', 'GET /fetch-activity → days'],
        error,
      });
    }
    return { startedAt, cwd };
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      let e: { timestamp?: unknown; cwd?: unknown };
      try {
        e = JSON.parse(line);
      } catch {
        continue; // blank, or cut off at HEAD_BYTES
      }
      if (startedAt === null && typeof e.timestamp === 'string') startedAt = Date.parse(e.timestamp) || null;
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (startedAt !== null && cwd) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (startedAt === null) {
    report({
      code: 'TRANSCRIPT_HEAD_NO_TIMESTAMP',
      severity: 'warn',
      message: `no entry in the first ${HEAD_BYTES / 1024} KB of the transcript has a parseable timestamp`,
      where: 'server/completed.ts readHead()',
      source: file,
      expected: 'early entries carry timestamp: ISO 8601 string',
      fallback: 'start time taken from the file mtime (i.e. when it ended)',
      affects: ['GET /fetch-session-ids?status=completed → sessions[].startedAt (and which range a session falls in)', 'GET /fetch-activity → days'],
    });
  }
  return { startedAt, cwd };
}

function toSummary(logPath: string, mtimeMs: number): SessionSummary {
  const { startedAt, cwd } = readHead(logPath);
  return {
    sessionId: path.basename(logPath, '.jsonl'),
    pid: null,
    name: null, // the name lived in the session file, which is gone
    cwd,
    startedAt: startedAt ?? mtimeMs,
    endedAt: mtimeMs,
    status: 'completed',
    reportedStatus: null,
    logPath,
  };
}

const MIN_COST_USD = 0.01;

// A session that cost less than a cent, which covers ones opened and closed without doing anything ($0).
// Same figure the card shows (main + sub-agents). One that used a model missing from the rate table is
// kept, since its real cost is unknown. Transcript indexes are cached, so the detail fetch reuses them.
function isTrivialSession(s: SessionSummary): boolean {
  return guard(
    () => {
      const transcripts = loadSessionTranscripts({ sessionId: s.sessionId, logPath: s.logPath, projectsDir: PROJECTS_DIR, startedAt: s.startedAt });
      const cost = sessionCost(transcripts);
      return cost.usd < MIN_COST_USD && !cost.unpricedModels.length;
    },
    false,
    {
      message: "computing a completed session's cost (to hide ones under $0.01) threw",
      where: 'server/completed.ts isTrivialSession()',
      source: s.logPath ?? undefined,
      fallback: 'session kept in the list',
      affects: ['GET /fetch-session-ids?status=completed → sessions (sessions under $0.01 may show)'],
    }
  );
}

// Every session transcript under <projects>/*/, live or not
export function* listTranscripts(): Generator<{ sessionId: string; file: string }> {
  let projects: string[];
  try {
    projects = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return;
  }
  for (const project of projects) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(PROJECTS_DIR, project)).filter((f) => TRANSCRIPT_RE.test(f));
    } catch {
      continue; // not a directory
    }
    for (const f of files) yield { sessionId: path.basename(f, '.jsonl'), file: path.join(PROJECTS_DIR, project, f) };
  }
}

// Sessions that were alive at some point in [from, to] and have since exited, most recent first.
// Ones under $0.01 (see isTrivialSession) are left out.
export function findCompletedSessions({ from, to }: TimeRange): SessionSummary[] {
  const live = liveSessionIds();
  const found: SessionSummary[] = [];
  for (const { sessionId, file } of listTranscripts()) {
    if (live.has(sessionId)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < from) continue; // ended before the range; skip without opening it
    const s = guard(() => toSummary(file, mtimeMs), null, {
      message: 'summarizing a completed session threw',
      where: 'server/completed.ts toSummary()',
      source: file,
      fallback: 'session left out of the list',
      affects: ['GET /fetch-session-ids?status=completed → sessions'],
    });
    if (s && s.startedAt <= to && !isTrivialSession(s)) found.push(s);
  }
  return found.sort((a, b) => b.endedAt! - a.endedAt!);
}

// null = no transcript for this sessionId, its process is still running, or it cost under $0.01
export function findCompletedSession(sessionId: string): SessionDetail | null {
  if (liveSessionIds().has(sessionId)) return null;
  const logPath = findLog(sessionId);
  if (!logPath) return null;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(logPath).mtimeMs;
  } catch {
    return null;
  }
  const summary = toSummary(logPath, mtimeMs);
  return isTrivialSession(summary) ? null : withDetail(summary);
}
