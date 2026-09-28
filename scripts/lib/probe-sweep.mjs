/**
 * SWEEPING UP AFTER A PROCESS THAT WAS KILLED.
 *
 * Two suites create a uniquely-named probe TABLE in `public` — they are testing
 * real Postgres behaviour (advisory locks, `DELETE … RETURNING` races) that a
 * throwaway schema would not change — and each drops its table in a `finally`.
 *
 * `finally` IS NOT A GUARANTEE. A timeout, a Ctrl-C, an OOM kill or a crashed
 * connection all end the process without running it. Task #30 found eight such
 * tables left in the real database from earlier runs:
 *
 *   concurrency_probe_*  ×5      oauth_state_probe_*    ×2
 *   oauth_refresh_probe_* ×1
 *
 * Each held a single row of synthetic data. Harmless individually, but the set
 * only ever grows, and litter in a production-bound database is the kind of
 * thing that later gets mistaken for real state.
 *
 * So cleanup does not rely on the previous run having exited politely: a suite
 * sweeps its own prefix on the way IN. That makes the mess self-healing — running
 * the suite once clears whatever a killed predecessor left — and needs no manual
 * database surgery.
 *
 * Deliberately prefix-scoped. It drops only tables matching the exact probe
 * prefixes below, never a pattern that could reach an application table.
 */

/** The only prefixes this may ever drop. Adding one is a deliberate act. */
const ALLOWED_PREFIXES = [
  "oauth_state_probe_",
  "oauth_switch_probe_",
  "oauth_refresh_probe_",
  "concurrency_probe_",
];

/**
 * Drops leftover probe tables for `prefix` in `public`.
 *
 * @param sql a postgres.js client
 * @param prefix one of ALLOWED_PREFIXES
 * @returns the names dropped
 */
export async function sweepProbeTables(sql, prefix) {
  if (!ALLOWED_PREFIXES.includes(prefix)) {
    throw new Error(`refusing to sweep an unapproved prefix: ${prefix}`);
  }

  /* A BELT AND A BRACE. The LIKE is parameterised so the prefix cannot be
   * injected, and the name is re-checked against the prefix in JS before it is
   * interpolated into the DROP — an identifier cannot be bound as a parameter,
   * so the only safe interpolation is one already proven to match. */
  const rows = await sql`
    select table_name from information_schema.tables
     where table_schema = 'public'
       and table_name like ${prefix + "%"}`;

  const dropped = [];
  for (const { table_name: name } of rows) {
    if (!name.startsWith(prefix)) continue;
    if (!/^[a-z0-9_]+$/.test(name)) continue;
    await sql.unsafe(`drop table if exists public."${name}"`);
    dropped.push(name);
  }
  return dropped;
}
