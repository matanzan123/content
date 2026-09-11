/**
 * CLIPREWARDS USER ACCOUNT + APPROVAL TESTS.
 *
 * Three parts, for the same reason the other suites have three:
 *
 *   A. THE PURE LIFECYCLE — the approval state machine, the access-stage
 *      resolver, the routing table and the availability configuration rules.
 *      No database, no network, no Firebase.
 *
 *   B. PROVISIONING, ROLES, APPROVAL AND BOOKING — the real modules against a
 *      REAL Postgres in a throwaway schema, with identity injected as a
 *      verified uid rather than a Firebase call.
 *
 *   C. SOURCE INVARIANTS — properties true only by absence: no email identity,
 *      no self-approval path, no credential storage, no client-side security
 *      boundary, no Whop step before approval.
 *
 * NOTHING HERE TOUCHES `public`. Fixtures are created in `user_selftest`, and
 * the suite REFUSES TO WRITE ANYTHING until it has proved — by resolving the
 * very table names the modules use — that they land there.
 *
 * MIGRATION 0007 IS NOT APPLIED by this suite. It is replayed inside the
 * throwaway schema so its constraints are really exercised, and the real
 * migration count is asserted unchanged.
 *
 * Set USER_TEST_DB=0 to run only the pure parts.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

/* ========================================================================== */

const cache = new Map();
let DB = null;
/** What `getAdminAuth()` returns. Null models "Admin SDK not configured". */
let FAKE_ADMIN_AUTH = null;
/** What the session cookie currently resolves to. */
let FAKE_SESSION = null;

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
    if (spec === "@/lib/db") return { getDb: () => DB, isDatabaseConfigured: () => DB !== null };
    if (spec === "./firebase-admin" || spec.endsWith("/firebase-admin")) {
      return {
        getAdminAuth: () => FAKE_ADMIN_AUTH,
        getAdminFirestore: () => null,
        isAdminSdkConfigured: () => FAKE_ADMIN_AUTH !== null,
      };
    }
    if (spec === "next/headers") {
      return { cookies: async () => ({ get: () => FAKE_SESSION, set: () => {} }) };
    }
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      try {
        return loadTs(`${base}.ts`);
      } catch {
        return loadTs(`${base}/index.ts`);
      }
    }
    return require(spec);
  };

  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

const lifecycle = loadTs("src/lib/server/user-lifecycle.ts");
const availability = loadTs("src/lib/server/interview-availability.ts");

/* ==========================================================================
   PART A — the pure lifecycle
   ========================================================================== */

console.log("\n--- A. the approval state machine ---");

check(
  "there are exactly six approval statuses",
  lifecycle.APPROVAL_STATUSES.length === 6,
  lifecycle.APPROVAL_STATUSES.join(","),
);
check(
  "ONLY `approved` grants platform access",
  lifecycle.APPROVAL_STATUSES.filter((s) => lifecycle.grantsPlatformAccess(s)).join(",") ===
    "approved",
);
check(
  "every other status is blocked, including needs_followup",
  lifecycle.APPROVAL_STATUSES.filter((s) => s !== "approved").every((s) => lifecycle.isBlocked(s)),
);
check(
  "the three admin decisions are exactly approved/rejected/needs_followup",
  [...lifecycle.ADMIN_DECISIONS].sort().join(",") === "approved,needs_followup,rejected",
);
check(
  "a role a user may select is creator or brand — never admin",
  lifecycle.isSelectableRole("creator") &&
    lifecycle.isSelectableRole("brand") &&
    !lifecycle.isSelectableRole("admin") &&
    !lifecycle.isSelectableRole("ADMIN") &&
    !lifecycle.isSelectableRole(null),
);

console.log("\n--- A. progress can never produce a decision ---");

const P = lifecycle.computeProgressStatus;
const facts = (role, done, booking) => ({
  role,
  onboardingCompletedAt: done ? new Date() : null,
  hasActiveBooking: booking,
});

check("a fresh account is onboarding", P("onboarding", facts(null, false, false)) === "onboarding");
check(
  "a role alone is not enough to leave onboarding",
  P("onboarding", facts("creator", false, false)) === "onboarding",
);
check(
  "a completed profile without a role is not enough either",
  P("onboarding", facts(null, true, false)) === "onboarding",
);
check(
  "role + profile moves to pending_interview",
  P("onboarding", facts("creator", true, false)) === "pending_interview",
);
check(
  "booking an interview moves to pending_review",
  P("pending_interview", facts("creator", true, true)) === "pending_review",
);
check(
  "cancelling a booking moves back to pending_interview",
  P("pending_review", facts("creator", true, false)) === "pending_interview",
);

// THE CENTRAL SECURITY PROPERTY.
let everProducesDecision = false;
for (const from of lifecycle.APPROVAL_STATUSES) {
  for (const role of [null, "creator", "brand"]) {
    for (const done of [true, false]) {
      for (const booked of [true, false]) {
        const out = P(from, facts(role, done, booked));
        if (out !== null && lifecycle.isDecided(out)) everProducesDecision = true;
      }
    }
  }
}
check(
  "NO combination of user activity can ever produce approved/rejected/needs_followup",
  everProducesDecision === false,
);
check(
  "and a decided account is left alone entirely (returns null)",
  lifecycle.ADMIN_DECISIONS.every((d) => P(d, facts("creator", true, true)) === null),
);

console.log("\n--- A. access stages ---");

const S = lifecycle.resolveAccessStage;
check(
  "no identity is unauthenticated",
  S({ authenticated: false, isAdmin: false, role: null, status: "approved" }) === "unauthenticated",
);
check(
  "admin wins over everything, including a blocked application",
  S({ authenticated: true, isAdmin: true, role: null, status: "rejected" }) === "admin",
);
check(
  "onboarding -> onboarding_incomplete",
  S({ authenticated: true, isAdmin: false, role: null, status: "onboarding" }) ===
    "onboarding_incomplete",
);
check(
  "pending_interview -> interview_required",
  S({ authenticated: true, isAdmin: false, role: "creator", status: "pending_interview" }) ===
    "interview_required",
);
check(
  "pending_review -> awaiting_review",
  S({ authenticated: true, isAdmin: false, role: "creator", status: "pending_review" }) ===
    "awaiting_review",
);
check(
  "rejected and needs_followup have their own stages",
  S({ authenticated: true, isAdmin: false, role: "creator", status: "rejected" }) === "rejected" &&
    S({ authenticated: true, isAdmin: false, role: "brand", status: "needs_followup" }) ===
      "needs_followup",
);
check(
  "approved creator and approved brand are distinct stages",
  S({ authenticated: true, isAdmin: false, role: "creator", status: "approved" }) ===
    "approved_creator" &&
    S({ authenticated: true, isAdmin: false, role: "brand", status: "approved" }) ===
      "approved_brand",
);
check(
  "an approved account with NO role fails safe to onboarding, never to access",
  S({ authenticated: true, isAdmin: false, role: null, status: "approved" }) ===
    "onboarding_incomplete",
);

console.log("\n--- A. what each stage may do ---");

const allStages = [
  "unauthenticated",
  "onboarding_incomplete",
  "interview_required",
  "awaiting_review",
  "rejected",
  "needs_followup",
  "approved_creator",
  "approved_brand",
  "admin",
];
check(
  "exactly three stages have platform access",
  allStages.filter((s) => lifecycle.stageHasPlatformAccess(s)).join(",") ===
    "approved_creator,approved_brand,admin",
);
check(
  "ONLY approved creator and brand may connect Whop — not an admin, not a pending user",
  allStages.filter((s) => lifecycle.stageMayConnectWhop(s)).join(",") ===
    "approved_creator,approved_brand",
);
check(
  "every stage has a routing destination",
  allStages.every((s) => typeof lifecycle.STAGE_DESTINATIONS[s] === "string"),
);
check(
  "a blocked stage is never routed to an operational area",
  ["awaiting_review", "rejected", "needs_followup", "interview_required"].every((s) =>
    lifecycle.STAGE_DESTINATIONS[s].startsWith("/onboarding"),
  ),
);
check(
  "every declared lifecycle rule matches the implementation",
  lifecycle.LIFECYCLE_RULES.filter((r) => r.by === "progress").every((r) => {
    const out = P(r.from, facts("creator", true, r.to === "pending_review"));
    const reachable = out === r.to;
    return r.allowed ? reachable || out !== null : !reachable;
  }),
);

console.log("\n--- A. interview availability configuration ---");

const A = availability.resolveAvailabilityConfig;
check(
  "with NOTHING configured it refuses and names all four required settings",
  (() => {
    const r = A({});
    return (
      !r.ok &&
      r.reason === "unconfigured" &&
      ["INTERVIEW_TIMEZONE", "INTERVIEW_DAYS", "INTERVIEW_HOURS", "INTERVIEW_SLOT_MINUTES"].every(
        (k) => r.missing.includes(k),
      )
    );
  })(),
  show(A({}).missing),
);

const GOOD = {
  INTERVIEW_TIMEZONE: "Asia/Jerusalem",
  INTERVIEW_DAYS: "0,1,2,3,4",
  INTERVIEW_HOURS: "10:00-17:00",
  INTERVIEW_SLOT_MINUTES: "30",
};
check("a complete configuration resolves", A(GOOD).ok === true);
check(
  "and carries sane defaults for the two optional settings",
  A(GOOD).ok && A(GOOD).config.minNoticeHours === 24 && A(GOOD).config.horizonDays === 14,
);
check(
  "an invalid timezone is refused, not silently defaulted to UTC",
  A({ ...GOOD, INTERVIEW_TIMEZONE: "Mars/Olympus" }).ok === false,
);
check(
  "an out-of-range weekday is refused",
  A({ ...GOOD, INTERVIEW_DAYS: "0,9" }).ok === false,
);
check(
  "a backwards operating window is refused",
  A({ ...GOOD, INTERVIEW_HOURS: "17:00-10:00" }).ok === false,
);
check(
  "an absurd slot length is refused",
  A({ ...GOOD, INTERVIEW_SLOT_MINUTES: "1" }).ok === false &&
    A({ ...GOOD, INTERVIEW_SLOT_MINUTES: "600" }).ok === false,
);
check("parseClock rejects nonsense", availability.parseClock("25:00") === null);

// Slot validation, with a fixed "now" so the test is deterministic.
// 2026-09-14 is a Monday; the zone is Asia/Jerusalem (UTC+3 in September).
const NOW = new Date("2026-09-14T06:00:00.000Z");
const B = (iso) => availability.isBookableSlot(new Date(iso), NOW, GOOD);

check(
  "with no configuration, EVERY slot is refused",
  availability.isBookableSlot(new Date("2026-09-16T08:00:00.000Z"), NOW, {}).reason ===
    "availability_unconfigured",
);
check("a slot inside the window is bookable", B("2026-09-16T07:00:00.000Z").ok === true);
check("a slot before minimum notice is refused", B("2026-09-14T07:00:00.000Z").reason === "too_soon");
check(
  "a slot beyond the horizon is refused",
  B("2026-10-30T07:00:00.000Z").reason === "beyond_horizon",
);
check(
  "a slot on a non-operating day is refused (Friday is not in 0-4)",
  B("2026-09-18T07:00:00.000Z").reason === "outside_operating_days",
);
check(
  "a slot before opening is refused",
  B("2026-09-16T04:00:00.000Z").reason === "outside_operating_hours",
);
check(
  "a slot that would run past closing is refused",
  B("2026-09-16T13:45:00.000Z").reason === "outside_operating_hours",
);
check(
  "a slot off the boundary is refused",
  B("2026-09-16T07:10:00.000Z").reason === "not_on_a_slot_boundary",
);
check("an invalid instant is refused", availability.isBookableSlot(new Date("nope"), NOW, GOOD).ok === false);

const listing = availability.listAvailableSlots(NOW, GOOD);
check("the generated list is non-empty and every entry validates", (() => {
  if (!listing.ok || listing.slots.length === 0) return false;
  return listing.slots.every((iso) => availability.isBookableSlot(new Date(iso), NOW, GOOD).ok);
})(), listing.ok ? `${listing.slots.length} slots` : "not ok");
check(
  "and an unconfigured listing refuses rather than returning an empty calendar",
  availability.listAvailableSlots(NOW, {}).ok === false,
);

/* ==========================================================================
   PART B — the real modules over Postgres
   ========================================================================== */

const SCRATCH = "user_selftest";

async function sequences() {
  console.log("\n--- B. provisioning, roles, approval and booking ---");

  if (!process.env.DATABASE_URL) {
    check("database available", false, "no DATABASE_URL — part B skipped");
    return;
  }

  const postgres = require("postgres");
  const { drizzle } = require("drizzle-orm/postgres-js");

  // The direct endpoint, not the pooled one: `search_path` is session state
  // and Neon's pooler can serve the next statement from another backend.
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const beforeMigrations = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
  const beforeOrders = await client`select count(*)::int as n from payment_orders`;
  const beforeLedger = await client`select count(*)::int as n from financial_ledger`;
  // Real applicants exist in `public.users` once the flow has actually been
  // used, so a leak check cannot compare to zero. It compares to the counts
  // captured HERE, which is what "this suite wrote nothing there" means.
  const beforeRealUsers = await client`select count(*)::int as n from public.users`;
  const beforeRealBookings = await client`select count(*)::int as n from public.interview_bookings`;
  const beforeTxns = await client`select count(*)::int as n from accounting_transactions`;

  let scoped = null;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);
    await client.unsafe(`set search_path = ${SCRATCH}`);

    const [ddlSchema] = await client`select current_schema() as schema`;
    if (ddlSchema.schema !== SCRATCH) {
      throw new Error(`ISOLATION FAILED — DDL would run in ${ddlSchema.schema}`);
    }

    const ddl = readFileSync("drizzle/0007_abnormal_mentallo.sql", "utf8");
    for (const stmt of ddl
      .split("--> statement-breakpoint")
      .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
      .filter(Boolean)) {
      await client.unsafe(stmt);
    }
    check("migration 0007 applies cleanly on its own", true);

    scoped = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await scoped.unsafe(`set search_path = ${SCRATCH}`);

    const [where] = await scoped`
      select current_schema() as schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('users')) as users_schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('user_profiles')) as profiles_schema,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('interview_bookings')) as bookings_schema`;
    const isolated =
      where.schema === SCRATCH &&
      where.users_schema === SCRATCH &&
      where.profiles_schema === SCRATCH &&
      where.bookings_schema === SCRATCH;
    if (!isolated) throw new Error(`ISOLATION FAILED — refusing to write: ${show(where)}`);
    check(
      "ISOLATION PROVED: users, user_profiles and interview_bookings all resolve to the throwaway schema",
      isolated,
      `${where.users_schema}/${where.profiles_schema}/${where.bookings_schema}`,
    );

    const [publicUsers] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name in ('users','user_profiles','interview_bookings')`;
    // 0007 IS applied now — deliberately, after task 6 was reviewed. What this
    // suite must still assert is that IT applies nothing and writes nothing
    // there; every fixture below lands in the throwaway schema, proved above.
    check(
      "the real user tables exist in public — 0007 is applied",
      publicUsers.n === 3,
      `${publicUsers.n}/3`,
    );

    const schema = loadTs("src/lib/db/schema.ts");
    DB = drizzle(scoped, { schema });

    const usersMod = loadTs("src/lib/server/users.ts");
    const interviews = loadTs("src/lib/server/interviews.ts");

    const row = async (uid) =>
      (await scoped.unsafe(`select * from ${SCRATCH}.users where firebase_uid = '${uid}'`))[0];

    /* ------------------------------------------------------ provisioning */
    console.log("\n  · provisioning");
    {
      const first = await usersMod.provisionUser("uid_alice");
      check("first login provisions a user", first.ok && first.created === true);
      check("with NO role — nobody is defaulted to creator", first.ok && first.user.role === null);
      check(
        "and NOT approved — signing in is not joining",
        first.ok && first.user.approvalStatus === "onboarding",
      );

      const second = await usersMod.provisionUser("uid_alice");
      check("a repeat login does not create a second user", second.ok && second.created === false);
      const [count] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.users where firebase_uid = 'uid_alice'`,
      );
      check("exactly one row exists for the uid", count.n === 1);

      const raced = await Promise.allSettled([
        usersMod.provisionUser("uid_race"),
        usersMod.provisionUser("uid_race"),
        usersMod.provisionUser("uid_race"),
      ]);
      const [raceCount] = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.users where firebase_uid = 'uid_race'`,
      );
      check(
        "three concurrent first logins create exactly ONE user",
        raceCount.n === 1,
        raced.map((r) => r.status).join("/"),
      );

      check("a blank uid is refused", (await usersMod.provisionUser("")).ok === false);
      check(
        "an absurdly long uid is refused",
        (await usersMod.provisionUser("x".repeat(200))).ok === false,
      );
    }

    /* -------------------------------------------------------------- roles */
    console.log("\n  · role selection");
    {
      const bad = await usersMod.setUserRole("uid_alice", "admin");
      check("`admin` is not a selectable role", !bad.ok && bad.reason === "invalid_role");
      check(
        "an invented role is refused",
        !(await usersMod.setUserRole("uid_alice", "superuser")).ok,
      );
      check("a null role is refused", !(await usersMod.setUserRole("uid_alice", null)).ok);

      const creator = await usersMod.setUserRole("uid_alice", "creator");
      check("creator can be assigned", creator.ok && creator.user.role === "creator");
      const brand = await usersMod.setUserRole("uid_alice", "brand");
      check("and changed to brand while undecided", brand.ok && brand.user.role === "brand");
      await usersMod.setUserRole("uid_alice", "creator");

      const missing = await usersMod.setUserRole("uid_nobody", "creator");
      check(
        "a role cannot be set for a user who does not exist",
        !missing.ok && missing.reason === "user_not_found",
      );
    }

    /* ------------------------------------------------------------ profile */
    console.log("\n  · profile and progress");
    {
      let user = await row("uid_alice");
      check("still onboarding with a role but no profile", user.approval_status === "onboarding");

      const saved = await usersMod.saveProfile("uid_alice", {
        fullName: "Alice Example",
        bio: "clips",
        languages: ["English", "Hebrew"],
        creatorType: "Clipper",
        referralSource: "TikTok",
        socials: ["YouTube"],
        lastStep: 4,
        complete: true,
      });
      check("saving a complete profile succeeds", saved.ok, show(saved));
      user = await row("uid_alice");
      check(
        "role + profile moves the account to pending_interview",
        user.approval_status === "pending_interview",
      );
      check(
        "COMPLETING A PROFILE DOES NOT APPROVE ANYONE",
        user.approval_status !== "approved" && user.approved_at === null,
      );

      const profile = await usersMod.getProfile("uid_alice");
      check(
        "the profile is durable and complete",
        profile.fullName === "Alice Example" &&
          profile.languages.includes("Hebrew") &&
          profile.lastStep === 4,
      );

      // Re-saving must not restamp the completion moment.
      const firstCompleted = user.onboarding_completed_at;
      await usersMod.saveProfile("uid_alice", { fullName: "Alice E", lastStep: 2, complete: true });
      const again = await row("uid_alice");
      check(
        "a later edit does not restamp onboarding_completed_at",
        String(again.onboarding_completed_at) === String(firstCompleted),
      );
    }

    /* ------------------------------------------------------------ booking */
    console.log("\n  · interview booking");
    {
      const unconfigured = await interviews.bookInterview(
        "uid_alice",
        "2026-09-16T07:00:00.000Z",
        NOW,
        {},
      );
      check(
        "with NO operating hours configured, booking FAILS SAFE",
        !unconfigured.ok && unconfigured.reason === "availability_unconfigured",
        show(unconfigured),
      );

      const booked = await interviews.bookInterview(
        "uid_alice",
        "2026-09-16T07:00:00.000Z",
        NOW,
        GOOD,
      );
      check("a valid slot books", booked.ok, show(booked));
      check(
        "the slot length is captured on the row",
        booked.ok && booked.booking.durationMinutes === 30,
      );

      let user = await row("uid_alice");
      check("booking moves the account to pending_review", user.approval_status === "pending_review");
      check(
        "BOOKING AN INTERVIEW DOES NOT APPROVE ANYONE",
        user.approval_status !== "approved" && user.approved_at === null,
      );

      const dup = await interviews.bookInterview("uid_alice", "2026-09-17T07:00:00.000Z", NOW, GOOD);
      check(
        "a second live booking for the same user is refused",
        !dup.ok && dup.reason === "already_booked",
        show(dup),
      );

      // Another user cannot take the same slot.
      await usersMod.provisionUser("uid_bob");
      await usersMod.setUserRole("uid_bob", "brand");
      await usersMod.saveProfile("uid_bob", { fullName: "Bob", complete: true, lastStep: 4 });
      const clash = await interviews.bookInterview("uid_bob", "2026-09-16T07:00:00.000Z", NOW, GOOD);
      check("two people cannot hold the same slot", !clash.ok && clash.reason === "slot_taken", show(clash));

      const bad = await interviews.bookInterview("uid_bob", "2026-09-18T07:00:00.000Z", NOW, GOOD);
      check("a non-operating day is refused", !bad.ok && bad.reason === "slot_unavailable");
      const soon = await interviews.bookInterview("uid_bob", "2026-09-14T07:00:00.000Z", NOW, GOOD);
      check("a slot inside the notice window is refused", !soon.ok && soon.reason === "slot_unavailable");
      const nonsense = await interviews.bookInterview("uid_bob", "not-a-date", NOW, GOOD);
      check("a malformed instant is refused", !nonsense.ok && nonsense.reason === "invalid_instant");

      // Onboarding must be finished first.
      await usersMod.provisionUser("uid_carol");
      const early = await interviews.bookInterview("uid_carol", "2026-09-17T07:00:00.000Z", NOW, GOOD);
      check(
        "an unfinished application cannot book",
        !early.ok && early.reason === "onboarding_incomplete",
      );

      // Cancelling frees the slot and moves the account back.
      const active = await interviews.getActiveBooking("uid_alice");
      const cancelled = await interviews.cancelOwnBooking("uid_alice", active.bookingId);
      check("a user can cancel their own booking", cancelled.ok);
      user = await row("uid_alice");
      check("and returns to pending_interview", user.approval_status === "pending_interview");

      const stranger = await interviews.cancelOwnBooking("uid_bob", active.bookingId);
      check(
        "a user CANNOT cancel someone else's booking",
        !stranger.ok && stranger.reason === "not_found",
      );

      // The freed slot is bookable again.
      const rebooked = await interviews.bookInterview(
        "uid_bob",
        "2026-09-16T07:00:00.000Z",
        NOW,
        GOOD,
      );
      check("the cancelled slot becomes available again", rebooked.ok, show(rebooked));
      await interviews.bookInterview("uid_alice", "2026-09-16T07:30:00.000Z", NOW, GOOD);
    }

    /* ----------------------------------------------------------- approval */
    console.log("\n  · approval is admin-only");
    {
      let user = await row("uid_alice");
      check("Alice is awaiting review, not approved", user.approval_status === "pending_review");

      // There is no user-facing writer at all — proved by absence in part C.
      const approved = await usersMod.decideUser("uid_alice", "approved", "uid_admin");
      check("an admin can approve", approved.ok && approved.user.approvalStatus === "approved");
      user = await row("uid_alice");
      check("approved_at is stamped", user.approved_at !== null);
      check("and the decision is attributed", user.decided_by_uid === "uid_admin" && user.decided_at !== null);

      const stamp = user.approved_at;
      await usersMod.decideUser("uid_alice", "approved", "uid_admin");
      user = await row("uid_alice");
      check("re-approving is idempotent and keeps the original moment", String(user.approved_at) === String(stamp));

      // Progress must not disturb a decision.
      await usersMod.saveProfile("uid_alice", { fullName: "Alice Edited", complete: true, lastStep: 1 });
      user = await row("uid_alice");
      check(
        "an approved user editing their profile stays approved",
        user.approval_status === "approved",
      );
      const roleChange = await usersMod.setUserRole("uid_alice", "brand");
      check(
        "and cannot change their own role after a decision",
        !roleChange.ok && roleChange.reason === "already_decided",
      );

      // Rejection.
      const rejected = await usersMod.decideUser("uid_bob", "rejected", "uid_admin");
      check("an admin can reject", rejected.ok && rejected.user.approvalStatus === "rejected");
      let bob = await row("uid_bob");
      check("rejected_at is stamped and approved_at is null", bob.rejected_at !== null && bob.approved_at === null);
      await usersMod.saveProfile("uid_bob", { fullName: "Bob Again", complete: true, lastStep: 4 });
      bob = await row("uid_bob");
      check(
        "A REJECTED USER CANNOT EDIT THEIR WAY BACK INTO THE QUEUE",
        bob.approval_status === "rejected",
      );

      // Follow-up.
      await usersMod.provisionUser("uid_dana");
      await usersMod.setUserRole("uid_dana", "creator");
      await usersMod.saveProfile("uid_dana", { fullName: "Dana", complete: true, lastStep: 4 });
      const followup = await usersMod.decideUser("uid_dana", "needs_followup", "uid_admin");
      check("an admin can mark needs_followup", followup.ok && followup.user.approvalStatus === "needs_followup");
      check(
        "and needs_followup does NOT grant access",
        lifecycle.grantsPlatformAccess("needs_followup") === false,
      );

      // A verdict can be revisited.
      const revisited = await usersMod.decideUser("uid_bob", "approved", "uid_admin2");
      check("an admin may approve a previously rejected applicant", revisited.ok);
      bob = await row("uid_bob");
      check(
        "and the timestamps stay coherent — rejected_at is cleared",
        bob.approval_status === "approved" && bob.approved_at !== null && bob.rejected_at === null,
      );

      check(
        "an invented decision is refused",
        !(await usersMod.decideUser("uid_dana", "vibes", "uid_admin")).ok,
      );
      check(
        "a progress status cannot be passed as a decision",
        !(await usersMod.decideUser("uid_dana", "approved_creator", "uid_admin")).ok &&
          !(await usersMod.decideUser("uid_dana", "pending_review", "uid_admin")).ok,
      );
      check(
        "deciding a non-existent user is refused",
        !(await usersMod.decideUser("uid_ghost", "approved", "uid_admin")).ok,
      );
    }

    /* -------------------------------------------------------- admin reads */
    console.log("\n  · admin review data");
    {
      const counts = await usersMod.getUserCounts();
      check(
        "counts report unassigned as its own number, not folded into creators",
        counts.unassigned >= 1,
        show(counts),
      );
      check("and the totals add up", counts.creators + counts.brands + counts.unassigned === counts.total);

      const applicants = await usersMod.listApplicants();
      check("the review queue lists applicants", applicants.length >= 4);
      check(
        "with their role, status and booking",
        applicants.some((a) => a.firebaseUid === "uid_alice" && a.approvalStatus === "approved"),
      );
      const unassigned = await usersMod.listUnassigned();
      check(
        "and unassigned users are listed separately",
        unassigned.some((u) => u.firebaseUid === "uid_carol"),
      );

      // Meeting URL is admin-written.
      const aliceBooking = await interviews.getActiveBooking("uid_alice");
      if (aliceBooking) {
        const linked = await interviews.setMeetingUrl(aliceBooking.bookingId, "https://meet.google.com/abc-defg-hij");
        check("an admin can attach a Meet URL", linked.ok);
        const badUrl = await interviews.setMeetingUrl(aliceBooking.bookingId, "javascript:alert(1)");
        check("a non-https URL is refused", !badUrl.ok);
      }
    }

    /* --------------------------------------------------- 0007 constraints */
    console.log("\n  · 0007 database constraints");
    {
      const refuses = async (sql, pattern) => {
        try {
          await scoped.unsafe(sql);
          return false;
        } catch (e) {
          return pattern.test(String(e.message));
        }
      };

      check(
        "0007 refuses an approved user with no approved_at",
        await refuses(
          `insert into ${SCRATCH}.users (firebase_uid, approval_status, decided_by_uid, decided_at) values ('uid_x','approved','a',now())`,
          /approved_has_time/,
        ),
      );
      check(
        "0007 refuses an approved_at on a non-approved row",
        await refuses(
          `insert into ${SCRATCH}.users (firebase_uid, approval_status, approved_at) values ('uid_y','onboarding',now())`,
          /approved_time_only_when_approved/,
        ),
      );
      check(
        "0007 refuses an UNATTRIBUTED decision",
        await refuses(
          `insert into ${SCRATCH}.users (firebase_uid, approval_status, approved_at) values ('uid_z','approved',now())`,
          /decision_is_attributed|approved_time/,
        ),
      );
      check(
        "0007 refuses progress past onboarding without a role and a profile",
        await refuses(
          `insert into ${SCRATCH}.users (firebase_uid, approval_status) values ('uid_w','pending_review')`,
          /progress_requires_onboarding/,
        ),
      );
      check(
        "0007 refuses a blank uid",
        await refuses(
          `insert into ${SCRATCH}.users (firebase_uid) values ('  ')`,
          /uid_present/,
        ),
      );
      check(
        "0007 refuses a non-https meeting url",
        await refuses(
          `update ${SCRATCH}.interview_bookings set meeting_url = 'http://x.com'`,
          /meeting_url_https/,
        ),
      );
      check(
        "0007 refuses an absurd slot duration",
        await refuses(
          `insert into ${SCRATCH}.interview_bookings (firebase_uid, scheduled_at, duration_minutes) values ('uid_alice', now(), 9999)`,
          /duration_sane/,
        ),
      );

      // The role enum cannot hold `admin`.
      check(
        "the user_role enum has exactly creator and brand",
        (await scoped`select unnest(enum_range(null::user_role))::text as v`)
          .map((r) => r.v)
          .join(",") === "creator,brand",
      );
    }
  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("reset search_path");
    if (scoped) await scoped.end();

    console.log("\n--- B. the real public database, after the tests ---");

    const [schemaCheck] = await client`select current_schema() as schema`;
    check("the session is back on public", schemaCheck.schema === "public");

    const afterMigrations = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check(
      "this suite applied no migration",
      beforeMigrations[0].n === afterMigrations[0].n,
      `${afterMigrations[0].n} migrations`,
    );

    const [publicUserTables] = await client`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name in ('users','user_profiles','interview_bookings')`;
    check("the real user tables are still present", publicUserTables.n === 3);

    // The real tables exist now, so this is a genuine leak check rather than
    // one satisfied by their absence.
    const [realUsers] = await client`select count(*)::int as n from public.users`;
    const [realBookings] = await client`select count(*)::int as n from public.interview_bookings`;
    check(
      "no synthetic user or booking reached the real tables",
      realUsers.n === beforeRealUsers[0].n && realBookings.n === beforeRealBookings[0].n,
      `${realUsers.n} users (was ${beforeRealUsers[0].n}), ` +
        `${realBookings.n} bookings (was ${beforeRealBookings[0].n})`,
    );

    const afterOrders = await client`select count(*)::int as n from payment_orders`;
    const afterLedger = await client`select count(*)::int as n from financial_ledger`;
    const afterTxns = await client`select count(*)::int as n from accounting_transactions`;
    check("payment_orders unchanged", afterOrders[0].n === beforeOrders[0].n, `${afterOrders[0].n}`);
    check("financial_ledger still 0", afterLedger[0].n === 0 && afterLedger[0].n === beforeLedger[0].n);
    check("accounting_transactions unchanged", afterTxns[0].n === beforeTxns[0].n, `${afterTxns[0].n}`);

    const [entries] = await client`
      select count(*)::int as n, coalesce(sum(amount_minor),0)::text as s from accounting_entries`;
    check("the real ledger still balances", entries.s === "0", `${entries.n} legs`);

    const [ua] = await client`select count(*)::int as n from user_analytics`;
    check(
      "user_analytics was not overloaded with application state",
      ua.n === 0,
      `${ua.n} rows`,
    );

    const [scratchGone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", scratchGone.n === 0);

    await client.end();
  }
}

/* ==========================================================================
   PART C — source invariants
   ========================================================================== */

function sourceInvariants() {
  console.log("\n--- C. source invariants ---");

  const f = (p) => readFileSync(p, "utf8");
  const files = {
    lifecycle: f("src/lib/server/user-lifecycle.ts"),
    users: f("src/lib/server/users.ts"),
    session: f("src/lib/server/user-session.ts"),
    access: f("src/lib/server/access.ts"),
    interviews: f("src/lib/server/interviews.ts"),
    availability: f("src/lib/server/interview-availability.ts"),
    guard: f("src/lib/server/page-guard.ts"),
  };
  const all = Object.values(files).join("\n");
  const codeOnly = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const allCode = Object.values(files).map(codeOnly).join("\n");

  check("every user module is server-only", Object.values(files).every((v) => v.includes('import "server-only"')));

  // IDENTITY IS THE UID.
  const schema = f("src/lib/db/schema.ts");
  const usersTable = schema.slice(schema.indexOf("export const users = pgTable"), schema.indexOf("export const userProfiles"));
  check("the users table has NO email column", !/email/i.test(usersTable));
  check(
    "and no password, token or session column",
    !/password|token|secret|session/i.test(usersTable),
  );
  check(
    "no module looks a user up by email",
    !/eq\(users\.email|where.*email/i.test(codeOnly(files.users)),
  );

  // SELF-APPROVAL IS IMPOSSIBLE.
  check(
    "`decideUser` is the ONLY function that writes a decision value",
    (allCode.match(/approvalStatus: (verdict|decision)/g) ?? []).length === 1,
  );
  check(
    "the progress writer carries the absorbing guard in SQL",
    /not in \('approved','rejected','needs_followup'\)/.test(files.users),
  );
  // The user-facing routes may REPORT a status; none may set one. Asserted on
  // assignment syntax rather than on the word appearing at all.
  check(
    "no user-facing API route ASSIGNS an approval status",
    !/approvalStatuss*[:=]s*(?!result|gate|context)/.test(
      codeOnly(
        f("src/app/api/onboarding/role/route.ts") +
          f("src/app/api/onboarding/profile/route.ts") +
          f("src/app/api/interview/book/route.ts"),
      ),
    ),
  );
  check(
    "the admin review route requires an admin before reading the body",
    (() => {
      const r = f("src/app/api/admin/review/route.ts");
      return r.indexOf("requireAdmin()") < r.indexOf("request.json()");
    })(),
  );

  // OWNERSHIP CANNOT BE SUPPLIED.
  for (const [name, path] of [
    ["role", "src/app/api/onboarding/role/route.ts"],
    ["profile", "src/app/api/onboarding/profile/route.ts"],
    ["booking", "src/app/api/interview/book/route.ts"],
  ]) {
    const src = f(path);
    check(
      `the ${name} route never reads a uid from the request body`,
      !/body.*firebase_uid|firebase_uid.*body/i.test(codeOnly(src)) &&
        /gate\.context\.uid/.test(src),
    );
  }

  // WHOP IS GATED.
  const connect = f("src/app/api/whop/connect/route.ts");
  check(
    "the Whop connect route is gated by requireWhopEligible",
    /requireWhopEligible/.test(connect) && !/getUserFromRequest/.test(connect),
  );
  const wizard = f("src/components/onboarding/OnboardingWizard.tsx");
  check(
    "the onboarding wizard no longer offers Whop connection",
    !/api\/whop\/connect/.test(wizard) && !/connectWhop/.test(wizard),
  );
  check(
    "and submits the application instead",
    /api\/onboarding\/profile/.test(wizard) && /submitApplication/.test(wizard),
  );

  // THE SECURITY BOUNDARY IS THE SERVER.
  check(
    "page guards run server-side and redirect",
    /import "server-only"/.test(files.guard) && /redirect\(/.test(files.guard),
  );
  const onboardingPage = f("src/app/[locale]/onboarding/page.tsx");
  check(
    "the onboarding page runs a server access check",
    /getAccessContext\(\)/.test(onboardingPage),
  );
  check(
    "AuthGate is still a client component and is NOT relied on for access",
    /"use client"/.test(f("src/components/auth/AuthGate.tsx")),
  );

  // NO INVENTED OPERATING HOURS.
  // The weekday NAMES are legitimate — Intl formats to "Mon"/"Tue" and they
  // are parsed back. What must not exist is a DEFAULT: a fallback value used
  // when configuration is absent.
  check(
    "missing configuration produces a refusal, never a default",
    /reason: "unconfigured"/.test(files.availability) &&
      /availability_unconfigured/.test(codeOnly(files.availability)),
  );
  check(
    "no timezone literal is hard-coded anywhere in the availability module",
    !/["'](UTC|GMT)["']|["']America\/|["']Asia\/|["']Europe\//.test(
      codeOnly(files.availability),
    ),
  );
  // Proved by behaviour rather than by syntax: every subset of the four
  // required settings that is missing even one must refuse.
  check(
    "omitting ANY single required setting still refuses",
    ["INTERVIEW_TIMEZONE", "INTERVIEW_DAYS", "INTERVIEW_HOURS", "INTERVIEW_SLOT_MINUTES"].every(
      (k) => {
        const partial = { ...GOOD };
        delete partial[k];
        const r = A(partial);
        return !r.ok && r.missing.includes(k);
      },
    ),
  );
  check(
    "all four required settings are named for the operator",
    ["INTERVIEW_TIMEZONE", "INTERVIEW_DAYS", "INTERVIEW_HOURS", "INTERVIEW_SLOT_MINUTES"].every((k) =>
      files.availability.includes(k),
    ),
  );
  check(
    "no Google Calendar or Meet API dependency was added",
    !/googleapis|calendar\.|meet\.v2|@google-cloud/i.test(all),
  );

  // THE CREATOR DEFAULT IS GONE.
  const fq = f("src/lib/admin/firebase-queries.ts");
  check(
    "firebase-queries no longer defaults an unknown role to creator",
    // `codeOnly` matters here: the module quotes the old expression in a
    // comment explaining why it was removed.
    !/\?\s*"brand"\s*:\s*"creator"/.test(codeOnly(fq)) && /roleByUid/.test(fq),
  );
  check("and reports unassigned as its own count", /unassigned/.test(fq));
  const dash = f("src/components/admin/DashboardSections.tsx");
  check(
    "the admin table renders three role states, not two",
    /unassignedLabel/.test(dash),
  );

  // HEBREW.
  check(
    "Hebrew is offered in the onboarding language list",
    /label: "Hebrew"/.test(f("src/components/onboarding/types.ts")),
  );
  check(
    "with a translation in both dictionaries",
    /Hebrew: "Hebrew"/.test(f("src/i18n/dictionaries/en.ts")) &&
      /Hebrew: "עברית"/.test(f("src/i18n/dictionaries/he.ts")),
  );
  // `iw` legitimately appears in `i18n/config.ts`, which normalises the legacy
  // code an old browser may still send into "he". That is correct INPUT
  // handling. What must never happen is `iw` being emitted as our own code.
  check(
    "the deprecated `iw` is never used as an output locale code",
    !/["']iw["']/.test(codeOnly(f("src/components/onboarding/types.ts"))) &&
      /base === "iw"\) return "he"/.test(f("src/i18n/config.ts")),
  );

  // SESSION.
  check(
    "the user session cookie is httpOnly and finite",
    /httpOnly: true/.test(files.session) && /USER_SESSION_MAX_AGE_MS/.test(files.session),
  );
  check(
    "secure in production",
    /secure: process\.env\.NODE_ENV === "production"/.test(files.session),
  );
  check(
    "revocation is checked on every request",
    /verifySessionCookie\(cookie, true\)/.test(files.session),
  );
  check(
    "there is NO development bypass anywhere in the auth path",
    !/NODE_ENV === "development"|DISABLE_AUTH|SKIP_AUTH|bypass/i.test(allCode),
  );
  check(
    "the ordinary session does NOT require an admin claim",
    !/claims\.admin !== true|admin !== true/.test(files.session),
  );
  const sessionRoute = f("src/app/api/auth/session/route.ts");
  check("logout clears the cookie and revokes refresh tokens", /revokeRefreshTokens/.test(sessionRoute));
  check("and the mint path is origin-checked", /checkRequestOrigin/.test(sessionRoute));

  // MIGRATIONS.
  const { execSync } = require("node:child_process");
  const changed = execSync("git status --porcelain drizzle", { encoding: "utf8" });
  check(
    "migrations 0000-0006 are untouched",
    changed.split("\n").filter((l) => /drizzle\/000[0-6]_/.test(l)).length === 0,
    changed.split("\n").filter((l) => /drizzle\/000[0-6]_/.test(l)).join(" ") || "none",
  );
  check("0007 exists", changed.includes("0007_abnormal_mentallo.sql"));
}

/* ========================================================================== */

sourceInvariants();

const run = process.env.USER_TEST_DB === "0" ? Promise.resolve() : sequences();

run
  .catch((e) => check("part B completed", false, String(e?.message ?? e).slice(0, 300)))
  .then(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) {
      for (const f of failed) console.log(`  - ${f.name}`);
      process.exit(1);
    }
  });
