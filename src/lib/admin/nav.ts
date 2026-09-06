import type { Dictionary } from "@/i18n/dictionaries/en";

export type NavKey = keyof Dictionary["admin"]["nav"];

export type NavItem = { key: NavKey; href: string; icon: IconName };
export type NavGroup = { labelKey: "groupBusiness" | null; items: NavItem[] };

export type IconName = "overview" | "users" | "campaigns" | "revenue";

export const NAV_GROUPS: NavGroup[] = [
  { labelKey: null, items: [{ key: "overview", href: "/admin", icon: "overview" }] },
  {
    labelKey: "groupBusiness",
    items: [
      { key: "users", href: "/admin/users", icon: "users" },
      { key: "campaigns", href: "/admin/campaigns", icon: "campaigns" },
      { key: "revenue", href: "/admin/revenue", icon: "revenue" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
