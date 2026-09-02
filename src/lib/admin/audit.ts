/* ==========================================================================
   ADMIN AUDIT LOG — data model.

   No records are written yet, and none are invented. This defines the shape so
   that the first privileged action to ship writes a real one.

   Design rules:
     - append-only; an audit trail that can be edited is not a trail;
     - identify the actor by uid, and keep the email only as it was at the time,
       because an audit read six months later must not depend on a live lookup;
     - record what changed, not the full record — a payout adjustment logs the
       before and after amount, never the payee's bank details;
     - `ip` is deliberately absent. Country is enough to spot an anomalous
       session, and storing raw IPs would contradict the Privacy Policy.
   ========================================================================== */

export const AUDIT_ACTIONS = [
  "admin_signed_in",
  "admin_signed_out",
  "admin_role_granted",
  "admin_role_revoked",
  "user_suspended",
  "user_reinstated",
  "campaign_edited",
  "campaign_cancelled",
  "submission_force_approved",
  "submission_force_rejected",
  "payout_adjusted",
  "refund_issued",
  "setting_changed",
  "data_exported",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTargetType =
  | "user"
  | "creator"
  | "brand"
  | "campaign"
  | "submission"
  | "transaction"
  | "setting"
  | "none";

export type AuditRecord = {
  event_id: string;
  /** Firebase uid of the acting administrator. */
  admin_uid: string;
  /** Snapshot at the time of the action, for readability without a live lookup. */
  admin_email_at_time: string | null;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string | null;
  /** Server clock, ISO 8601. */
  timestamp: string;
  /**
   * What changed. Keep to identifiers, enum values and amounts. Never copy a
   * whole entity in here, and never anything a user typed.
   */
  metadata: Record<string, string | number | boolean | null>;
  /** Correlates several actions taken in one admin session. */
  session_id: string | null;
  /** ISO country of the admin session. No IP is stored. */
  country: string | null;
};

/**
 * Actions that must never be silently possible. Each of these has to write an
 * audit record in the same operation that performs it — if the write fails,
 * the action fails.
 */
export const REQUIRES_AUDIT: ReadonlySet<AuditAction> = new Set([
  "admin_role_granted",
  "admin_role_revoked",
  "user_suspended",
  "payout_adjusted",
  "refund_issued",
  "submission_force_approved",
  "submission_force_rejected",
  "data_exported",
]);
