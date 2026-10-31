/// <reference types="@cloudflare/workers-types" />

/** Worker bindings. Keep in sync with wrangler.jsonc. */
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Display name for this space, e.g. "Chris" or "Light Hill". */
  SPACE_NAME: string;
  /** 'personal' | 'shared' */
  SPACE_KIND: string;
  /** Set by the build (git tag or short sha). */
  APP_VERSION: string;
}

/** Hono generic: c.env is Bindings, c.get('user') is set by the session middleware. */
export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: { id: string; handle: string; role: 'owner' | 'admin' | 'member' } | null;
    requestId: string;
  };
};
