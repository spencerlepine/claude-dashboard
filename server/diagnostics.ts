// Structured problem reports for when Claude Code's on-disk format drifts from what this server reads.
//
// Everything under ~/.claude is Claude Code's private format and can change in any release. The server
// never fails a request over it: each reader falls back to a safe value (skip the entry, 0, null, []) and
// calls report() here. Each report is a self-contained block in the server log, written so it can be
// pasted into a coding agent as is: what broke, where in this repo, which file and line on disk, what we
// expected vs. what was there, a sample of the raw input, what the server did instead, and which API
// response fields (and therefore which parts of the frontend) are affected.
//
// Polling repeats the same failure every few seconds, so a report is printed once, then suppressed for
// REPEAT_MS and printed again with a count of how often it recurred in between.

export type Severity = 'error' | 'warn';

export interface Issue {
  code: string; // stable id for this kind of failure, e.g. TRANSCRIPT_USAGE_SHAPE
  severity: Severity; // error = code threw; warn = data didn't have the expected shape
  message: string; // what went wrong, one line
  where: string; // the reader in this repo, e.g. 'server/transcripts.ts recordUsage()'
  source?: string; // the file on disk being read
  line?: number; // 1-based line in source (JSONL transcripts)
  expected?: string; // the shape the code relies on
  actual?: string; // what was found instead
  sample?: unknown; // raw input that triggered it; truncated when printed
  fallback: string; // what the server did instead of failing
  affects?: string[]; // API response fields whose values are missing or degraded as a result
  error?: unknown; // the caught exception, if any; a string is printed as is, an Error with its stack
  claudeVersion?: string | null; // Claude Code version that wrote the offending data, when known
  dedupeKey?: string; // defaults to code + where: a format change hits every file alike, so one report covers it
}

const REPEAT_MS = 10 * 60 * 1000;
const SAMPLE_CHARS = 600;
const API_NOTE =
  'These fields are returned by this server and rendered by the dashboard frontend (frontend/index.html, ' +
  'frontend/activity.js). The response shape is unchanged (the field is null, 0 or empty), but after fixing the ' +
  'backend, check the frontend still renders them correctly, and update both if the fix changes the contract.';

// Claude Code writes its version into session files and every transcript entry; the latest seen goes
// into each report, so a report says which release changed the format.
let claudeVersion: string | null = null;
export function noteClaudeVersion(v: unknown): void {
  if (typeof v === 'string' && v && v !== claudeVersion) claudeVersion = v;
}

const seen = new Map<string, { lastPrinted: number; suppressed: number }>();

// Short description of a value's shape, for "actual": type plus keys for objects, length for arrays.
export function describe(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object with keys [${Object.keys(v as object).join(', ')}]`;
  if (typeof v === 'string') return `string ${JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v)}`;
  return `${typeof v} ${String(v)}`;
}

function truncate(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > SAMPLE_CHARS ? `${s.slice(0, SAMPLE_CHARS)}… (${s.length} chars total)` : s;
}

const home = process.env.HOME;
const tidy = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

function format(issue: Issue, suppressed: number): string {
  const rows: [string, string | undefined][] = [
    ['what', issue.message],
    ['where', issue.where],
    ['source', issue.source && `${tidy(issue.source)}${issue.line ? `:${issue.line}` : ''}`],
    [
      'claude',
      issue.claudeVersion
        ? `Claude Code ${issue.claudeVersion} (wrote this data)`
        : claudeVersion
          ? `Claude Code ${claudeVersion} (latest version seen on disk)`
          : undefined,
    ],
    ['expected', issue.expected],
    ['actual', issue.actual],
    ['sample', issue.sample === undefined ? undefined : truncate(issue.sample)],
    ['fallback', issue.fallback],
    ['api', issue.affects?.length ? issue.affects.join('; ') : undefined],
    ['frontend', issue.affects?.length ? API_NOTE : undefined],
    ['repeats', suppressed ? `${suppressed} more time(s) since the last report of this issue` : undefined],
  ];
  const err = issue.error;
  const head = `━━ claude-dashboard ${issue.severity.toUpperCase()} ${issue.code} ━━ ${new Date().toISOString()}`;
  const body = rows.filter(([, v]) => v).map(([k, v]) => `  ${k.padEnd(9)}${v}`);
  if (typeof err === 'string') body.push(`  ${'error'.padEnd(9)}${err}`);
  else if (err !== undefined) {
    const stack = err instanceof Error ? err.stack ?? `${err.name}: ${err.message}` : String(err);
    body.push(`  stack\n${stack.split('\n').map((l) => `    ${l.trim()}`).join('\n')}`);
  }
  return [head, ...body, ''].join('\n');
}

export function report(issue: Issue): void {
  try {
    const key = issue.dedupeKey ?? `${issue.code}|${issue.where}`;
    const now = Date.now();
    const prev = seen.get(key);
    if (prev && now - prev.lastPrinted < REPEAT_MS) {
      prev.suppressed++;
      return;
    }
    seen.set(key, { lastPrinted: now, suppressed: 0 });
    const text = format(issue, prev?.suppressed ?? 0);
    if (issue.severity === 'error') console.error(text);
    else console.warn(text);
  } catch (err) {
    console.error('claude-dashboard: failed to format a diagnostic report', err, issue);
  }
}

// Runs fn; if it throws, reports and returns the fallback so one broken piece can't fail a whole response.
export function guard<T>(fn: () => T, fallback: T, issue: Omit<Issue, 'severity' | 'error' | 'code'> & { code?: string }): T {
  try {
    return fn();
  } catch (error) {
    report({ code: 'READER_THREW', ...issue, severity: 'error', error });
    return fallback;
  }
}
