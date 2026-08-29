/**
 * Legal identity values that only ClipRewards can supply.
 *
 * Every one of these renders literally on /privacy-policy and /terms-of-service
 * as a bracketed placeholder, so an unfilled value is impossible to miss on the
 * page. Replace the strings here and both documents update — never hardcode a
 * company name, address, email or jurisdiction into the legal copy itself.
 *
 * LEGAL REVIEW REQUIRED before production launch:
 *  - a lawyer must review both documents against the jurisdictions ClipRewards
 *    will actually operate and market in;
 *  - the advertising/endorsement disclosure section is deliberately
 *    jurisdiction-neutral — consider adding jurisdiction-specific terms (for
 *    example US FTC endorsement guidance, EU/UK equivalents) before launch;
 *  - confirm whether any statutory privacy regime (GDPR, UK GDPR, CCPA/CPRA,
 *    LGPD, …) applies, and add the disclosures each one requires;
 *  - confirm the "we do not sell personal information" position with counsel
 *    before relying on it commercially.
 */

export const LEGAL_COMPANY_NAME = "[LEGAL COMPANY NAME]";
export const LEGAL_CONTACT_EMAIL = "[LEGAL CONTACT EMAIL]";
export const PRIVACY_EMAIL = "[PRIVACY EMAIL]";
export const REGISTERED_ADDRESS = "[REGISTERED ADDRESS]";
export const GOVERNING_LAW = "[GOVERNING LAW]";
export const JURISDICTION = "[JURISDICTION]";

/** Minimum age to hold an account. Not defined anywhere in the product yet. */
export const MINIMUM_AGE = "[MINIMUM AGE]";

/** Where accessibility problems and requests for an alternative format go. */
export const ACCESSIBILITY_CONTACT_EMAIL = "[ACCESSIBILITY CONTACT EMAIL]";

/** Company registration number, where one is required to be published. */
export const COMPANY_REGISTRATION_NUMBER = "[COMPANY REGISTRATION NUMBER]";

/** ISO date. Bump this whenever either document changes substantively. */
export const LEGAL_LAST_UPDATED = "2026-08-29";

export function formatLegalDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
