import "server-only";

import { redirect } from "next/navigation";
import { localePath } from "@/i18n/config";
import { coerceLocale } from "@/i18n/server";
import { getAccessContext, type AccessContext } from "./access";
import { STAGE_DESTINATIONS, type AccessStage } from "./user-lifecycle";

/* ==========================================================================
   SERVER-SIDE PAGE GUARDS.

   THE SECURITY BOUNDARY IS HERE, NOT IN `AuthGate`. `AuthGate` is a client
   component: it decides what to render, which is a UX concern, and a browser
   can simply not run it. These functions run on the server before any markup
   is produced, so a caller in the wrong stage never receives the page at all.

   Every guard resolves through `getAccessContext`, the one authorization
   helper, so a page and an API route asked about the same user get the same
   answer.

   REDIRECTS ARE LOCALE-AWARE. A Hebrew visitor sent to `/onboarding` must land
   on `/he/onboarding`, not lose their language at the guard.
   ========================================================================== */

/** Sends the caller where their stage belongs, and does not return. */
function sendToStage(locale: string, stage: AccessStage): never {
  redirect(localePath(coerceLocale(locale), STAGE_DESTINATIONS[stage]));
}

/**
 * Requires a verified identity. Used by every page an applicant may see.
 *
 * Returns the context so the page can render the right thing for the stage
 * without asking again.
 */
export async function requireSignedIn(locale: string): Promise<AccessContext> {
  const context = await getAccessContext();
  if (context.uid === null) sendToStage(locale, "unauthenticated");
  return context;
}

/**
 * Requires that the caller be in ONE OF the given stages, and redirects to
 * where they actually belong otherwise.
 *
 * An allowlist rather than a denylist: a stage nobody thought about is refused
 * and routed, never admitted by omission.
 */
export async function requireStage(
  locale: string,
  allowed: readonly AccessStage[],
): Promise<AccessContext> {
  const context = await requireSignedIn(locale);
  if (!allowed.includes(context.stage)) sendToStage(locale, context.stage);
  return context;
}

/**
 * THE GATE IN FRONT OF EVERY OPERATIONAL AREA. Only approved accounts pass.
 *
 * A pending applicant is sent to the waiting page, a rejected one to the
 * refusal page, and someone who has not finished onboarding back to it — each
 * to the place that explains their actual situation rather than to a generic
 * login screen.
 */
export async function requireApprovedPage(locale: string): Promise<AccessContext> {
  const context = await requireSignedIn(locale);
  if (!context.hasPlatformAccess) sendToStage(locale, context.stage);
  return context;
}
