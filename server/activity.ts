// Sessions started per day over one calendar year, for the Activity tab's contribution graph.
// Each session (live or exited) counts once, on the UTC day its transcript starts.

import fs from 'node:fs';
import { listTranscripts, readHead } from './completed.js';
import { guard } from './diagnostics.js';

export interface YearActivity {
  year: number;
  days: Record<string, number>; // 'YYYY-MM-DD' (UTC) -> sessions started that day; days with none are omitted
}

export function findYearActivity(year: number): YearActivity {
  const from = Date.UTC(year, 0, 1);
  const to = Date.UTC(year + 1, 0, 1); // exclusive
  const days: Record<string, number> = {};
  for (const { file } of listTranscripts()) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < from) continue; // last written before the year, so it started before it too
    const startedAt =
      guard(() => readHead(file).startedAt, null, {
        message: 'reading the start time of a transcript threw',
        where: 'server/completed.ts readHead()',
        source: file,
        fallback: 'start time taken from the file mtime',
        affects: ['GET /fetch-activity → days'],
      }) ?? mtimeMs;
    if (startedAt < from || startedAt >= to) continue;
    const day = new Date(startedAt).toISOString().slice(0, 10);
    days[day] = (days[day] ?? 0) + 1;
  }
  return { year, days };
}
