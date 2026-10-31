/** Tiny shared state for the board page. Nothing here is persisted: plaintext never leaves memory. */
import type { Range, Tool } from '../../src/types.ts';
import type { Model } from './model.ts';

export const store = {
  model: null as Model | null,
  tool: null as Tool | null,
  range: '7d' as Range,
  handle: '',
  lastSyncAt: 0,
  /** Set in ?fixture=1 mode: actions do not hit the network. */
  fixture: false,
  /** Whether this space is shared (hides personal-only affordances). */
  spaceKind: 'personal' as 'personal' | 'shared',
};

export function model(): Model {
  if (!store.model) throw new Error('board not loaded');
  return store.model;
}

/** Late-bound callbacks so views can trigger page-level work without importing the page. */
export const hooks = {
  refresh: async (): Promise<void> => {},
  setTool: (_t: Tool | null): void => {},
};
