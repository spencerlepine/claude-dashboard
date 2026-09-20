// Scheduled (CronCreate) jobs for one session.
//
// Cron jobs are session-only: Claude Code keeps them in memory and writes nothing to disk, so the
// transcript is the only record. A job is live if it was created (CronCreate succeeded) by the
// current process, hasn't been CronDelete'd, hasn't expired (recurring: 7 days) and, for one-shots,
// hasn't fired yet. The next run time is computed here from the cron expression, in local time
// (same machine and timezone as the Claude process).

import { report } from './diagnostics.js';
import type { CronJobRecord } from './transcripts.js';
import type { SessionTranscripts } from './subagents.js';

export interface ScheduledJob {
  id: string;
  cron: string;
  humanSchedule: string | null;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  nextRunAt: number | null; // null = couldn't parse the cron expression; may be in the past if a one-shot is overdue
}

const RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_SHOT_EARLY_MS = 2 * 60 * 1000; // one-shots may fire up to 90s early
const MAX_SEARCH_STEPS = 50_000;

// ---- cron expression parsing ----

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function parseField(field: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> | null {
  const toNum = (s: string): number => {
    const i = names ? names.indexOf(s.toLowerCase()) : -1;
    return i >= 0 ? i + nameBase : /^\d+$/.test(s) ? Number(s) : NaN;
  };
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number, hi: number;
    if (range === '*') {
      [lo, hi] = [min, max];
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      [lo, hi] = [toNum(a), toNum(b)];
    } else {
      lo = toNum(range);
      hi = stepStr === undefined ? lo : max; // "5/15" = from 5 every 15
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec | null {
  const fields = (ALIASES[expr.trim().toLowerCase()] ?? expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, h, dom, mon, dow] = fields;
  const spec = {
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTHS, 1),
    dow: parseField(dow, 0, 7, DAYS),
  };
  if (!spec.minute || !spec.hour || !spec.dom || !spec.month || !spec.dow) return null;
  if (spec.dow.has(7)) spec.dow.add(0); // 7 = Sunday too
  return {
    ...(spec as Omit<CronSpec, 'domAny' | 'dowAny'>),
    domAny: dom.startsWith('*'),
    dowAny: dow.startsWith('*'),
  };
}

// Standard cron rule: if both day-of-month and day-of-week are restricted, either may match.
const dayMatches = (s: CronSpec, d: Date): boolean => {
  const domOk = s.dom.has(d.getDate());
  const dowOk = s.dow.has(d.getDay());
  if (s.domAny || s.dowAny) return domOk && dowOk;
  return domOk || dowOk;
};

// First matching minute strictly after `after` (local time), or null if none within the search budget.
export function nextRun(spec: CronSpec, after: number): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < MAX_SEARCH_STEPS; i++) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(spec, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d.getTime();
    }
  }
  return null;
}

// ---- job liveness ----

export function findScheduledJobs(
  { indexes }: SessionTranscripts,
  sessionStartedAt: number,
  now = Date.now()
): ScheduledJob[] {
  const jobs = new Map<string, CronJobRecord>();
  const deletes = new Map<string, number>();
  const fires = new Map<string, number>();
  for (const idx of indexes.values()) {
    for (const [id, job] of idx.cronJobs) jobs.set(id, job);
    for (const [id, ts] of idx.cronDeletes) deletes.set(id, Math.max(ts, deletes.get(id) ?? 0));
    for (const [prompt, ts] of idx.scheduledFires) fires.set(prompt, Math.max(ts, fires.get(prompt) ?? 0));
  }

  const live: ScheduledJob[] = [];
  for (const job of jobs.values()) {
    if (sessionStartedAt && job.createdAt < sessionStartedAt) continue; // died with an earlier process
    if ((deletes.get(job.id) ?? -Infinity) >= job.createdAt) continue;

    const spec = parseCron(job.cron);
    if (!spec) {
      report({
        code: 'CRON_UNPARSEABLE',
        severity: 'warn',
        message: `CronCreate job ${job.id} has a cron expression parseCron() does not understand`,
        where: 'server/scheduled.ts parseCron()',
        expected: '5-field cron (minute hour day-of-month month day-of-week) or an @alias',
        actual: JSON.stringify(job.cron),
        sample: job,
        fallback: 'job listed with nextRunAt null; one-shot fire detection is less precise',
        affects: ['GET /fetch-single-session/:id → scheduledJobs[].nextRunAt'],
        dedupeKey: `CRON_UNPARSEABLE|${job.cron}`,
      });
    }
    let nextRunAt: number | null;
    if (job.recurring) {
      if (now > job.createdAt + RECURRING_TTL_MS) continue; // auto-expired
      nextRunAt = spec ? nextRun(spec, now) : null;
    } else {
      nextRunAt = spec ? nextRun(spec, job.createdAt) : null;
      const firedAt = fires.get(job.prompt);
      const earliest = nextRunAt === null ? job.createdAt : nextRunAt - ONE_SHOT_EARLY_MS;
      if (firedAt !== undefined && firedAt >= Math.max(earliest, job.createdAt)) continue; // fired, auto-deleted
    }

    live.push({
      id: job.id,
      cron: job.cron,
      humanSchedule: job.humanSchedule,
      prompt: job.prompt,
      recurring: job.recurring,
      createdAt: job.createdAt,
      nextRunAt,
    });
  }
  return live.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
}
