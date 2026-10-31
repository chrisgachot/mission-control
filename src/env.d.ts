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
  /**
   * LOCAL DEVELOPMENT ONLY (Security track). Set in .dev.vars, never in wrangler.jsonc or production
   * secrets. When set AND the request hostname is localhost or 127.0.0.1, the session middleware treats
   * the request as this (existing, non-removed) user id. Ignored on any other hostname.
   * See src/middleware/session.ts.
   */
  DEV_BYPASS_USER_ID?: string;
}

/** Hono generic: c.env is Bindings, c.get('user') is set by the session middleware. */
export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: { id: string; handle: string; role: 'owner' | 'admin' | 'member' } | null;
    requestId: string;
  };
};
