// Vitest setup. Applies migrations/0001_init.sql to the test D1 before each test file.
import { beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
// Vite inlines the file as a string at test time. TypeScript cannot resolve a relative .sql import, and
// wildcard ambient modules do not match relative specifiers, so the import is untyped on purpose.
// @ts-expect-error -- ?raw import of a .sql file; typed as string by Vite at runtime.
import migrationSql from '../migrations/0001_init.sql?raw';

/**
 * Splits a migration into single statements. Strips `--` line comments first, so the
 * migration must not contain `--` inside a string literal (it does not today).
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

beforeAll(async () => {
  for (const stmt of splitStatements(migrationSql)) {
    await env.DB.prepare(stmt).run();
  }
});
