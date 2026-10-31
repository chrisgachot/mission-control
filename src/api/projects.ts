/** /api/projects: list (session), create and patch (owner/admin). */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import { apiError, readJson } from './_http.ts';
import { requireCsrfHeader } from './_csrf.ts';
import { activeNameTaken, createProject, getProject, listProjects, updateProject } from '../db/projects.ts';
import { requireRole, requireSession } from '../middleware/session.ts';

export const router = new Hono<AppEnv>();

const NameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, 'Name must not be empty.')
      .max(60, 'Name must be 60 characters or fewer.')
      .refine((s) => !/[\r\n\t]/.test(s), 'Name must be a single line.'),
  );

const CreateBody = z.object({ name: NameSchema });
const PatchBody = z
  .object({
    name: NameSchema.optional(),
    archived: z.boolean().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .refine((b) => b.name !== undefined || b.archived !== undefined || b.sortOrder !== undefined, 'Nothing to change.');

router.get('/', requireSession, async (c) => c.json({ projects: await listProjects(c.env.DB) }));

router.post('/', requireCsrfHeader, requireSession, requireRole(['owner', 'admin']), async (c) => {
  const parsed = await readJson(c, CreateBody);
  if (!parsed.ok) return parsed.res;
  const { name } = parsed.data;
  if (await activeNameTaken(c.env.DB, name, null)) {
    return apiError(c, 409, 'name_taken', 'A project with that name already exists.');
  }
  const project = await createProject(c.env.DB, name, Date.now());
  return c.json({ project }, 201);
});

router.patch('/:id', requireCsrfHeader, requireSession, requireRole(['owner', 'admin']), async (c) => {
  const parsed = await readJson(c, PatchBody);
  if (!parsed.ok) return parsed.res;
  const patch = parsed.data;
  const id = c.req.param('id');
  const existing = await getProject(c.env.DB, id);
  if (!existing) return apiError(c, 404, 'not_found', 'No such project.');

  if (patch.name !== undefined && existing.remoteSpaceId) {
    return apiError(c, 400, 'bad_request', 'A shared project is named in its shared space.');
  }
  const nameAfter = patch.name ?? existing.name;
  const archivedAfter = patch.archived ?? existing.archivedAt !== null;
  const nameChanged = patch.name !== undefined && patch.name !== existing.name;
  const unarchiving = patch.archived === false && existing.archivedAt !== null;
  if (!archivedAfter && (nameChanged || unarchiving) && (await activeNameTaken(c.env.DB, nameAfter, id))) {
    return apiError(c, 409, 'name_taken', 'A project with that name already exists.');
  }

  // Archiving an already archived project (or unarchiving an active one) must not move archived_at.
  const archivedPatch =
    patch.archived !== undefined && patch.archived !== (existing.archivedAt !== null) ? { archived: patch.archived } : {};
  const updated = await updateProject(
    c.env.DB,
    id,
    {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...archivedPatch,
    },
    Date.now(),
  );
  return c.json({ project: updated });
});
