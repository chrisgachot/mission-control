import { TOOLS, TOOL_NAMES } from '../../src/types.ts';
import type { Tool } from '../../src/types.ts';

export { TOOLS };
export const TOOL_ORDER: readonly Tool[] = TOOLS;

export interface ToolUi {
  name: string;
  color: string;
  glyph: string; // inner SVG for a 16x16 viewBox, stroked
  verb: string; // quick-action pill on the Needs you list
  open: string; // "Open in ..." button label
}

export const TOOL_UI: Record<Tool, ToolUi> = {
  code: {
    name: TOOL_NAMES.code,
    color: '#0891b2',
    glyph: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
    verb: 'Decide',
    open: 'Open session',
  },
  cowork: {
    name: TOOL_NAMES.cowork,
    color: '#ec4899',
    glyph: '<rect x="3" y="2.5" width="10" height="11" rx="2"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>',
    verb: 'Review',
    open: 'Open in Cowork',
  },
  duet: {
    name: TOOL_NAMES.duet,
    color: '#65a30d',
    glyph: '<circle cx="6" cy="8" r="3.5"/><circle cx="10" cy="8" r="3.5"/>',
    verb: 'Approve',
    open: 'Open in Duet',
  },
  chat: {
    name: TOOL_NAMES.chat,
    color: '#8b5cf6',
    glyph: '<path d="M3 4.5A2 2 0 0 1 5 2.5h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7l-3 3v-3a2 2 0 0 1-1-1.7z"/>',
    verb: 'Reply',
    open: 'Open chat',
  },
  // ChatGPT green pulled toward mint so it stays apart from the cyan of Claude Code and the lime of Duet.
  chatgpt: {
    name: TOOL_NAMES.chatgpt,
    color: '#19c79a',
    glyph: '<path d="M8 1.8l5.2 3v6.4L8 14.2l-5.2-3V4.8z"/><circle cx="8" cy="8" r="1.7"/>',
    verb: 'Reply',
    open: 'Open in ChatGPT',
  },
};

/** UI status. 'needs' is the dashboard's word for a derived 'waiting' that is not snoozed. */
export type UiStatus = 'needs' | 'running' | 'stale' | 'done';

export const STATUS_UI: Record<UiStatus, { name: string; color: string; icon: string }> = {
  needs: {
    name: 'Needs you',
    color: 'var(--needs)',
    icon: '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l5.2 9.5H.8z"/><rect x="5.3" y="4.3" width="1.4" height="3.3" fill="#000"/><rect x="5.3" y="8.3" width="1.4" height="1.2" fill="#000"/></svg>',
  },
  running: {
    name: 'Running',
    color: 'var(--neon)',
    icon: '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="6" r="3"/></svg>',
  },
  stale: {
    name: 'Stale',
    color: 'var(--stale)',
    icon: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5V6l1.8 1.2"/></svg>',
  },
  done: {
    name: 'Done',
    color: 'var(--done)',
    icon: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>',
  },
};
