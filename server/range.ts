// Parses the time-range query params used with status=completed into absolute epoch-ms bounds.
//
//   ?timeRange=relative&period=7&unit=day          the last 7 days, up to now
//   ?timeRange=absolute&startDate=<date>&endDate=<date>   <date> is ISO 8601 or epoch ms
//
// Relative ranges resolve against the time of the request, so reloading the page slides the window.
// Calendar units step in local time, so "1 month" back from Mar 31 lands on Feb 28/29, not Mar 3.

export interface TimeRange {
  from: number; // epoch ms, inclusive
  to: number; // epoch ms, inclusive
}

// Bad or missing query params; endpoints answer 400 with the message.
export class ParamError extends Error {}

const STEP_BACK: Record<string, (d: Date, n: number) => void> = {
  hour: (d, n) => d.setHours(d.getHours() - n),
  day: (d, n) => d.setDate(d.getDate() - n),
  week: (d, n) => d.setDate(d.getDate() - 7 * n),
  month: (d, n) => d.setMonth(d.getMonth() - n),
  year: (d, n) => d.setFullYear(d.getFullYear() - n),
};

const param = (q: Record<string, unknown>, key: string): string | undefined =>
  typeof q[key] === 'string' && q[key] !== '' ? (q[key] as string) : undefined;

function parseDate(q: Record<string, unknown>, key: string): number {
  const v = param(q, key);
  if (!v) throw new ParamError(`${key} is required for timeRange=absolute`);
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) throw new ParamError(`${key} is not a valid date: ${v}`);
  return ms;
}

export function parseTimeRange(q: Record<string, unknown>, now = Date.now()): TimeRange {
  const kind = param(q, 'timeRange');

  if (kind === 'relative') {
    const period = Number(param(q, 'period'));
    if (!Number.isInteger(period) || period < 1) throw new ParamError('period must be a positive integer');
    const unit = param(q, 'unit')?.replace(/s$/, ''); // "days" -> "day"
    const step = unit && STEP_BACK[unit];
    if (!step) throw new ParamError(`unit must be one of: ${Object.keys(STEP_BACK).join(', ')}`);
    const from = new Date(now);
    step(from, period);
    return { from: from.getTime(), to: now };
  }

  if (kind === 'absolute') {
    const from = parseDate(q, 'startDate');
    const to = parseDate(q, 'endDate');
    if (from > to) throw new ParamError('startDate is after endDate');
    return { from, to };
  }

  throw new ParamError('timeRange must be "relative" or "absolute"');
}
