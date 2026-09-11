import "server-only";

/* ==========================================================================
   INTERVIEW AVAILABILITY — a configuration boundary, not a guess.

   THE PRODUCT DOES NOT YET KNOW WHEN CLIPREWARDS IS OPEN. There is no existing
   source of truth anywhere in this repository for operating days, hours,
   timezone or interview length — I looked. So this module refuses to invent
   them.

   With nothing configured, `resolveAvailabilityConfig()` returns a REFUSAL and
   every slot listing and every booking attempt fails closed with
   `availability_unconfigured`. That is deliberate: a default of "9-5 Monday to
   Friday, UTC" would silently create a real business commitment nobody made,
   and applicants would book interviews at times staff never agreed to attend.

   WHAT AN OPERATOR MUST DECIDE before this can run in production — all four,
   with no defaults available:

     INTERVIEW_TIMEZONE          IANA zone, e.g. "Asia/Jerusalem".
                                 Not an offset: offsets break twice a year.
     INTERVIEW_DAYS              Comma-separated weekdays, 0=Sunday .. 6=Saturday,
                                 e.g. "0,1,2,3,4" for a Sunday-Thursday week.
     INTERVIEW_HOURS             "HH:MM-HH:MM" in the zone above, e.g. "10:00-17:00".
                                 The window a slot may START in.
     INTERVIEW_SLOT_MINUTES      Slot length, e.g. "30".

   Two more have safe defaults because they are operational comfort rather than
   business commitments, and are stated here so they are not invisible:

     INTERVIEW_MIN_NOTICE_HOURS  How far ahead a slot must be. Default 24.
     INTERVIEW_HORIZON_DAYS      How far ahead slots are offered. Default 14.

   TESTS SUPPLY CONFIGURATION EXPLICITLY. Every function here takes an optional
   env record, so the suite passes a known configuration rather than depending
   on whatever a machine happens to have set — and the unconfigured path is
   itself a tested case rather than an accident.
   ========================================================================== */

export type AvailabilityConfig = {
  /** IANA timezone the operating window is expressed in. */
  timezone: string;
  /** Weekdays interviews are offered on. 0 = Sunday. */
  days: number[];
  /** Minutes from local midnight at which the window opens. */
  openMinute: number;
  /** Minutes from local midnight after which no slot may START. */
  closeMinute: number;
  slotMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
};

export type AvailabilityResolution =
  | { ok: true; config: AvailabilityConfig }
  | {
      ok: false;
      reason: "unconfigured" | "invalid";
      /** Which settings are missing or wrong. Safe to log and to show staff. */
      missing: string[];
    };

type Env = Record<string, string | undefined>;

const REQUIRED = [
  "INTERVIEW_TIMEZONE",
  "INTERVIEW_DAYS",
  "INTERVIEW_HOURS",
  "INTERVIEW_SLOT_MINUTES",
] as const;

function read(env: Env, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** "10:00" -> 600. Refuses anything that is not a real 24-hour time. */
export function parseClock(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Verifies a zone by asking the platform to use it. No hard-coded list. */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the configuration, or says precisely what is missing.
 *
 * Pure and env-injectable, so the rules can be asserted without touching the
 * real process environment — the same shape `resolveWhopPayments` uses.
 */
export function resolveAvailabilityConfig(env: Env = process.env): AvailabilityResolution {
  const missing = REQUIRED.filter((name) => read(env, name) === null);
  if (missing.length > 0) return { ok: false, reason: "unconfigured", missing: [...missing] };

  const invalid: string[] = [];

  const timezone = read(env, "INTERVIEW_TIMEZONE") as string;
  if (!isValidTimezone(timezone)) invalid.push("INTERVIEW_TIMEZONE");

  const days = (read(env, "INTERVIEW_DAYS") as string)
    .split(",")
    .map((d) => Number(d.trim()));
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    invalid.push("INTERVIEW_DAYS");
  }

  const hours = (read(env, "INTERVIEW_HOURS") as string).split("-");
  const openMinute = hours.length === 2 ? parseClock(hours[0]) : null;
  const closeMinute = hours.length === 2 ? parseClock(hours[1]) : null;
  if (openMinute === null || closeMinute === null || closeMinute <= openMinute) {
    invalid.push("INTERVIEW_HOURS");
  }

  const slotMinutes = Number(read(env, "INTERVIEW_SLOT_MINUTES"));
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 240) {
    invalid.push("INTERVIEW_SLOT_MINUTES");
  }

  // Optional, with stated defaults.
  const noticeRaw = read(env, "INTERVIEW_MIN_NOTICE_HOURS");
  const minNoticeHours = noticeRaw === null ? 24 : Number(noticeRaw);
  if (!Number.isInteger(minNoticeHours) || minNoticeHours < 0 || minNoticeHours > 720) {
    invalid.push("INTERVIEW_MIN_NOTICE_HOURS");
  }

  const horizonRaw = read(env, "INTERVIEW_HORIZON_DAYS");
  const horizonDays = horizonRaw === null ? 14 : Number(horizonRaw);
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 180) {
    invalid.push("INTERVIEW_HORIZON_DAYS");
  }

  if (invalid.length > 0) return { ok: false, reason: "invalid", missing: invalid };

  return {
    ok: true,
    config: {
      timezone,
      days: [...new Set(days)].sort((a, b) => a - b),
      openMinute: openMinute as number,
      closeMinute: closeMinute as number,
      slotMinutes,
      minNoticeHours,
      horizonDays,
    },
  };
}

/** Report-only. Never a reason to skip a check. */
export function isAvailabilityConfigured(env: Env = process.env): boolean {
  return resolveAvailabilityConfig(env).ok;
}

/* -------------------------------------------------------------------------
   SLOTS
   ------------------------------------------------------------------------- */

/**
 * Reads an instant's wall-clock parts IN A GIVEN ZONE.
 *
 * `Intl.DateTimeFormat` rather than arithmetic on the offset, because the
 * offset changes across a DST boundary and any hand-rolled version is wrong
 * twice a year. This is the only place the conversion happens.
 */
export function zonedParts(
  instant: Date,
  timezone: string,
): { weekday: number; minuteOfDay: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.weekday ?? "",
  );
  // `hour` can render as "24" at midnight under hour12:false in some runtimes.
  const hour = Number(parts.hour) % 24;
  return {
    weekday: weekdayIndex,
    minuteOfDay: hour * 60 + Number(parts.minute),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export type SlotCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "availability_unconfigured"
        | "not_on_a_slot_boundary"
        | "outside_operating_days"
        | "outside_operating_hours"
        | "too_soon"
        | "beyond_horizon"
        | "invalid_instant";
    };

/**
 * Whether one instant is a bookable slot.
 *
 * THE SAME FUNCTION VALIDATES A BOOKING AND GENERATES THE LIST. A user can
 * only submit a time; the server never trusts that it came from a list it
 * offered, because a client can post any instant it likes. Re-checking here is
 * what makes the offered list a convenience rather than a security boundary.
 */
export function isBookableSlot(
  instant: Date,
  now: Date,
  env: Env = process.env,
): SlotCheck {
  const resolved = resolveAvailabilityConfig(env);
  if (!resolved.ok) return { ok: false, reason: "availability_unconfigured" };
  const config = resolved.config;

  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return { ok: false, reason: "invalid_instant" };
  }

  const noticeMs = config.minNoticeHours * 3600_000;
  if (instant.getTime() < now.getTime() + noticeMs) return { ok: false, reason: "too_soon" };

  const horizonMs = config.horizonDays * 86_400_000;
  if (instant.getTime() > now.getTime() + horizonMs) {
    return { ok: false, reason: "beyond_horizon" };
  }

  const parts = zonedParts(instant, config.timezone);
  if (!config.days.includes(parts.weekday)) {
    return { ok: false, reason: "outside_operating_days" };
  }

  // A slot must START inside the window and must not run past its close.
  if (
    parts.minuteOfDay < config.openMinute ||
    parts.minuteOfDay + config.slotMinutes > config.closeMinute
  ) {
    return { ok: false, reason: "outside_operating_hours" };
  }

  // And must land on a boundary, so slots tile the day rather than overlap.
  if ((parts.minuteOfDay - config.openMinute) % config.slotMinutes !== 0) {
    return { ok: false, reason: "not_on_a_slot_boundary" };
  }

  return { ok: true };
}

export type SlotListing =
  | { ok: true; slots: string[]; timezone: string; slotMinutes: number }
  | { ok: false; reason: "availability_unconfigured" | "invalid"; missing: string[] };

/**
 * The slots on offer, as ISO instants.
 *
 * Generated by walking every minute-boundary candidate inside the horizon and
 * asking `isBookableSlot` — the same predicate the booking path uses — so the
 * list and the check can never disagree. Bounded by `horizonDays`, which is
 * itself bounded at 180.
 */
export function listAvailableSlots(now: Date, env: Env = process.env): SlotListing {
  const resolved = resolveAvailabilityConfig(env);
  if (!resolved.ok) return { ok: false, reason: resolved.reason === "unconfigured" ? "availability_unconfigured" : "invalid", missing: resolved.missing };
  const config = resolved.config;

  const slots: string[] = [];
  const startMs = now.getTime() + config.minNoticeHours * 3600_000;
  const endMs = now.getTime() + config.horizonDays * 86_400_000;

  // Step in slot-sized increments from the next whole slot boundary. Starting
  // from a rounded minute keeps the candidate set small and deterministic.
  const stepMs = config.slotMinutes * 60_000;
  let cursor = Math.ceil(startMs / stepMs) * stepMs;

  while (cursor <= endMs) {
    const candidate = new Date(cursor);
    if (isBookableSlot(candidate, now, env).ok) slots.push(candidate.toISOString());
    cursor += stepMs;
  }

  return { ok: true, slots, timezone: config.timezone, slotMinutes: config.slotMinutes };
}
