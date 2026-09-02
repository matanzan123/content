import type { Dictionary } from "@/i18n/dictionaries/en";

/* ==========================================================================
   ADMIN INFORMATION ARCHITECTURE

   One list drives the sidebar, the page titles and the active state, so a
   section cannot exist in the navigation without a route or vice versa.
   ========================================================================== */

export type NavKey = keyof Dictionary["admin"]["nav"];

export type NavItem = { key: NavKey; href: string; icon: IconName };
export type NavGroup = { labelKey: "groupBusiness" | "groupAnalytics" | "groupPlatform" | "groupAdmin" | null; items: NavItem[] };

export type IconName =
  | "overview" | "revenue" | "users" | "activity" | "geography"
  | "traffic" | "pages" | "funnels" | "events"
  | "campaigns" | "creators" | "brands" | "audit" | "system";

export const NAV_GROUPS: NavGroup[] = [
  { labelKey: null, items: [{ key: "overview", href: "/admin", icon: "overview" }] },
  {
    labelKey: "groupBusiness",
    items: [
      { key: "revenue", href: "/admin/revenue", icon: "revenue" },
      { key: "users", href: "/admin/users", icon: "users" },
      { key: "activity", href: "/admin/activity", icon: "activity" },
      { key: "geography", href: "/admin/geography", icon: "geography" },
    ],
  },
  {
    labelKey: "groupAnalytics",
    items: [
      { key: "traffic", href: "/admin/traffic", icon: "traffic" },
      { key: "pages", href: "/admin/pages", icon: "pages" },
      { key: "funnels", href: "/admin/funnels", icon: "funnels" },
      { key: "events", href: "/admin/events", icon: "events" },
    ],
  },
  {
    labelKey: "groupPlatform",
    items: [
      { key: "campaigns", href: "/admin/campaigns", icon: "campaigns" },
      { key: "creators", href: "/admin/creators", icon: "creators" },
      { key: "brands", href: "/admin/brands", icon: "brands" },
    ],
  },
  {
    labelKey: "groupAdmin",
    items: [
      { key: "audit", href: "/admin/audit", icon: "audit" },
      { key: "system", href: "/admin/system", icon: "system" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
