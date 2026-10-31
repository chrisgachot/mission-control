/// <reference types="@cloudflare/workers-types" />
// Test typings. `env` from 'cloudflare:test' is typed as Cloudflare.Env, so point it at our bindings.
import type { Bindings } from '../src/env.d.ts';

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}

export {};
