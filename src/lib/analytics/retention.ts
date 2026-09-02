/* ==========================================================================
   DATA RETENTION — categories now, durations later.

   No period below is invented. Analytics and session retention are product
   decisions; financial and audit retention are likely to carry statutory
   minimums in whichever jurisdictions ClipRewards ends up operating in, and
   guessing at them would put a wrong number into a policy document.

   Nothing is deleted automatically. A deletion job may only be written once a
   category here has a real, reviewed value.
   ========================================================================== */

export type RetentionCategory = {
  description: string;
  /** null = unresolved. A job must refuse to run against null. */
  retain_days: number | null;
  requires_legal_review: boolean;
  note: string;
};

export const RETENTION: Record<string, RetentionCategory> = {
  analytics_events: {
    description: "Individual product events with session, locale, country and device.",
    retain_days: null,
    requires_legal_review: true,
    note: "Product decision, informed by whichever privacy regimes apply. Aggregates can outlive raw rows.",
  },
  analytics_sessions: {
    description: "Session summaries with first-touch attribution.",
    retain_days: null,
    requires_legal_review: true,
    note: "Usually kept longer than raw events because it is smaller and drives cohort reporting.",
  },
  user_analytics: {
    description: "Per-account reporting attributes keyed by Firebase uid.",
    retain_days: null,
    requires_legal_review: true,
    note: "Must be deleted or detached when an account is deleted, once an account-deletion flow exists.",
  },
  admin_audit_log: {
    description: "Record of privileged administrative actions.",
    retain_days: null,
    requires_legal_review: true,
    note: "Likely the longest retention of any category. Do not delete before counsel confirms.",
  },
  financial_ledger: {
    description: "Transactions, payouts, fees and refunds.",
    retain_days: null,
    requires_legal_review: true,
    note: "Tax and accounting law will set a statutory minimum. Never delete on a guessed period.",
  },
};

/** Guard for any future deletion job. */
export function canPurge(category: keyof typeof RETENTION): boolean {
  const entry = RETENTION[category];
  return entry?.retain_days !== null && entry?.retain_days !== undefined;
}
