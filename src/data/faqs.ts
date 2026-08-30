import type { Role } from "@/components/RoleToggle";

/**
 * Help-centre structure: which questions sit under which heading, and in what
 * order. The wording lives in the dictionaries (`faqs.categoryTitles` and
 * `faqs.items`), keyed by the ids below, so the same shape serves every
 * language and a missing translation is a TypeScript error rather than an
 * English string leaking onto a Hebrew page.
 */

export type FAQCategoryId =
  | "earnings"
  | "accounts"
  | "campaigns"
  | "submissions"
  | "review"
  | "platforms"
  | "launching"
  | "billing"
  | "creators"
  | "reviewing"
  | "agencies";

export type FAQCategory = {
  id: FAQCategoryId;
  /** Question ids, in display order. */
  items: string[];
};

export const FAQ_CATEGORIES: Record<Role, FAQCategory[]> = {
  creator: [
    {
      id: "earnings",
      items: ["cut", "frequency", "where", "missing", "afterEnd", "perVideoCap", "minViews"],
    },
    { id: "accounts", items: ["link", "why", "multiple", "private"] },
    {
      id: "campaigns",
      items: ["howItWorks", "whoCanJoin", "followers", "geo", "whereToFind", "cpm"],
    },
    { id: "submissions", items: ["how", "limit", "before", "duplicate", "wrongLink"] },
    { id: "review", items: ["rejected", "flagged", "submitted", "duration"] },
    { id: "platforms", items: ["which", "crossPost"] },
  ],

  brand: [
    { id: "launching", items: ["speed", "brief", "rate", "geo"] },
    { id: "billing", items: ["payingFor", "topUp", "unspent", "fees"] },
    { id: "creators", items: ["legitimacy", "gating", "following"] },
    { id: "reviewing", items: ["how", "suspicious", "deadline"] },
    { id: "agencies", items: ["agency", "seats"] },
  ],
};
