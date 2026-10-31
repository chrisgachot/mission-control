/** What pages need from the router in app.ts. */
export interface Host {
  navigate(path: string, replace?: boolean): void;
  /** Session or vault lost (or user pressed Lock): show the unlock screen, then re-route. */
  onAuthLost(): void;
  /** Re-run the router for the current location. */
  route(): void;
}

/** The Security track's NeedsRecoveryCode, detected by name so this file does not depend on how it is declared. */
export function isNeedsRecoveryCode(e: unknown): boolean {
  return e instanceof Error && (e.name === 'NeedsRecoveryCode' || e.constructor?.name === 'NeedsRecoveryCode');
}
