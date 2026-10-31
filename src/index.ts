import { Hono } from 'hono';
import type { AppEnv } from './env.d.ts';
import { loadSession } from './middleware/session.ts';
import { router as mcpRouter } from './mcp/router.ts';
import { router as spaceRouter } from './api/space.ts';
import { router as boardRouter } from './api/board.ts';
import { router as workstreamsRouter } from './api/workstreams.ts';
import { router as projectsRouter } from './api/projects.ts';
import { router as setupRouter } from './api/setup.ts';
import { router as remoteRouter } from './api/remote.ts';
import { router as authRouter } from './api/auth.ts';
import { router as keysRouter } from './api/keys.ts';
import { router as invitesRouter } from './api/invites.ts';
import { router as membersRouter } from './api/members.ts';
import { router as remoteSpacesRouter } from './api/remote-spaces.ts';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.set('user', null);
  await next();
});

app.onError((err, c) => {
  console.log(JSON.stringify({ requestId: c.get('requestId'), event: 'error', message: err.message }));
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

app.get('/api/health', async (c) => {
  let db: 'ok' | 'error' = 'ok';
  let setupComplete = false;
  try {
    const row = await c.env.DB.prepare("SELECT value FROM space_meta WHERE key = 'setup_complete'").first<{ value: string }>();
    setupComplete = row?.value === '1';
  } catch {
    db = 'error';
  }
  return c.json({ ok: db === 'ok', version: c.env.APP_VERSION, db, setupComplete }, db === 'ok' ? 200 : 503);
});

// Agents. Token auth lives inside the router.
app.route('/mcp', mcpRouter);

// Browser API. Session is loaded for everything under /api; routers decide what they require.
app.use('/api/*', loadSession);
app.route('/api/space', spaceRouter);
app.route('/api/board', boardRouter);
app.route('/api/workstreams', workstreamsRouter);
app.route('/api/projects', projectsRouter);
app.route('/api/setup', setupRouter);
app.route('/api/remote', remoteRouter);
app.route('/api/auth', authRouter);
app.route('/api/keys', keysRouter);
app.route('/api/invites', invitesRouter);
app.route('/api/members', membersRouter);
app.route('/api/remote-spaces', remoteSpacesRouter);

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/mcp')) {
    return c.json({ error: { code: 'not_found', message: 'No such route.' } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
