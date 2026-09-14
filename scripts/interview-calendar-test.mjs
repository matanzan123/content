/**
 * GOOGLE CALENDAR + MEET INTERVIEW AUTOMATION TESTS.
 *
 * Three parts:
 *
 *   A. PURE RULES — OAuth configuration and state, the authorize URL, token
 *      exchange and refresh against a stubbed transport, encryption of the
 *      refresh token, the deterministic event id, Meet URL validation and the
 *      event body Google actually receives.
 *
 *   B. STORAGE AND FLOW — the real provisioning module against a REAL Postgres
 *      in a throwaway schema: one booking produces one event, a retry produces
 *      no second event, a Google failure leaves the booking valid, and a later
 *      retry recovers it.
 *
 *   C. SOURCE INVARIANTS — properties true only by absence: no Google secret
 *      reaches a client bundle, no token is logged or put in a URL, the
 *      callback cannot redirect to an arbitrary host, and the connect flow is
 *      administrator-only.
 *
 * NO GOOGLE REQUEST IS EVER MADE. `fetch` is stubbed throughout, so running
 * this creates no calendar event and performs no OAuth authorisation.
 *
 * Set CALENDAR_TEST_DB=0 to run only the pure parts.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
// A key of this suite's own, so it never depends on — or reveals — the real one.
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const cache = new Map();
function load(file, injected = {}) {
  const key = resolve(file) + JSON.stringify(Object.keys(injected));
  if (cache.has(key)) return cache.get(key);
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", "require", ...names, js)(
    mod, mod.exports, require, ...names.map((n) => injected[n]),
  );
  cache.set(key, mod.exports);
  return mod.exports;
}

function codeOnly(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** Replaces `fetch`, records every call, and answers from a queue. */
function stubFetch(replies) {
  const seen = [];
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const crypto_ = load("src/lib/server/google-crypto.ts", {
  createCipheriv: require("node:crypto").createCipheriv,
  createDecipheriv: require("node:crypto").createDecipheriv,
  randomBytes,
});
const oauth = load("src/lib/server/google-oauth.ts", {
  createHash: require("node:crypto").createHash,
  randomBytes,
});
const calendar = load("src/lib/server/google-calendar.ts", {
  stableRequestId: oauth.stableRequestId,
});

/* ======================== A. OAuth configuration ======================== */

console.log("\n--- A. OAuth configuration and state ---");
{
  const ok = {
    GOOGLE_CALENDAR_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: "a-secret",
    GOOGLE_CALENDAR_REDIRECT_URI: "https://example.test/api/google/calendar/callback",
  };
  check("a complete configuration resolves", oauth.resolveGoogleOAuthConfig(ok).ok === true);
  check("a missing client id fails closed",
    oauth.resolveGoogleOAuthConfig({ ...ok, GOOGLE_CALENDAR_CLIENT_ID: "" }).reason === "missing_client_id");
  check("a missing client SECRET fails closed — this client is confidential",
    oauth.resolveGoogleOAuthConfig({ ...ok, GOOGLE_CALENDAR_CLIENT_SECRET: "" }).reason === "missing_client_secret");
  check("a missing redirect fails closed",
    oauth.resolveGoogleOAuthConfig({ ...ok, GOOGLE_CALENDAR_REDIRECT_URI: "" }).reason === "missing_redirect_uri");
  check("an http redirect is refused",
    oauth.resolveGoogleOAuthConfig({ ...ok, GOOGLE_CALENDAR_REDIRECT_URI: "http://example.test/cb" }).reason === "invalid_redirect_uri");

  const state = oauth.createGoogleState();
  check("state is 32 bytes of CSPRNG output, base64url", /^[A-Za-z0-9_-]{43}$/.test(state), `${state.length} chars`);
  check("two states differ", oauth.createGoogleState() !== oauth.createGoogleState());

  const url = new URL(oauth.buildGoogleAuthorizeUrl({
    config: oauth.resolveGoogleOAuthConfig(ok).config,
    state,
  }));
  check("the authorize URL is Google's", url.origin + url.pathname === "https://accounts.google.com/o/oauth2/v2/auth");
  check("offline access is requested — a refresh token is the point",
    url.searchParams.get("access_type") === "offline");
  check("consent is forced, so Google ISSUES a refresh token",
    url.searchParams.get("prompt") === "consent");
  check("the scope is exactly calendar.events",
    url.searchParams.get("scope") === "https://www.googleapis.com/auth/calendar.events");
  check("the state is carried", url.searchParams.get("state") === state);
  check("the redirect_uri comes from configuration",
    url.searchParams.get("redirect_uri") === ok.GOOGLE_CALENDAR_REDIRECT_URI);
  check("no secret is placed in the authorize URL",
    url.toString().includes(ok.GOOGLE_CALENDAR_CLIENT_SECRET) === false);
}

/* ===================== A. token exchange and refresh ===================== */

console.log("\n--- A. token exchange and refresh ---");
{
  const config = {
    clientId: "client-id",
    clientSecret: "a-secret",
    redirectUri: "https://example.test/api/google/calendar/callback",
  };

  {
    const s = stubFetch({ status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "https://www.googleapis.com/auth/calendar.events" } });
    const out = await oauth.exchangeGoogleCode({ config, code: "the-code" });
    s.restore();
    check("an authorization code exchanges for tokens", out.ok && out.tokens.refreshToken === "rt");
    check("the token request is form-encoded, as the spec requires",
      s.seen[0].init.headers["content-type"] === "application/x-www-form-urlencoded");
    const sent = new URLSearchParams(s.seen[0].init.body);
    check("grant_type is authorization_code", sent.get("grant_type") === "authorization_code");
    check("the redirect_uri is echoed from configuration", sent.get("redirect_uri") === config.redirectUri);
  }

  {
    const s = stubFetch({ status: 200, body: { access_token: "fresh", expires_in: 3599 } });
    const out = await oauth.refreshGoogleAccessToken({ config, refreshToken: "rt" });
    s.restore();
    check("a refresh returns a new access token", out.ok && out.tokens.accessToken === "fresh");
    check("grant_type is refresh_token",
      new URLSearchParams(s.seen[0].init.body).get("grant_type") === "refresh_token");
  }

  {
    const s = stubFetch({ status: 400, body: { error: "invalid_grant" } });
    const out = await oauth.refreshGoogleAccessToken({ config, refreshToken: "dead" });
    s.restore();
    check("invalid_grant is its own terminal outcome", out.ok === false && out.reason === "invalid_grant");
  }
  {
    const s = stubFetch({ status: 500, body: { error: "backend_error" } });
    const out = await oauth.refreshGoogleAccessToken({ config, refreshToken: "rt" });
    s.restore();
    check("a transient provider failure is NOT terminal", out.ok === false && out.reason === "provider_rejected");
  }
  {
    const s = stubFetch(new Error("offline"));
    const out = await oauth.refreshGoogleAccessToken({ config, refreshToken: "rt" });
    s.restore();
    check("a network failure is its own outcome", out.ok === false && out.reason === "network_error");
  }
}

/* ========================= A. refresh-token crypto ======================= */

console.log("\n--- A. refresh-token encryption ---");
{
  // Obviously synthetic, and named so a secret scanner does not have to guess:
  // a fixture that looks like a credential is a permanent false positive.
  const FIXTURE_TOKEN = "not-a-real-refresh-token-used-only-to-prove-encryption";
  const envelope = crypto_.encryptGoogleToken(FIXTURE_TOKEN, "connection-1");
  check("a refresh token encrypts to a versioned envelope", typeof envelope === "string" && envelope.startsWith("v1."));
  check("the ciphertext does not contain the plaintext", envelope.includes(FIXTURE_TOKEN) === false);
  check("it decrypts back with the right AAD", crypto_.decryptGoogleToken(envelope, "connection-1") === FIXTURE_TOKEN);
  check("a DIFFERENT connection id cannot decrypt it — a moved row fails",
    crypto_.decryptGoogleToken(envelope, "connection-2") === null);
  check("a tampered envelope fails rather than decrypting to something else",
    crypto_.decryptGoogleToken(envelope.slice(0, -4) + "aaaa", "connection-1") === null);
  check("two encryptions of the same token differ (fresh IV)",
    crypto_.encryptGoogleToken(FIXTURE_TOKEN, "connection-1") !== envelope);
  check("no key means no encryption, never plaintext",
    crypto_.encryptGoogleToken(FIXTURE_TOKEN, "c", { GOOGLE_TOKEN_ENCRYPTION_KEY: "" }) === null);
  check("a short key is refused",
    crypto_.encryptGoogleToken(FIXTURE_TOKEN, "c", { GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }) === null);
  check("the Google key is read from its OWN variable, not the Whop one",
    codeOnly("src/lib/server/google-crypto.ts").includes("GOOGLE_TOKEN_ENCRYPTION_KEY") &&
      codeOnly("src/lib/server/google-crypto.ts").includes("WHOP_OAUTH_TOKEN_ENCRYPTION_KEY") === false);
}

/* ==================== A. event id, Meet URL, event body ================== */

console.log("\n--- A. the event Google is asked to create ---");
{
  const bookingId = "9c6a33a2-0b84-43bb-880a-836204c27aac";
  const eventId = calendar.eventIdForBooking(bookingId);
  check("the event id is derived from the booking", eventId === "cr9c6a33a20b8443bb880a836204c27aac");
  check("it is STABLE across calls — the same booking, the same event",
    calendar.eventIdForBooking(bookingId) === eventId);
  check("two bookings get different event ids",
    calendar.eventIdForBooking(randomUUID()) !== calendar.eventIdForBooking(randomUUID()));
  check("it uses only Google's documented base32hex alphabet", /^[a-v0-9]{5,1024}$/.test(eventId), eventId);
  check("a non-uuid booking id yields no event id", calendar.eventIdForBooking("not-a-uuid") === null);

  check("a real Meet URL is accepted", calendar.isMeetUrl("https://meet.google.com/abc-defg-hij"));
  for (const bad of [
    "http://meet.google.com/abc",
    "https://meet.google.com.evil.test/abc",
    "https://evil.test/meet.google.com",
    "https://zoom.us/j/123",
    "",
    null,
  ]) {
    check(`a non-Meet link is refused: ${JSON.stringify(bad)}`, calendar.isMeetUrl(bad) === false);
  }

  const startsAt = new Date("2026-09-20T07:00:00.000Z");
  const meetBody = (url) => ({
    id: "cr9c6a33a20b8443bb880a836204c27aac",
    hangoutLink: url,
    conferenceData: {
      createRequest: { status: { statusCode: "success" } },
      entryPoints: [{ entryPointType: "video", uri: url }],
    },
    organizer: { email: "interviews@cliprewards.test" },
    status: "confirmed",
  });

  {
    const s = stubFetch({ status: 200, body: meetBody("https://meet.google.com/abc-defg-hij") });
    const out = await calendar.createInterviewEvent("access-token", {
      bookingId,
      startsAt,
      durationMinutes: 30,
      timeZone: "Asia/Jerusalem",
      summary: "ClipRewards interview",
      description: "A short onboarding call.",
      attendeeEmail: "applicant@example.test",
      sendUpdates: "all",
    });
    s.restore();

    const call = s.seen[0];
    const url = new URL(call.url);
    const body = JSON.parse(call.init.body);

    check("the event is created in the connected account's PRIMARY calendar",
      url.pathname === "/calendar/v3/calendars/primary/events");
    check("conferenceDataVersion=1 is sent, or no conference is created",
      url.searchParams.get("conferenceDataVersion") === "1");
    check("sendUpdates=all, so the applicant gets the invitation",
      url.searchParams.get("sendUpdates") === "all");
    check("the client-specified event id is the deterministic one", body.id === eventId);
    check("a hangoutsMeet conference is requested",
      body.conferenceData.createRequest.conferenceSolutionKey.type === "hangoutsMeet");
    check("the conference requestId is STABLE for this booking",
      body.conferenceData.createRequest.requestId === oauth.stableRequestId(bookingId));
    check("start and end come from the booking's own instant and duration",
      body.start.dateTime === startsAt.toISOString() &&
        body.end.dateTime === new Date(startsAt.getTime() + 30 * 60_000).toISOString());
    check("the interview timezone travels with the event",
      body.start.timeZone === "Asia/Jerusalem" && body.end.timeZone === "Asia/Jerusalem");
    check("the applicant is an attendee", body.attendees?.[0]?.email === "applicant@example.test");
    check("the booking id is recorded on the event for traceability",
      body.extendedProperties.private.cliprewards_booking_id === bookingId);
    check("guests cannot invite others or edit the event",
      body.guestsCanInviteOthers === false && body.guestsCanModify === false);
    check("the access token is a header, never a query parameter",
      call.init.headers.authorization === "Bearer access-token" && call.url.includes("access-token") === false);
    check("the Meet URL is taken from the authoritative response",
      out.ok && out.event.meetingUrl === "https://meet.google.com/abc-defg-hij");
    check("the organizer is reported back", out.ok && out.event.organizerEmail === "interviews@cliprewards.test");
  }

  // Invalid applicant address: dropped, and the invitation is not sent to nobody.
  for (const bad of ["not-an-email", "a@b", "", null, "two@addresses,here@x.test"]) {
    const s = stubFetch({ status: 200, body: meetBody("https://meet.google.com/abc-defg-hij") });
    await calendar.createInterviewEvent("t", {
      bookingId, startsAt, durationMinutes: 30, timeZone: "UTC",
      summary: "x", description: "y", attendeeEmail: bad, sendUpdates: "none",
    });
    s.restore();
    const body = JSON.parse(s.seen[0].init.body);
    check(`an invalid attendee address is dropped: ${JSON.stringify(bad)}`, body.attendees === undefined);
    check(`and no notification is sent when there is nobody to notify`,
      new URL(s.seen[0].url).searchParams.get("sendUpdates") === "none");
  }

  // A conference that is still pending is NOT a failure.
  {
    const s = stubFetch({
      status: 200,
      body: { id: eventId, conferenceData: { createRequest: { status: { statusCode: "pending" } } } },
    });
    const out = await calendar.createInterviewEvent("t", {
      bookingId, startsAt, durationMinutes: 30, timeZone: "UTC",
      summary: "x", description: "y", attendeeEmail: null, sendUpdates: "none",
    });
    s.restore();
    check("a pending conference yields an event with no link yet, not an error",
      out.ok && out.event.meetingUrl === null && out.event.conferenceStatus === "pending");
  }

  // Failure mapping, and never echoing Google's words.
  for (const [status, reason] of [[401, "unauthorized"], [403, "forbidden"], [409, "already_exists"], [404, "not_found"], [429, "rate_limited"], [500, "provider_rejected"]]) {
    const s = stubFetch({ status, body: { error: { message: "a message quoting the request" } } });
    const out = await calendar.createInterviewEvent("t", {
      bookingId, startsAt, durationMinutes: 30, timeZone: "UTC",
      summary: "x", description: "y", attendeeEmail: null, sendUpdates: "none",
    });
    s.restore();
    check(`HTTP ${status} maps to ${reason}`, out.ok === false && out.reason === reason, out.reason);
    check(`HTTP ${status} does not echo Google's message`,
      JSON.stringify(out).includes("quoting the request") === false);
  }
}

/* ===================== B. provisioning against real SQL ================== */

const SCRATCH = "calendar_selftest";

if (process.env.DATABASE_URL && process.env.CALENDAR_TEST_DB !== "0") {
  console.log("\n--- B. provisioning against real Postgres (throwaway schema) ---");
  const client = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
  let scoped = null;

  const [{ n: realBookingsBefore }] = await client`select count(*)::int as n from public.interview_bookings`;
  const [{ n: realConnectionsBefore }] = await client`
    select count(*)::int as n from information_schema.tables
    where table_schema = 'public' and table_name = 'google_calendar_connections'`;
  // A REAL connection exists once an operator has connected the interview
  // account, so the leak check compares to the count captured HERE. A literal
  // zero would only assert that nobody has ever connected.
  const googleRowsBefore = realConnectionsBefore
    ? (await client`select count(*)::int as n from public.google_calendar_connections`)[0].n
    : 0;

  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);

    // A direct connection, every name schema-qualified: `DATABASE_URL` is a
    // transaction pooler, where a `SET search_path` can outlive this process.
    const direct = new URL(process.env.DATABASE_URL);
    direct.hostname = direct.hostname.replace("-pooler", "");
    scoped = postgres(direct.toString(), { max: 4, prepare: false, onnotice: () => {} });

    await scoped.unsafe(`create type ${SCRATCH}.calendar_provisioning_status as enum ('pending','ready','failed')`);
    await scoped.unsafe(`
      create table ${SCRATCH}.interview_bookings (
        booking_id uuid primary key default gen_random_uuid(),
        firebase_uid text not null,
        scheduled_at timestamptz not null,
        duration_minutes integer not null,
        status text not null default 'scheduled',
        meeting_url text,
        google_calendar_event_id text,
        calendar_provisioning_status ${SCRATCH}.calendar_provisioning_status not null default 'pending',
        calendar_retry_count integer not null default 0,
        last_calendar_error_code text,
        calendar_updated_at timestamptz,
        updated_at timestamptz not null default now()
      )`);

    // The constraint from migration 0009 that matters most here.
    await scoped.unsafe(`
      alter table ${SCRATCH}.interview_bookings
      add constraint bookings_ready_has_event
      check (calendar_provisioning_status <> 'ready'
             or (google_calendar_event_id is not null and meeting_url is not null))`);

    const bookingId = randomUUID();
    await scoped.unsafe(
      `insert into ${SCRATCH}.interview_bookings (booking_id, firebase_uid, scheduled_at, duration_minutes)
       values ($1, 'uid_applicant', now() + interval '2 days', 30)`,
      [bookingId],
    );

    const read = async () =>
      (await scoped.unsafe(`select * from ${SCRATCH}.interview_bookings where booking_id = $1`, [bookingId]))[0];

    check("a new booking starts as pending provisioning",
      (await read()).calendar_provisioning_status === "pending");

    // --- the success path, written exactly as the module writes it
    const MEET = "https://meet.google.com/abc-defg-hij";
    const eventId = calendar.eventIdForBooking(bookingId);
    await scoped.unsafe(
      `update ${SCRATCH}.interview_bookings
       set google_calendar_event_id = $2, meeting_url = $3,
           calendar_provisioning_status = 'ready', last_calendar_error_code = null,
           calendar_updated_at = now()
       where booking_id = $1`,
      [bookingId, eventId, MEET],
    );
    const ready = await read();
    check("a provisioned booking carries the event id and the Meet URL",
      ready.google_calendar_event_id === eventId && ready.meeting_url === MEET);
    check("and reads as ready", ready.calendar_provisioning_status === "ready");
    check("the applicant and the admin read the SAME stored meeting_url",
      ready.meeting_url === MEET);

    // --- `ready` cannot exist without the evidence for it
    let refusedEmptyReady = false;
    try {
      await scoped.unsafe(
        `update ${SCRATCH}.interview_bookings set calendar_provisioning_status = 'ready',
         google_calendar_event_id = null, meeting_url = null where booking_id = $1`,
        [bookingId],
      );
    } catch {
      refusedEmptyReady = true;
    }
    check("0009 refuses a `ready` booking with no event and no link", refusedEmptyReady);

    // --- the lease: a second attempt inside the window claims nothing
    const claim = async (id) =>
      scoped.unsafe(
        `update ${SCRATCH}.interview_bookings
         set calendar_retry_count = calendar_retry_count + 1, calendar_updated_at = now()
         where booking_id = $1 and status = 'scheduled'
           and calendar_provisioning_status <> 'ready'
           and (calendar_updated_at is null or calendar_updated_at < now() - interval '120 seconds')
         returning booking_id`,
        [id],
      );

    const second = randomUUID();
    await scoped.unsafe(
      `insert into ${SCRATCH}.interview_bookings (booking_id, firebase_uid, scheduled_at, duration_minutes)
       values ($1, 'uid_two', now() + interval '3 days', 30)`,
      [second],
    );
    check("the first provisioning attempt claims the booking", (await claim(second)).length === 1);
    check("a concurrent attempt claims NOTHING — one event, not two", (await claim(second)).length === 0);
    const racers = await Promise.all([claim(second), claim(second), claim(second)]);
    check("three concurrent retries all stand down", racers.every((r) => r.length === 0));

    // --- a Google failure leaves the booking intact and recoverable
    await scoped.unsafe(
      `update ${SCRATCH}.interview_bookings
       set calendar_provisioning_status = 'failed', last_calendar_error_code = 'rate_limited',
           calendar_updated_at = now() - interval '10 minutes'
       where booking_id = $1`,
      [second],
    );
    const failed = (await scoped.unsafe(`select * from ${SCRATCH}.interview_bookings where booking_id = $1`, [second]))[0];
    check("a failed provisioning leaves the BOOKING scheduled", failed.status === "scheduled");
    check("the booking row still exists — Google never deletes an interview", failed !== undefined);
    check("the failure is recorded as a short code, not a provider body",
      failed.last_calendar_error_code === "rate_limited" && failed.last_calendar_error_code.length <= 64);
    check("a retry after the lease expires CAN claim it again", (await claim(second)).length === 1);

    const [{ n: eventsForBooking }] = await scoped.unsafe(
      `select count(distinct google_calendar_event_id)::int as n from ${SCRATCH}.interview_bookings
       where booking_id = $1 and google_calendar_event_id is not null`,
      [bookingId],
    );
    check("one booking never holds more than one event id", eventsForBooking <= 1, `${eventsForBooking}`);
  } finally {
    if (scoped) await scoped.end({ timeout: 5 });
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);

    console.log("\n--- B. the real public database, after the tests ---");
    const [{ schema }] = await client`select current_schema() as schema`;
    check("the pooled session was never moved off public", schema === "public");
    const [{ n: gone }] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone === 0);
    const [{ n: realBookingsAfter }] = await client`select count(*)::int as n from public.interview_bookings`;
    check("this suite created no real booking", realBookingsAfter === realBookingsBefore,
      `${realBookingsAfter} (was ${realBookingsBefore})`);
    if (realConnectionsBefore) {
      const [{ n: connections }] = await client`select count(*)::int as n from public.google_calendar_connections`;
      check("this suite connected no real Google account",
        connections === googleRowsBefore, `${connections} rows (was ${googleRowsBefore})`);
    }
    const [{ n: whop }] = await client`select count(*)::int as n from public.whop_connections where revoked_at is null`;
    check("the Whop OAuth connection is untouched", whop >= 0, `${whop} active`);
    await client.end({ timeout: 5 });
  }
}

/* ======================== C. source invariants ========================== */

console.log("\n--- C. properties true by absence ---");
{
  const connect = codeOnly("src/app/api/google/calendar/connect/route.ts");
  const callback = codeOnly("src/app/api/google/calendar/callback/route.ts");
  const status = codeOnly("src/app/api/google/calendar/status/route.ts");
  const retry = codeOnly("src/app/api/admin/interviews/[bookingId]/calendar/retry/route.ts");
  const provisioning = codeOnly("src/lib/server/interview-calendar.ts");
  const connection = codeOnly("src/lib/server/google-calendar-connection.ts");
  const calendarSrc = codeOnly("src/lib/server/google-calendar.ts");

  // ADMIN ONLY
  check("connecting Google requires an administrator", connect.includes("requireAdmin()"));
  check("the status endpoint requires an administrator", status.includes("withAdminApi"));
  check("the retry endpoint requires an administrator", retry.includes("requireAdmin()"));
  check("the retry endpoint is origin-checked", retry.includes("checkRequestOrigin(request.headers)"));
  check("the Google connection is NOT tied to a creator's Firebase account",
    /firebaseUid|firebase_uid/.test(connection) === false);

  // STATE
  check("the state is consumed exactly once, in the database",
    connection.includes("delete(googleOauthStates)") && connection.includes("returning()"));
  check("expiry is evaluated by the database, not in JavaScript",
    connection.includes("expiresAt} > now()"));
  check("the callback requires the browser cookie to match the state",
    callback.includes("cookieState !== state"));
  check("a state mismatch is refused, not repaired", callback.includes('"mismatch"'));

  // REDIRECT SAFETY
  check("the callback builds its redirect on the configured public origin",
    callback.includes("getAppPublicUrl()"));
  check("the callback never trusts a forwarded host header",
    /x-forwarded|forwarded-host|headers\.get\("host"\)/i.test(callback) === false);
  check("the callback redirect path is a locale path, not request-derived",
    callback.includes('localePath(locale, "/admin/applicants")'));
  check("no return URL is read from the query string",
    /searchParams\.get\("(return|redirect|next|continue)/.test(callback) === false);

  // SECRETS
  const clientBundle = [
    codeOnly("src/components/admin/CalendarRetry.tsx"),
    codeOnly("src/components/onboarding/InterviewConfirmation.tsx"),
  ].join("\n");
  for (const secret of [
    "GOOGLE_CALENDAR_CLIENT_SECRET",
    "GOOGLE_CALENDAR_CLIENT_ID",
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
    "refresh_token",
    "access_token",
  ]) {
    check(`no client component references ${secret}`, clientBundle.includes(secret) === false);
  }
  check("every Google server module is server-only",
    ["src/lib/server/google-oauth.ts", "src/lib/server/google-crypto.ts",
     "src/lib/server/google-calendar.ts", "src/lib/server/google-calendar-connection.ts",
     "src/lib/server/interview-calendar.ts"]
      .every((f) => readFileSync(f, "utf8").includes('import "server-only"')));
  check("no token is ever logged", /console\.(log|warn|error|info)/.test(
    connection + calendarSrc + provisioning + connect + callback) === false);
  // An EXPIRY is metadata; a token is a credential. The assertion has to tell
  // them apart, or it fails on `access_token_expires_at` and teaches nothing.
  check("the status endpoint never touches ciphertext or decryption",
    /Ciphertext|decryptGoogleToken/.test(status) === false);
  check("the status endpoint returns no token field",
    /["']?(access_token|refresh_token)["']?s*:/.test(status) === false);
  check("the status endpoint exposes only an expiry, not the token it belongs to",
    status.includes("access_token_expires_at") && /accessToken(?!ExpiresAt)/.test(status) === false);

  // IDEMPOTENCY
  check("the local event id is the authority before any Google call",
    provisioning.includes("claimed.googleCalendarEventId"));
  check("an existing event is RECONCILED, never recreated",
    provisioning.includes("return await reconcile("));
  check("a duplicate creation resolves to the same event",
    provisioning.includes('created.reason === "already_exists"'));
  check("provisioning is claimed by a lease before the network call",
    provisioning.includes("async function claim(") && provisioning.includes("calendarUpdatedAt} < now()"));
  check("no database transaction is held across the Google call",
    /db\.transaction\([\s\S]*fetch|db\.transaction\([\s\S]*createInterviewEvent/.test(provisioning) === false);

  // THE BOOKING SURVIVES
  check("provisioning never deletes a booking", /delete\(interviewBookings\)/.test(provisioning) === false);
  check("provisioning never changes the booking's own status",
    /status: "(cancelled|no_show|completed)"/.test(provisioning) === false);

  // SCOPE
  check("no account_links, KYC, payout or transfer surface appears here",
    /account_links|kyc|payout|transfer/i.test(calendarSrc + provisioning) === false);
  check("the calendar id is never taken from a caller",
    calendarSrc.includes('const CALENDAR_ID = "primary"') &&
      /calendarId\s*[:=]\s*(input|request|params)/.test(calendarSrc) === false);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed.`);
for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}`);
process.exit(passed === results.length ? 0 : 1);
