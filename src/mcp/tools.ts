/** MCP tool implementations (docs/ARCHITECTURE.md section 4). */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { encryptCurrent, NoSpaceKeyError } from '../db/encrypt.ts';
import { getProject, listActiveProjects, upsertMirrorProjects } from '../db/projects.ts';
import { getRemoteSpace, listRemoteSpaces } from '../db/spaces.ts';
import { applyAgentEvent, findByExternalId, findWorkstreams, getWorkstream, insertStarted } from '../db/workstreams.ts';
import type { AgentEventKind } from '../db/workstreams.ts';
import type { Bindings } from '../env.d.ts';
import { forwardEvent, listRemoteProjects } from '../forward.ts';
import type { ForwardEvent } from '../forward.ts';
import { TOOLS } from '../types.ts';
import type { ProjectRow, Status, WorkstreamRow } from '../types.ts';

export interface ToolContext {
  env: Bindings;
  user: { id: string; handle: string };
  /** Runs work after the response is sent. */
  waitUntil: (p: Promise<unknown>) => void;
}

/** Short reporting rules. Sent as the MCP `instructions` and returned by list_projects. */
export const REPORTING_RULES =
  'Report only when state changes, never every step. Call `list_projects` first and pick an existing project; you cannot create projects. ' +
  '`report_started` when you begin a piece of work, `report_milestone` for one-line progress such as "tests passing", ' +
  '`report_waiting` when you need the person (say exactly what: "approve $214", "pick a timeout"), `report_done` with a one-line result. ' +
  'Keep titles short and imperative. If you were given a workstream id or external id earlier, reuse it instead of starting a new one.';

class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

function okResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] };
}

/** Runs a tool body and turns any failure into a clean tool error (never a transport-level 500). */
async function guarded(name: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err.code, err.message);
    if (err instanceof NoSpaceKeyError) return errorResult('setup_incomplete', err.message);
    console.log(JSON.stringify({ event: 'mcp_tool_error', tool: name, message: err instanceof Error ? err.message : 'unknown' }));
    return errorResult('internal', 'Mission Control could not save that report. It is safe to retry once.');
  }
}

function forwardInBackground(ctx: ToolContext, project: ProjectRow, build: (remoteProjectId: string) => ForwardEvent): void {
  if (!project.remoteSpaceId || !project.remoteProjectId) return;
  const spaceId = project.remoteSpaceId;
  const remoteProjectId = project.remoteProjectId;
  ctx.waitUntil(
    (async () => {
      try {
        const rs = await getRemoteSpace(ctx.env.DB, spaceId);
        if (rs) await forwardEvent(ctx.env, rs, build(remoteProjectId));
      } catch {
        // forwardEvent records its own failures; nothing may reach the agent.
      }
    })(),
  );
}

async function loadOwnedWorkstream(ctx: ToolContext, id: string, now: number): Promise<{ ws: WorkstreamRow; project: ProjectRow }> {
  const ws = await getWorkstream(ctx.env.DB, id, now);
  if (!ws || (ws.originUserId !== null && ws.originUserId !== ctx.user.id)) {
    throw new ToolError('not_found', 'No workstream with that id. Use find_workstreams or report_started.');
  }
  if (ws.status === 'archived') {
    throw new ToolError('archived', 'That workstream was archived by the person. Call report_started to begin a new one.');
  }
  const project = await getProject(ctx.env.DB, ws.projectId);
  if (!project) throw new ToolError('not_found', 'The workstream\'s project no longer exists.');
  return { ws, project };
}

async function listProjectsTool(ctx: ToolContext): Promise<CallToolResult> {
  const now = Date.now();
  const spaces = await listRemoteSpaces(ctx.env.DB);
  const fetched = spaces.length > 0 ? await listRemoteProjects(ctx.env, spaces) : [];
  const okRemote = new Map<string, Set<string>>();
  for (const r of fetched) {
    if (r.projects) {
      await upsertMirrorProjects(
        ctx.env.DB,
        r.space.id,
        r.projects.map((p) => ({ id: p.id, name: p.name })),
        now,
      );
      okRemote.set(r.space.id, new Set(r.projects.map((p) => p.id)));
    }
  }
  const spaceName = new Map(spaces.map((s) => [s.id, s.name] as const));
  const rows = await listActiveProjects(ctx.env.DB);
  const projects: { id: string; name: string; space: string }[] = [];
  for (const p of rows) {
    if (!p.remoteSpaceId) {
      projects.push({ id: p.id, name: p.name, space: ctx.env.SPACE_NAME });
      continue;
    }
    const live = okRemote.get(p.remoteSpaceId);
    // Space reachable: only projects it still lists. Space down: fall back to the last known mirror.
    if (live && !(p.remoteProjectId && live.has(p.remoteProjectId))) continue;
    projects.push({ id: p.id, name: p.name, space: spaceName.get(p.remoteSpaceId) ?? 'shared' });
  }
  return okResult({ projects, rules: REPORTING_RULES });
}

async function reportStartedTool(
  ctx: ToolContext,
  input: { title: string; project_id: string; tool: (typeof TOOLS)[number]; link?: string; external_id?: string },
): Promise<CallToolResult> {
  const now = Date.now();
  const project = await getProject(ctx.env.DB, input.project_id);
  if (!project || project.archivedAt !== null) {
    throw new ToolError('unknown_project', 'No such project. Call list_projects and use one of the returned ids.');
  }
  const title = input.title.trim();
  if (title.length === 0) throw new ToolError('bad_input', 'title must not be empty.');

  if (input.external_id) {
    const existing = await findByExternalId(ctx.env.DB, ctx.user.id, input.external_id, now);
    if (existing) {
      const existingProject = await getProject(ctx.env.DB, existing.projectId);
      return okResult({
        workstream_id: existing.id,
        title,
        project: existingProject ? existingProject.name : project.name,
        status: existing.status,
        reused: true,
      });
    }
  }

  const [titleSealed, linkSealed] = await Promise.all([
    encryptCurrent(ctx.env.DB, title),
    input.link ? encryptCurrent(ctx.env.DB, input.link) : Promise.resolve(null),
  ]);
  const id = await insertStarted(ctx.env.DB, {
    projectId: project.id,
    tool: input.tool,
    titleEnc: titleSealed.enc,
    linkEnc: linkSealed ? linkSealed.enc : null,
    externalId: input.external_id ?? null,
    keyId: titleSealed.keyId,
    originUserId: ctx.user.id,
    now,
  });
  forwardInBackground(ctx, project, (remoteProjectId) => ({
    kind: 'started',
    sourceId: id,
    remoteProjectId,
    tool: input.tool,
    title,
    link: input.link ?? null,
    at: now,
  }));
  return okResult({ workstream_id: id, title, project: project.name, status: 'running' });
}

async function reportUpdateTool(
  ctx: ToolContext,
  kind: AgentEventKind,
  workstreamId: string,
  text: string,
): Promise<CallToolResult> {
  const now = Date.now();
  const line = text.trim();
  if (line.length === 0) throw new ToolError('bad_input', 'The report text must not be empty.');
  const { ws, project } = await loadOwnedWorkstream(ctx, workstreamId, now);
  const sealed = await encryptCurrent(ctx.env.DB, line);
  const status: Status = await applyAgentEvent(ctx.env.DB, {
    workstreamId: ws.id,
    kind,
    bodyEnc: sealed.enc,
    keyId: sealed.keyId,
    now,
  });
  forwardInBackground(ctx, project, (remoteProjectId) => ({
    kind,
    sourceId: ws.id,
    remoteProjectId,
    tool: ws.tool,
    body: line,
    at: now,
  }));
  return okResult({ ok: true, status });
}

async function findWorkstreamsTool(
  ctx: ToolContext,
  input: { query?: string; external_id?: string; project_id?: string; status?: Status },
): Promise<CallToolResult> {
  const found = await findWorkstreams(
    ctx.env.DB,
    {
      originUserId: ctx.user.id,
      ...(input.query ? { query: input.query } : {}),
      ...(input.external_id ? { externalId: input.external_id } : {}),
      ...(input.project_id ? { projectId: input.project_id } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    Date.now(),
  );
  return okResult({
    workstreams: found.map((w) => ({
      id: w.id,
      project: w.project,
      tool: w.tool,
      status: w.status,
      stale: w.stale,
      created_at: w.createdAt,
      last_agent_at: w.lastAgentAt,
      external_id: w.externalId,
    })),
  });
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'List the projects you can report into (id, name, space). Call this first and pick an existing project; you cannot create projects. Also returns the reporting rules.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded('list_projects', () => listProjectsTool(ctx)),
  );

  server.registerTool(
    'report_started',
    {
      title: 'Report work started',
      description:
        'Call when you begin a piece of work. Returns a workstream_id to use in later reports. If external_id matches an existing workstream it is returned instead of creating a new one.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short, imperative title of the work, 80 characters or fewer. Example: "Draft Q4 board update".'),
        project_id: z.string().min(1).max(100).describe('Project id from list_projects.'),
        tool: z.enum(TOOLS).describe('Which product you are running in: code (Claude Code), cowork, duet, chat (Claude chat) or chatgpt.'),
        link: z.string().max(2000).optional().describe('URL that takes the person back into this session, if your product has one.'),
        external_id: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Your session or thread id, so a later session can resume the same workstream instead of starting a new one.'),
      },
    },
    (args) => guarded('report_started', () => reportStartedTool(ctx, args)),
  );

  server.registerTool(
    'report_milestone',
    {
      title: 'Report a milestone',
      description: 'One-line progress worth the person seeing, such as "tests passing". Not for every step.',
      inputSchema: {
        workstream_id: z.string().min(1).max(100).describe('The workstream_id returned by report_started or find_workstreams.'),
        note: z.string().min(1).max(1000).describe('One line of progress.'),
      },
    },
    (args) => guarded('report_milestone', () => reportUpdateTool(ctx, 'milestone', args.workstream_id, args.note)),
  );

  server.registerTool(
    'report_waiting',
    {
      title: 'Report waiting on the person',
      description: 'Call when you cannot continue without the person. Say exactly what you need, for example "approve $214" or "pick a timeout".',
      inputSchema: {
        workstream_id: z.string().min(1).max(100).describe('The workstream_id returned by report_started or find_workstreams.'),
        needed: z.string().min(1).max(1000).describe('Exactly what the person needs to do or decide.'),
      },
    },
    (args) => guarded('report_waiting', () => reportUpdateTool(ctx, 'waiting', args.workstream_id, args.needed)),
  );

  server.registerTool(
    'report_done',
    {
      title: 'Report work done',
      description: 'Call when the work is finished, with a one-line result.',
      inputSchema: {
        workstream_id: z.string().min(1).max(100).describe('The workstream_id returned by report_started or find_workstreams.'),
        result: z.string().min(1).max(1000).describe('One-line result, for example "PR #214 merged".'),
      },
    },
    (args) => guarded('report_done', () => reportUpdateTool(ctx, 'done', args.workstream_id, args.result)),
  );

  server.registerTool(
    'find_workstreams',
    {
      title: 'Find workstreams',
      description:
        'Look up existing workstreams to resume one. Titles are encrypted, so matching works only on external_id, project and status; query is matched against external_id and project name.',
      inputSchema: {
        query: z.string().max(200).optional().describe('Text matched against external_id and project name.'),
        external_id: z.string().max(200).optional().describe('Exact external_id (your session or thread id).'),
        project_id: z.string().max(100).optional().describe('Only workstreams in this project.'),
        status: z.enum(['running', 'waiting', 'done', 'archived']).optional().describe('Only workstreams with this status.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('find_workstreams', () => findWorkstreamsTool(ctx, args)),
  );
}
