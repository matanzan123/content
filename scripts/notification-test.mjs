#!/usr/bin/env node
/**
 * TASK #22 — NOTIFICATIONS.
 *
 * Task #22's status was UNPROVEN because the notifications table had never
 * demonstrably been written by a trigger. This suite is that proof: it runs the
 * REAL triggers against a REAL Postgres table, through the real
 * `writeNotification`, and reads the rows back.
 *
 * WHY DB-BACKED. The deduplication mechanism IS the unique index on
 * `idempotency_key`. A recording fake cannot prove a key collides — only
 * Postgres can — so a suite that stubs the write can never test the one property
 * that matters most here.
 *
 * THE DEFECTS THIS EXISTS FOR:
 *   - every idempotency key was built from a provider resource id with NO
 *     environment, while the codebase's own comments state those ids "are not
 *     unique across environments". The key is globally unique, so the second
 *     environment's notification was silently swallowed.
 *   - `notifyPayoutCompleted(id, false)` builds a `payout_failed` notification
 *     and nothing ever passed `false` — a creator whose payout failed was never
 *     told.
 *   - `getNotifications` returned `[]` and `getUnreadCount` returned `0` on a
 *     database error, so an outage rendered as an empty inbox.
 *   - a negative `limit` reached `LIMIT -5`, which Postgres rejects; the error
 *     was swallowed and the creator saw an empty list.
 *   - pagination ordered by `created_at` alone, which is not unique.
 *
 * NO NETWORK. NOTHING IS WRITTEN TO public — every table the modules name
 * resolves to a throwaway schema, verified before a single row is written.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n--- ${t} ---`);

const SCRATCH = "notification_selftest";

/* =========================================================================
   Module loader. The only seams are the database and the environment.
   ========================================================================= */

const cache = new Map();
let DB = null;
let ENVIRONMENT = "sandbox";

function loadTs(file) {
  const key = resolve(file);
  if (cache.has(key)) return cache.get(key).exports;

  const js = ts.transpileModule(readFileSync(key, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  cache.set(key, mod);

  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec === "@/lib/db") {
      return {
        getDb: () => DB,
        isDatabaseConfigured: () => DB !== null,
        schema: loadTs("src/lib/db/schema.ts"),
      };
    }
    if (spec === "@whop/sdk") {
      return { WhopError: class WhopError extends Error {}, WhopClient: class {} };
    }
    if (spec === "./whop-payments" || spec.endsWith("/whop-payments")) {
      const real = loadTs("src/lib/server/whop-payments.ts");
      return { ...real, getWhopEnvironment: () => ENVIRONMENT };
    }
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      try { return loadTs(`${base}.ts`); } catch { return loadTs(`${base}/index.ts`); }
    }
    return require(spec);
  };

  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

/* ---------------------------------------------------------------- A ---- */
section("A. The key carries the environment");

{
  const code = readFileSync("src/lib/server/notification-triggers.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  check("keys are built by one helper, not assembled at each site",
    /function notificationKey\(/.test(code));
  check("and that helper takes the environment as an argument",
    /notificationKey\(\s*type: string,\s*environment: "sandbox" \| "production",/.test(code));

  /* NO PROVIDER-ID-ONLY KEY REMAINS. Each of these was a string identical in
   * both environments, against a globally unique column. */
  for (const stale of [
    "kyc_approved:${whopAccountId}",
    "kyc_rejected:${whopAccountId}",
    "earnings_held:${whopPaymentId}",
    "payout_succeeded:${providerTransferId}",
    "payout_failed:${providerTransferId}",
    "payout_reversed:${providerTransferId}",
    "dispute_opened:${whopDisputeId}",
  ]) {
    check(`the environment-free key \`${stale}\` is gone`, !code.includes(stale));
  }

  /* THE ONE EXCEPTION, and it is justified: a withdrawal id is our own uuid. */
  check("the withdrawal key stays environment-free, because its id is our uuid",
    code.includes("withdrawal_processing:${withdrawalId}"));
  check("and the reason is written down, not just done",
    /uuid from\s*\n?\s*\*?\s*our own/.test(readFileSync("src/lib/server/notification-triggers.ts", "utf8")));
}

/* =========================================================================
   The database part.
   ========================================================================= */

async function run() {
  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — DB sections skipped");
    return;
  }

  /* THE DIRECT ENDPOINT. `search_path` is session state and Neon's pooler is
   * PgBouncer in transaction mode, which can serve the next statement on a
   * different backend and silently drop the setting. `max: 1` keeps one. */
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  // Baselines on the REAL table, captured before anything runs.
  const [beforeNotifs] = await client`select count(*)::int as n from public.notifications`;
  const [beforeMigrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);
    await client.unsafe(`set search_path = ${SCRATCH}`);

    const [{ schema }] = await client`select current_schema() as schema`;
    if (schema !== SCRATCH) throw new Error(`ISOLATION FAILED — DDL would run in ${schema}`);

    /* THE WHOLE MIGRATION CHAIN IN JOURNAL ORDER, plus anything written but not
     * yet journalled. Naming migrations individually is how other suites fell
     * behind the schema; nothing here names one. */
    const journalFile = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    const journalledTags = journalFile.entries.map((e) => e.tag);
    const PENDING = [];
    const tags = [...journalledTags, ...PENDING.filter((t) => !journalledTags.includes(t))];

    for (const tag of tags) {
      const sql = readFileSync(`drizzle/${tag}.sql`, "utf8");
      for (const stmt of sql
        .split("--> statement-breakpoint")
        .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
        .filter(Boolean)) {
        try {
          await client.unsafe(stmt);
        } catch (err) {
          throw new Error(`DDL FAILED in ${tag}: ${String(err?.message ?? err).slice(0, 200)}`);
        }
      }
    }
    check("the full migration chain applies into the throwaway schema", true, `${tags.length} migrations`);

    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('notifications')) as notifs,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('whop_accounts')) as accounts`;
    const isolated =
      where.schema === SCRATCH && where.notifs === SCRATCH && where.accounts === SCRATCH;
    if (!isolated) {
      throw new Error(
        `ISOLATION FAILED — refusing to write: schema=${where.schema} notifications=${where.notifs} accounts=${where.accounts}`,
      );
    }
    check("ISOLATION PROVED: every table the modules name is in the throwaway schema",
      isolated, `${where.notifs}/${where.accounts}`);

    const { drizzle } = require("drizzle-orm/postgres-js");
    DB = drizzle(scoped);

    const svc = loadTs("src/lib/server/notifications.ts");
    const triggers = loadTs("src/lib/server/notification-triggers.ts");

    /* ---- fixtures ---- */
    const creator = async (uid) => {
      await scoped.unsafe(
        `insert into ${SCRATCH}.users (firebase_uid) values ($1) on conflict do nothing`, [uid]);
      return uid;
    };
    const account = async (uid, accountId, environment) => {
      await scoped.unsafe(
        `insert into ${SCRATCH}.whop_accounts
           (firebase_uid, whop_account_id, whop_user_id, parent_account_id, environment)
         values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [uid, accountId, `user_${uid}`, "biz_parent", environment]);
    };
    const rowsFor = async (uid) => scoped.unsafe(
      `select type, title, idempotency_key, status, created_at, notification_id
         from ${SCRATCH}.notifications where firebase_uid = $1
        order by created_at desc, notification_id desc`, [uid]);
    const countAll = async () => (await scoped.unsafe(
      `select count(*)::int as n from ${SCRATCH}.notifications`))[0].n;

    /* ------------------------------------------------------------ B ---- */
    section("B. A real trigger writes a real row");

    {
      const uid = await creator("n_settle");
      await account(uid, "biz_settle", "sandbox");
      await scoped.unsafe(
        `insert into ${SCRATCH}.creator_earnings
           (firebase_uid, environment, whop_payment_id, gross_amount_minor,
            platform_fee_minor, net_amount_minor, currency, platform_fee_bps,
            status, hold_until, payment_settled_at)
         values ($1,'sandbox','pay_n1',1000,200,800,'usd',2000,'held', now(), now())`,
        [uid]);

      ENVIRONMENT = "sandbox";
      await triggers.notifyPaymentSettled("pay_n1");

      const rows = await rowsFor(uid);
      check("notifyPaymentSettled persists exactly one notification",
        rows.length === 1, String(rows.length));
      check("of the right type, to the creator who owns the earning",
        rows[0]?.type === "earnings_held", rows[0]?.type);
      check("and its key now carries the environment",
        rows[0]?.idempotency_key === "earnings_held:sandbox:pay_n1", rows[0]?.idempotency_key);
      check("it starts unread", rows[0]?.status === "unread");
    }

    /* ------------------------------------------------------------ C ---- */
    section("C. Replay and concurrency converge on one notification");

    {
      const uid = "n_settle";
      // A redelivered webhook: the same event, again.
      await triggers.notifyPaymentSettled("pay_n1");
      await triggers.notifyPaymentSettled("pay_n1");
      check("a replayed event does NOT create a second notification",
        (await rowsFor(uid)).length === 1, String((await rowsFor(uid)).length));

      /* CONCURRENT DELIVERY. Two handlers racing on the same event: the unique
       * index is what decides, and it admits exactly one. A recording fake could
       * never show this — only the real constraint can. */
      await Promise.all([
        triggers.notifyPaymentSettled("pay_n1"),
        triggers.notifyPaymentSettled("pay_n1"),
        triggers.notifyPaymentSettled("pay_n1"),
      ]);
      check("three concurrent triggers still leave exactly one",
        (await rowsFor(uid)).length === 1, String((await rowsFor(uid)).length));

      /* THE WRITE REPORTS WHETHER IT CREATED ANYTHING, so a caller can tell a
       * first delivery from a replay without counting rows. */
      const first = await svc.writeNotification({
        firebaseUid: uid, type: "t", title: "a", body: "b",
        idempotencyKey: "explicit:sandbox:once",
      });
      const again = await svc.writeNotification({
        firebaseUid: uid, type: "t", title: "a", body: "b",
        idempotencyKey: "explicit:sandbox:once",
      });
      check("the first write reports created", first.ok === true && first.created === true);
      check("the duplicate reports ok but NOT created",
        again.ok === true && again.created === false);
    }

    /* ------------------------------------------------------------ D ---- */
    section("D. Environments cannot cross-notify");

    {
      /* THE SAME PROVIDER ID IN BOTH ENVIRONMENTS, owned by different creators —
       * exactly what migration 0011 permits and what the old key could not tell
       * apart. */
      const sb = await creator("n_sandbox");
      const pr = await creator("n_production");
      await account(sb, "biz_both", "sandbox");
      await account(pr, "biz_both", "production");

      ENVIRONMENT = "sandbox";
      await triggers.notifyAccountUpdated("biz_both", "active");
      ENVIRONMENT = "production";
      await triggers.notifyAccountUpdated("biz_both", "active");

      const sbRows = await rowsFor(sb);
      const prRows = await rowsFor(pr);

      check("the sandbox creator is notified", sbRows.length === 1, String(sbRows.length));
      check("and so is the production creator — the second is NOT swallowed",
        prRows.length === 1, String(prRows.length));
      check("their keys differ by environment",
        sbRows[0]?.idempotency_key === "kyc_approved:sandbox:biz_both" &&
          prRows[0]?.idempotency_key === "kyc_approved:production:biz_both",
        `${sbRows[0]?.idempotency_key} / ${prRows[0]?.idempotency_key}`);

      /* OWNERSHIP. Neither creator received the other's notification. */
      check("no cross-notification occurred in either direction",
        sbRows.every((r) => r.idempotency_key.includes(":sandbox:")) &&
          prRows.every((r) => r.idempotency_key.includes(":production:")));

      /* FAIL CLOSED — AGAINST RESOURCES THAT HAVE NOT BEEN NOTIFIED YET.
       *
       * This first used the ids from the block above, and that made the check
       * vacuous: those keys already existed, so a trigger that wrongly defaulted
       * the environment to "sandbox" instead of refusing would build a key that
       * simply conflicted, write nothing, and leave the count unchanged. The
       * assertion passed for the wrong reason. Fresh ids mean any write at all
       * moves the count. */
      const freshUid = await creator("n_failclosed");
      await account(freshUid, "biz_fresh", "sandbox");
      await scoped.unsafe(
        `insert into ${SCRATCH}.creator_earnings
           (firebase_uid, environment, whop_payment_id, gross_amount_minor,
            platform_fee_minor, net_amount_minor, currency, platform_fee_bps,
            status, hold_until, payment_settled_at)
         values ($1,'sandbox','pay_fresh',1000,200,800,'usd',2000,'held', now(), now())`,
        [freshUid]);

      const before = await countAll();
      ENVIRONMENT = null;
      await triggers.notifyAccountUpdated("biz_fresh", "active");
      await triggers.notifyPaymentSettled("pay_fresh");
      await triggers.notifyDisputeOpened("pay_fresh", "dp_fresh");
      check("an unresolvable environment writes nothing at all",
        (await countAll()) === before, `${before} -> ${await countAll()}`);
      ENVIRONMENT = "sandbox";
    }

    /* ------------------------------------------------------------ E ---- */
    section("E. Ownership comes from local mapping, never a payload");

    {
      const before = await countAll();
      /* A PAYLOAD INSISTING ON ANOTHER ENVIRONMENT, through the real dispatcher. */
      await triggers.fireWebhookNotifications("account.updated", "biz_both", {
        data: { id: "biz_both", status: "active", environment: "production" },
        environment: "production",
      });
      const sbRows = await rowsFor("n_sandbox");
      const prRows = await rowsFor("n_production");
      check("a payload claiming production cannot notify the production creator",
        prRows.length === 1, String(prRows.length));
      check("and the sandbox creator's notification is not duplicated either",
        sbRows.length === 1, String(sbRows.length));
      check("so the lying payload changed nothing", (await countAll()) === before);

      /* AN UNKNOWN PROVIDER ID notifies nobody rather than guessing. */
      await triggers.notifyAccountUpdated("biz_does_not_exist", "active");
      check("an account id with no local owner notifies nobody",
        (await countAll()) === before);
    }

    /* ------------------------------------------------------------ F ---- */
    section("F. A failed payout is finally reported");

    {
      const uid = await creator("n_payout");
      await scoped.unsafe(
        `insert into ${SCRATCH}.creator_transfers
           (firebase_uid, whop_account_id, environment, provider_transfer_id,
            amount_minor, currency, status, purpose, idempotency_key, initiated_by_uid)
         values ($1,'biz_payout','sandbox','trf_fail',1000,'usd','submitted','test',
                 'trf:sandbox:fail','admin_test')`, [uid]);

      ENVIRONMENT = "sandbox";
      /* THE DISPATCHER, not the trigger directly — the failure branch existed and
       * nothing ever reached it. */
      for (const status of ["failed", "denied", "canceled"]) {
        await scoped.unsafe(
          `delete from ${SCRATCH}.notifications where firebase_uid = $1`, [uid]);
        await triggers.fireWebhookNotifications("payout.updated", "trf_fail", {
          data: { id: "trf_fail", status },
        });
        const rows = await rowsFor(uid);
        check(`a payout reported "${status}" notifies the creator`,
          rows.length === 1 && rows[0].type === "payout_failed",
          rows.map((r) => r.type).join(",") || "none");
      }

      /* AND A NON-TERMINAL STATUS STILL SAYS NOTHING — the point is not to
       * notify on everything, it is to notify on outcomes. */
      for (const status of ["requested", "in_review", "processing"]) {
        await scoped.unsafe(
          `delete from ${SCRATCH}.notifications where firebase_uid = $1`, [uid]);
        await triggers.fireWebhookNotifications("payout.updated", "trf_fail", {
          data: { id: "trf_fail", status },
        });
        check(`a payout still "${status}" notifies nothing`,
          (await rowsFor(uid)).length === 0);
      }

      await scoped.unsafe(`delete from ${SCRATCH}.notifications where firebase_uid = $1`, [uid]);
      await triggers.fireWebhookNotifications("payout.updated", "trf_fail", {
        data: { id: "trf_fail", status: "completed" },
      });
      check("and a completed payout still reports success",
        (await rowsFor(uid))[0]?.type === "payout_succeeded");
    }

    /* ------------------------------------------------------------ G ---- */
    section("G. Reads: own rows only, bounded, deterministic");

    {
      const mine = await creator("n_reader");
      const other = await creator("n_other");
      /* Rows written with an IDENTICAL created_at, which is what breaks a cursor
       * that pages on the timestamp alone. */
      for (let i = 0; i < 7; i++) {
        await scoped.unsafe(
          `insert into ${SCRATCH}.notifications
             (firebase_uid, type, title, body, idempotency_key, created_at)
           values ($1,'t',$2,'b',$3, timestamptz '2026-01-01 00:00:00Z')`,
          [mine, `mine-${i}`, `k:sandbox:mine-${i}`]);
      }
      await scoped.unsafe(
        `insert into ${SCRATCH}.notifications
           (firebase_uid, type, title, body, idempotency_key)
         values ($1,'t','theirs','b','k:sandbox:theirs')`, [other]);

      const page = await svc.getNotifications(mine, { limit: 3 });
      check("a read succeeds and is explicit about it", page.ok === true);
      check("it returns only the requesting creator's rows",
        page.ok && page.items.every((n) => n.title.startsWith("mine-")),
        page.ok ? page.items.map((n) => n.title).join(",") : "");
      check("bounded to the requested limit", page.ok && page.items.length === 3);
      check("and offers a cursor because more exist",
        page.ok && page.nextCursor !== null);

      /* DETERMINISTIC PAGING ACROSS AN IDENTICAL TIMESTAMP. Walk every page and
       * prove each row is seen exactly once — the property a timestamp-only
       * cursor cannot hold. */
      const seen = [];
      let cursor = undefined;
      for (let guard = 0; guard < 10; guard++) {
        const p = await svc.getNotifications(mine, { limit: 3, before: cursor });
        if (!p.ok) break;
        seen.push(...p.items.map((n) => n.title));
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      check("paging sees all seven rows", seen.length === 7, String(seen.length));
      check("each exactly once — no row skipped or repeated",
        new Set(seen).size === 7, `${new Set(seen).size} distinct`);
      check("and the same page read twice is identical",
        JSON.stringify((await svc.getNotifications(mine, { limit: 3 })).items.map((n) => n.title)) ===
          JSON.stringify((await svc.getNotifications(mine, { limit: 3 })).items.map((n) => n.title)));

      /* LIMITS. */
      check("a negative limit falls back to the default instead of returning empty",
        svc.clampNotificationLimit(-5) === 20 && svc.clampNotificationLimit(0) === 20);
      check("a non-integer or junk limit falls back too",
        svc.clampNotificationLimit(1.5) === 20 && svc.clampNotificationLimit(NaN) === 20 &&
          svc.clampNotificationLimit("abc") === 20 && svc.clampNotificationLimit(undefined) === 20);
      check("an absurd limit is clamped to the maximum",
        svc.clampNotificationLimit(100000) === 100);
      const negative = await svc.getNotifications(mine, { limit: -5 });
      check("and a negative limit still returns rows rather than an empty list",
        negative.ok === true && negative.items.length > 0, String(negative.items?.length));

      /* UNREAD COUNT, and marking read. */
      check("the unread count is the true number, not a capped one",
        (await svc.getUnreadCount(mine)) === 7, String(await svc.getUnreadCount(mine)));
      const target = (await rowsFor(mine))[0].notification_id;
      check("marking one read succeeds", (await svc.markRead(target, mine)).ok === true);
      check("the count drops by exactly one", (await svc.getUnreadCount(mine)) === 6);
      check("marking the same one again is idempotent",
        (await svc.markRead(target, mine)).ok === true &&
          (await svc.getUnreadCount(mine)) === 6);

      /* A CREATOR CANNOT MARK ANOTHER'S. */
      const theirId = (await rowsFor(other))[0].notification_id;
      await svc.markRead(theirId, mine);
      check("one creator cannot mark another creator's notification read",
        (await svc.getUnreadCount(other)) === 1, String(await svc.getUnreadCount(other)));

      check("mark-all-read clears only the requester's",
        (await svc.markAllRead(mine)).ok === true &&
          (await svc.getUnreadCount(mine)) === 0 &&
          (await svc.getUnreadCount(other)) === 1);
      check("and mark-all again is idempotent",
        (await svc.markAllRead(mine)).ok === true && (await svc.getUnreadCount(mine)) === 0);
    }

    /* ------------------------------------------------------------ H ---- */
    section("H. Unavailable is not empty");

    {
      const saved = DB;
      DB = null;
      const page = await svc.getNotifications("n_reader", { limit: 5 });
      check("a read with no database reports failure, not an empty inbox",
        page.ok === false && page.reason === "db_unavailable", JSON.stringify(page));
      check("and the unread count is null, not a reassuring zero",
        (await svc.getUnreadCount("n_reader")) === null);
      check("a write with no database reports failure",
        (await svc.writeNotification({
          firebaseUid: "n_reader", type: "t", title: "a", body: "b",
          idempotencyKey: "k:sandbox:nodb",
        })).ok === false);
      DB = saved;
      check("and the service recovers once the database is back",
        (await svc.getNotifications("n_reader", { limit: 1 })).ok === true);
    }

    /* ------------------------------------------------------------ I ---- */
    section("I. Content carries no secrets");

    {
      const all = await scoped.unsafe(
        `select title, body, action_url, metadata::text as meta from ${SCRATCH}.notifications`);
      const blob = JSON.stringify(all).toLowerCase();
      for (const forbidden of ["sk_", "bearer ", "authorization", "api_key", "apikey",
        "secret", "token", "password", "stack", "at async", ".ts:"]) {
        check(`no notification content contains "${forbidden}"`, !blob.includes(forbidden));
      }
      check("action urls are internal relative paths only",
        all.every((r) => r.action_url === null || r.action_url.startsWith("/")),
        all.map((r) => r.action_url).filter(Boolean).join(",") || "none");
      check("every notification has a human title and body",
        all.every((r) => r.title && r.body));
    }

    /* ------------------------------------------------------------ K ---- */
    section("K. A failing QUERY is unavailable, not empty");

    {
      /* SECTION H PROVED THE WRONG HALF. It set the database handle to null,
       * which takes the early `if (!db)` return — so the `catch` blocks, where the
       * old code returned `[]` and `0`, were never exercised at all. A mutation
       * that reinstated exactly that behaviour escaped the suite.
       *
       * This reaches the catch for real: an invalid uuid in the cursor makes
       * Postgres reject the comparison, which is also a genuine input an API
       * caller can send. */
      const bad = await svc.getNotifications("n_reader", {
        limit: 5,
        before: { createdAt: new Date(), notificationId: "not-a-uuid" },
      });
      check("a query Postgres rejects reports unavailable, not an empty page",
        bad.ok === false && bad.reason === "db_unavailable", JSON.stringify(bad));

      /* AND WITH THE TABLE GONE, both readers must refuse rather than reassure.
       * Done last, and only in the throwaway schema, which the finally block
       * drops entirely a moment later. */
      await scoped.unsafe(`drop table ${SCRATCH}.notifications`);
      const afterDrop = await svc.getNotifications("n_reader", { limit: 5 });
      check("a missing table reports unavailable, not an empty inbox",
        afterDrop.ok === false && afterDrop.reason === "db_unavailable",
        JSON.stringify(afterDrop));
      check("and the unread count is null, not a reassuring zero",
        (await svc.getUnreadCount("n_reader")) === null,
        String(await svc.getUnreadCount("n_reader")));
      check("a write against a missing table reports failure",
        (await svc.writeNotification({
          firebaseUid: "n_reader", type: "t", title: "a", body: "b",
          idempotencyKey: "k:sandbox:gone",
        })).ok === false);
      check("and marking read reports failure rather than a false success",
        (await svc.markRead("00000000-0000-0000-0000-000000000000", "n_reader")).ok === false &&
          (await svc.markAllRead("n_reader")).ok === false);
    }

  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("set search_path = public");
    if (scoped) await scoped.end({ timeout: 5 });

    /* THE REAL DATABASE, AFTER. The invariant is "this suite added nothing". */
    section("J. the real database is untouched");
    const [afterNotifs] = await client`select count(*)::int as n from public.notifications`;
    const [afterMigrations] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("this suite wrote no notification to the real table",
      afterNotifs.n === beforeNotifs.n, `${beforeNotifs.n} -> ${afterNotifs.n}`);
    check("nor applied any migration",
      afterMigrations.n === beforeMigrations.n, `${afterMigrations.n} migrations`);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });
  }
}

await run().catch((e) =>
  check("DB sections completed", false, String(e?.message ?? e).slice(0, 300)));

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
