/**
 * /api/members/* (Security track). Contract: docs/ARCHITECTURE.md §3 "Remove", §7.
 *
 *   GET    /     admin -> { members: [{ id, handle, role, createdAt, publicKey }] }  (active members only)
 *   DELETE /:id  admin -> { ok, rotationRequired: true }
 *
 * Removal is server-side revocation (sessions, member tokens, connector tokens, wrapped keys, removed_at),
 * but the removed person may already hold the shared private key in a browser or a copy of the database.
 * Only a key rotation protects data written after removal, so the response tells the admin's browser to
 * run vault.rotateAfterRemoval() right away. History written before removal stays readable to anyone who
 * held the old key, including the removed member; that is inherent and documented.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.d.ts';
import { requireRole } from '../middleware/session.ts';
import { getActiveUser, listUsers, removeMember } from '../auth/db.ts';
import { fail, logEvent } from '../auth/http.ts';

export const router = new Hono<AppEnv>();

router.use('*', requireRole(['admin', 'owner']));

router.get('/', async (c) => {
  const users = await listUsers(c.env.DB);
  return c.json({
    members: users
      .filter((u) => u.removed_at === null)
      .map((u) => ({ id: u.id, handle: u.handle, role: u.role, createdAt: u.created_at, publicKey: u.public_key })),
  });
});

router.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!z.uuid().safeParse(id).success) return fail(c, 404, 'not_found', 'No such member.');
  const me = c.get('user')!;
  if (id === me.id) return fail(c, 400, 'cannot_remove_self', 'You cannot remove yourself.');
  const target = await getActiveUser(c.env.DB, id);
  if (!target) return fail(c, 404, 'not_found', 'No such member.');
  if (target.role === 'owner') return fail(c, 403, 'forbidden', 'The owner cannot be removed.');

  const ok = await removeMember(c.env.DB, id, Date.now());
  if (!ok) return fail(c, 404, 'not_found', 'No such member.');
  logEvent(c, 'members.remove', { by: me.id, userId: id });
  return c.json({
    ok: true,
    rotationRequired: true,
    message: 'Member removed. Rotate the space key now so they cannot read anything new.',
  });
});
