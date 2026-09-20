// Builds the tree of sub-agents (Agent tool spawns) for one session and reports each one's status.
//
// On-disk layout (Claude Code 2.1.x):
//   <projects>/<encoded-cwd>/<sessionId>.jsonl                          main transcript
//   <projects>/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl     sub-agent transcript
//   <projects>/<encoded-cwd>/<sessionId>/subagents/agent-<id>.meta.json { toolUseId, agentType, description, ... }
//
// Nesting is NOT inferred from folder layout (it's flat, even for nested agents). Each agent's parent is
// meta.parentAgentId (written for nested spawns), else whichever transcript contains the tool_use that
// spawned it (meta.toolUseId), else the transcript whose tool_result names it. That works at any depth.
//
// Transcripts are read incrementally (see transcripts.ts): a poll only parses the new bytes.

import fs from 'node:fs';
import path from 'node:path';
import { describe, guard, report } from './diagnostics.js';
import { indexFile, sweepCache, type FileIndex, type Notification, type ToolResultInfo } from './transcripts.js';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'killed' | 'interrupted';

export interface SubagentNode {
  agentId: string;
  agentType: string | null;
  description: string | null;
  initialPrompt: string | null; // the prompt its parent spawned it with, 100 chars max (see transcripts.ts)
  status: SubagentStatus;
  startedAt: number | null;
  lastActivityAt: number | null;
  children: SubagentNode[];
}

interface AgentMeta {
  toolUseId?: string;
  parentAgentId?: string; // present on nested spawns (spawnDepth > 1)
  agentType?: string;
  description?: string;
  stoppedByUser?: boolean;
}

const MAX_WALK_DEPTH = 4;
const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/;

const AFFECTS_TREE = ['GET /fetch-single-session/:id → subagents (nesting, agentType, description, status)'];

function readMeta(jsonlPath: string): AgentMeta | null {
  const file = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  let m: unknown;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // not every agent has one
    report({
      code: 'AGENT_META_UNREADABLE',
      severity: 'warn',
      message: "sub-agent meta file is unreadable or not valid JSON",
      where: 'server/subagents.ts readMeta()',
      source: file,
      expected: 'JSON object { toolUseId, parentAgentId?, agentType, description, stoppedByUser? }',
      fallback: "agent's parent, type and description come from the spawning tool_use instead",
      affects: AFFECTS_TREE,
      error,
    });
    return null;
  }
  const meta = m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
  const badField = meta && (['toolUseId', 'parentAgentId', 'agentType', 'description'] as const).find(
    (k) => meta[k] !== undefined && typeof meta[k] !== 'string'
  );
  if (!meta || badField) {
    report({
      code: 'AGENT_META_SHAPE',
      severity: 'warn',
      message: badField ? `sub-agent meta field ${badField} is not a string` : 'sub-agent meta file is not a JSON object',
      where: 'server/subagents.ts readMeta()',
      source: file,
      expected: '{ toolUseId?: string, parentAgentId?: string, agentType?: string, description?: string, stoppedByUser?: boolean }',
      actual: describe(m),
      sample: m,
      fallback: 'meta ignored; parent, type and description come from the spawning tool_use instead',
      affects: AFFECTS_TREE,
    });
    return null;
  }
  return meta as AgentMeta;
}

// agentId -> transcript path, found anywhere under <projectDir>/<sessionId>/
function findAgentFiles(sessionDir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) walk(p, depth + 1);
      } else if (ent.isFile()) {
        const m = AGENT_FILE_RE.exec(ent.name);
        if (m && !found.has(m[1])) found.set(m[1], p);
      }
    }
  };
  walk(sessionDir, 0);
  return found;
}

function resolveStatus(
  own: FileIndex,
  meta: AgentMeta | null,
  spawnResult: ToolResultInfo | undefined,
  notification: Notification | undefined,
  mtimeMs: number,
  sessionStartedAt: number
): SubagentStatus {
  const lastActivity = own.lastTs ?? mtimeMs;

  // A parent-side verdict counts only if the agent hasn't written anything since (it can be resumed via SendMessage).
  if (notification && notification.ts >= lastActivity) {
    if (notification.status === 'completed') return 'completed';
    if (notification.status === 'killed' || notification.status === 'stopped') return 'killed';
    if (notification.status === 'failed' || notification.status === 'error') return 'failed';
  }
  if (spawnResult && !spawnResult.isAsync && spawnResult.ts >= lastActivity) {
    // foreground agent: the Agent tool call itself returned
    if (spawnResult.interrupted) return 'interrupted';
    return spawnResult.isError ? 'failed' : 'completed';
  }
  if (meta?.stoppedByUser) return 'killed';
  if (own.tail === 'ended') return 'completed'; // finished; parent notification may still be in flight
  if (own.tail === 'interrupted') return 'interrupted';

  // Mid-flight, but the process running this session started after the agent's last write:
  // it belonged to an earlier (exited) process and will never finish.
  if (sessionStartedAt && Math.max(mtimeMs, lastActivity) < sessionStartedAt) return 'interrupted';
  return 'running';
}

export interface SessionQuery {
  sessionId: string;
  logPath: string | null;
  projectsDir: string;
  startedAt: number; // session process start (ms)
}

export const MAIN = ''; // key of the main transcript in SessionTranscripts.indexes

export interface SessionTranscripts {
  agentFiles: Map<string, string>; // agentId -> transcript path
  indexes: Map<string, FileIndex>; // MAIN or agentId -> parsed transcript
}

function locateSessionDir(q: SessionQuery): string | null {
  if (q.logPath) {
    const dir = path.join(path.dirname(q.logPath), q.sessionId);
    if (fs.existsSync(dir)) return dir;
  }
  try {
    for (const project of fs.readdirSync(q.projectsDir)) {
      const dir = path.join(q.projectsDir, project, q.sessionId);
      if (fs.existsSync(dir)) return dir;
    }
  } catch {
    // no projects dir
  }
  return null;
}

// Indexes the main transcript plus every sub-agent transcript of the session.
export function loadSessionTranscripts(q: SessionQuery): SessionTranscripts {
  sweepCache();
  const sessionDir = locateSessionDir(q);
  const agentFiles = sessionDir ? findAgentFiles(sessionDir) : new Map<string, string>();
  const indexes = new Map<string, FileIndex>();
  // One unreadable transcript is dropped (and reported); the rest of the session still loads.
  const index = (file: string): FileIndex | null =>
    guard(() => indexFile(file), null, {
      message: 'reading a transcript threw',
      where: 'server/transcripts.ts indexFile()',
      source: file,
      fallback: 'transcript left out: its usage, spawns and results are missing',
      affects: ['GET /fetch-single-session/:id → cost, tokens, context, subagents, scheduledJobs'],
    });
  const mainIdx = q.logPath ? index(q.logPath) : null;
  if (mainIdx) indexes.set(MAIN, mainIdx);
  for (const [agentId, file] of agentFiles) {
    const idx = index(file);
    if (idx) indexes.set(agentId, idx);
  }
  return { agentFiles, indexes };
}

// By default only running agents are returned; see pruneFinished.
export function findSubagents(
  q: SessionQuery,
  { agentFiles, indexes: transcripts }: SessionTranscripts,
  { includeFinished = false } = {}
): SubagentNode[] {
  const ROOT = MAIN;

  // Which transcript owns each tool_use id, and which agent ids appear in spawn results.
  const spawnOwner = new Map<string, string>(); // toolUseId -> owner agentId
  const resultByAgent = new Map<string, { owner: string; toolUseId: string }>();
  const notifications = new Map<string, Notification>();
  for (const [owner, idx] of transcripts) {
    for (const id of idx.spawns.keys()) spawnOwner.set(id, owner);
    for (const [toolUseId, r] of idx.toolResults) {
      if (r.agentId) resultByAgent.set(r.agentId, { owner, toolUseId });
    }
    for (const [agentId, n] of idx.notifications) {
      const prev = notifications.get(agentId);
      if (!prev || n.ts >= prev.ts) notifications.set(agentId, n);
    }
  }

  const nodes = new Map<string, SubagentNode>();
  const parentOf = new Map<string, string>();

  for (const [agentId, file] of agentFiles) {
    const own = transcripts.get(agentId);
    if (!own) continue;
    const meta = readMeta(file);
    const toolUseId = meta?.toolUseId ?? resultByAgent.get(agentId)?.toolUseId ?? null;

    // Only real Agent-tool spawns count. Internal side-agents (compaction, etc.) have no spawning tool_use.
    if (!toolUseId) continue;

    const declaredParent = meta?.parentAgentId && agentFiles.has(meta.parentAgentId) ? meta.parentAgentId : undefined;
    const owner = declaredParent ?? spawnOwner.get(toolUseId) ?? resultByAgent.get(agentId)?.owner ?? ROOT;
    const ownerIdx = transcripts.get(spawnOwner.get(toolUseId) ?? owner); // transcript holding the spawning tool_use
    const spawn = ownerIdx?.spawns.get(toolUseId);

    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // vanished between walk and stat
    }

    nodes.set(agentId, {
      agentId,
      agentType: meta?.agentType ?? spawn?.agentType ?? null,
      description: meta?.description ?? spawn?.description ?? null,
      initialPrompt: own.initialPrompt,
      status: resolveStatus(own, meta, ownerIdx?.toolResults.get(toolUseId), notifications.get(agentId), mtimeMs, q.startedAt),
      startedAt: own.firstTs,
      lastActivityAt: own.lastTs,
      children: [],
    });
    parentOf.set(agentId, owner === agentId ? ROOT : owner);
  }

  // Attach to parents. Anything whose parent is unknown or would form a cycle goes at the top level.
  const roots: SubagentNode[] = [];
  const reachesRoot = (id: string): boolean => {
    const seen = new Set<string>();
    let cur = parentOf.get(id);
    while (cur && cur !== ROOT) {
      if (seen.has(cur) || !nodes.has(cur)) return false;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return true;
  };
  for (const [agentId, node] of nodes) {
    const parent = parentOf.get(agentId);
    if (parent && parent !== ROOT && reachesRoot(agentId)) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }

  const byStart = (a: SubagentNode, b: SubagentNode) => (a.startedAt ?? 0) - (b.startedAt ?? 0);
  const sortTree = (list: SubagentNode[]): void => {
    list.sort(byStart);
    for (const n of list) sortTree(n.children);
  };
  sortTree(roots);
  return includeFinished ? roots : pruneFinished(roots);
}

// Keep only running agents, plus finished ones that still have running descendants (so nesting stays intact).
function pruneFinished(nodes: SubagentNode[]): SubagentNode[] {
  const kept: SubagentNode[] = [];
  for (const n of nodes) {
    const children = pruneFinished(n.children);
    if (n.status === 'running' || children.length) kept.push({ ...n, children });
  }
  return kept;
}
