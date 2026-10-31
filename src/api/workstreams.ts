/** GET /api/workstreams/:id and POST /api/workstreams/:id/action (session). */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import { apiError, readJson } from './_http.ts';
import { requireCsrfHeader } from './_csrf.ts';
import { encryptCurrent, NoSpaceKeyError } from '../db/encrypt.ts';
import { getProject } from '../db/projects.ts';
import { applyPersonAction, getWorkstream, listUpdatesForWorkstream } from '../db/workstreams.ts';
import { requireSession } from '../middleware/session.ts';
import type { PersonAction, Status, WorkstreamDetail } from '../types.ts';

export const router = new Hono<AppEnv>();

const ActionBody = z.object({ action: z.enum(['handled', 'snooze', 'archive', 'resume', 'reopen']) });

/** Which stored statuses each person action may start from. */
const ALLOWED_FROM: Record<PersonAction, Status[]> = {
  handled: ['waiting', 'running'],
  snooze: ['waiting', 'running'],
  archive: ['running', 'waiting', 'done'],
  resume: ['running', 'waiting'],
  reopen: ['done', 'archived'],
};

const ACTION_TEXT: Record<PersonAction, string> = {
  handled: 'Handled',
  snooze: 'Snoozed for a day',
  archive: 'Archived',
  resume: 'Resumed',
  reopen: 'Reopened',
};

async function loadDetail(c: Parameters<typeof apiError>[0], id: string): Promise<WorkstreamDetail | null> {
  const now = Date.now();
  const workstream = await getWorkstream(c.env.DB, id, now);
  if (!workstream) return null;
  const [updates, project] = await Promise.all([listUpdatesForWorkstream(c.env.DB, id), getProject(c.env.DB, workstream.projectId)]);
  if (!project) return null;
  return { workstream, updates, project };
}

router.get('/:id', requireSession, async (c) => {
  const detail = await loadDetail(c, c.req.param('id'));
  if (!detail) return apiError(c, 404, 'not_found', 'No such workstream.');
  return c.json(detail);
});

router.post('/:id/action', requireCsrfHeader, requireSession, async (c) => {
  const parsed = await readJson(c, ActionBody);
  if (!parsed.ok) return parsed.res;
  const { action } = parsed.data;
  const id = c.req.param('id');

  const current = await getWorkstream(c.env.DB, id, Date.now());
  if (!current) return apiError(c, 404, 'not_found', 'No such workstream.');
  if (!ALLOWED_FROM[action].includes(current.status)) {
    return apiError(c, 409, 'invalid_state', 'Cannot ' + action + ' a workstream that is ' + current.status + '.');
  }

  let sealed;
  try {
    sealed = await encryptCurrent(c.env.DB, ACTION_TEXT[action]);
  } catch (err) {
    if (err instanceof NoSpaceKeyError) return apiError(c, 409, 'setup_incomplete', err.message);
    throw err;
  }
  await applyPersonAction(c.env.DB, { workstreamId: id, action, bodyEnc: sealed.enc, keyId: sealed.keyId, now: Date.now() });

  const detail = await loadDetail(c, id);
  if (!detail) return apiError(c, 404, 'not_found', 'No such workstream.');
  return c.json(detail);
});
