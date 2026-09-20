import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findYearActivity } from './activity.js';
import { findCompletedSession, findCompletedSessions } from './completed.js';
import { report } from './diagnostics.js';
import { parseTimeRange, ParamError } from './range.js';
import { findActiveSessions, findSession, PROJECTS_DIR } from './sessions.js';

const PORT = Number(process.env.PORT) || 9000;
const FRONTEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

const app = express();

// ?status=active (default) | completed
function statusParam(q: Record<string, unknown>): 'active' | 'completed' {
  const s = q.status ?? 'active';
  if (s === 'active' || s === 'completed') return s;
  throw new ParamError('status must be "active" or "completed"');
}

// 400 for bad query params. Anything else escaped every per-reader fallback, so the whole response is
// lost: logged as an error with the request that hit it.
function sendError(req: express.Request, res: express.Response, err: unknown): void {
  if (err instanceof ParamError) {
    res.status(400).json({ error: err.message });
    return;
  }
  report({
    code: 'ENDPOINT_FAILED',
    severity: 'error',
    message: `${req.method} ${req.originalUrl} answered 500`,
    where: `server/index.ts ${req.method} ${req.path}`,
    fallback: 'HTTP 500 with { error }; the frontend keeps its last data and logs to the browser console',
    affects: [`${req.method} ${req.route?.path ?? req.path} → entire response`],
    error: err,
    dedupeKey: `ENDPOINT_FAILED|${req.route?.path ?? req.path}|${(err as Error)?.message}`,
  });
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

// active:    every live session (polled by the dashboard)
// completed: sessions that exited, within ?timeRange=... (see range.ts); the resolved range is echoed back
app.get('/fetch-session-ids', (req, res) => {
  try {
    const status = statusParam(req.query);
    const range = status === 'completed' ? parseTimeRange(req.query) : null;
    const sessions = range ? findCompletedSessions(range) : findActiveSessions();
    res.json({
      fetchedAt: Date.now(),
      status,
      ...(range && { range }),
      sessionIds: sessions.map((s) => s.sessionId),
      sessions,
    });
  } catch (err) {
    sendError(req, res, err);
  }
});

// active:    live detail, or { status: 'closed' } once the process exits
// completed: full-history detail from the transcript, or 404 if there isn't one (or it's still live)
app.get('/fetch-single-session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    if (statusParam(req.query) === 'active') {
      res.json(findSession(sessionId) ?? { sessionId, status: 'closed' });
      return;
    }
    const session = findCompletedSession(sessionId);
    if (session) res.json(session);
    else res.status(404).json({ error: `No completed session ${sessionId}` });
  } catch (err) {
    sendError(req, res, err);
  }
});

// Sessions started per UTC day in ?year=YYYY (default: the current UTC year)
app.get('/fetch-activity', (req, res) => {
  try {
    const y = req.query.year;
    if (y !== undefined && (typeof y !== 'string' || !/^\d{4}$/.test(y))) throw new ParamError('year must be a 4-digit year');
    res.json(findYearActivity(y ? Number(y) : new Date().getUTCFullYear()));
  } catch (err) {
    sendError(req, res, err);
  }
});

app.use(express.static(FRONTEND_DIR));

// Errors thrown outside the route handlers' try/catch (e.g. inside express itself)
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  sendError(req, res, err);
});

// Last line of defence: log and keep serving rather than crash.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error) => {
    report({
      code: event === 'uncaughtException' ? 'UNCAUGHT_EXCEPTION' : 'UNHANDLED_REJECTION',
      severity: 'error',
      message: `${event} outside any request handler`,
      where: 'server/index.ts process',
      fallback: 'server kept running',
      error,
      dedupeKey: `${event}|${(error as Error)?.message}`,
    });
  });
}

app.listen(PORT, () => {
  console.log(`Session visualizer running at http://localhost:${PORT}`);
  console.log(`Reading Claude Code data from ${path.dirname(PROJECTS_DIR)}. Format problems are logged here as "━━ claude-dashboard" blocks.`);
});
