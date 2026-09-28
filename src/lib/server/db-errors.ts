import "server-only";

/* ==========================================================================
   IDENTIFYING WHICH CONSTRAINT A WRITE VIOLATED.

   Several places in this codebase rely on catching a unique-violation and
   resolving it into a specific, honest answer: "you already have an active
   withdrawal", "that slot is taken", "this earning was already recorded". Each
   of those depends on knowing WHICH index rejected the row.

   THE CONSTRAINT NAME IS NOT IN THE ERROR'S OWN MESSAGE.

   Drizzle wraps the driver error in a `DrizzleQueryError` whose `message` is the
   rendered SQL plus its parameters — "Failed query: insert into …". The Postgres
   error that actually carries `constraint_name` is one level down, in `cause`.
   So the natural-looking

       err.message.includes("uniq_something")

   is never true in production. It IS true against a fake that throws a raw
   driver error, which is exactly how this survived in two money modules: the
   suites' fakes reproduced the message the code expected rather than the shape
   the real driver produces.

   The consequences were not cosmetic. In `creator-withdrawals` both branches
   were dead, so a second concurrent withdrawal reported `db_unavailable` instead
   of `withdrawal_already_pending`, and — worse — the same-request-id replay path
   never ran, so a genuinely retried request reported a database failure for a
   withdrawal that had in fact been created. In `creator-earnings` the duplicate
   race could not resolve to the existing earning.

   `interviews.ts` had already discovered this and fixed it locally. This module
   is that fix, extracted, so the lesson lives in one place rather than being
   rediscovered a third time.
   ========================================================================== */

/**
 * Every place a Postgres error might name the constraint it violated, flattened
 * into one searchable string.
 *
 * Walks the `cause` chain rather than assuming one level: a future driver or
 * wrapper may nest it further, and an empty string is the safe answer when
 * nothing names anything.
 */
export function constraintErrorText(error: unknown): string {
  const parts: string[] = [];
  let node: unknown = error;

  for (let depth = 0; node && depth < 5; depth += 1) {
    const asRecord = node as { constraint_name?: unknown; constraint?: unknown; message?: unknown };
    if (typeof asRecord.constraint_name === "string") parts.push(asRecord.constraint_name);
    // `constraint` is what some drivers call the same field.
    if (typeof asRecord.constraint === "string") parts.push(asRecord.constraint);
    if (typeof asRecord.message === "string") parts.push(asRecord.message);
    node = (node as { cause?: unknown }).cause;
  }

  return parts.join(" ");
}

/**
 * Whether `error` was this index rejecting the row.
 *
 * Matching a NAME rather than a code: `23505` says "some unique index refused
 * this", which is not enough when a table has several and each means something
 * different to the caller.
 */
export function violatesConstraint(error: unknown, constraintName: string): boolean {
  return constraintErrorText(error).includes(constraintName);
}
