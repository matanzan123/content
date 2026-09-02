import "server-only";

import { getAdminCheck } from "@/lib/server/admin-guard";
import { isCompareKey, isRangeKey, type CompareKey, type RangeKey } from "@/lib/analytics/range";
import { getI18n } from "@/i18n/server";

/**
 * What every admin page needs: the verified identity, the dictionary, and the
 * reporting window parsed from the URL.
 *
 * The layout has already refused unauthorised callers, but this re-checks
 * anyway. A page that assumes an ancestor ran the guard is a page that becomes
 * unprotected the day someone moves it.
 */
export async function getAdminPageContext(
  params: Promise<{ locale: string }>,
  searchParams?: Promise<Record<string, string | string[] | undefined>>,
) {
  const { locale, t } = await getI18n(params);
  const check = await getAdminCheck();
  const search = (await searchParams) ?? {};

  const rawRange = typeof search.range === "string" ? search.range : undefined;
  const rawCompare = typeof search.compare === "string" ? search.compare : undefined;

  return {
    locale,
    t,
    admin: check.ok ? check.admin : null,
    authorized: check.ok,
    range: (isRangeKey(rawRange) ? rawRange : "30d") as RangeKey,
    compare: (isCompareKey(rawCompare) ? rawCompare : "none") as CompareKey,
    search,
  };
}
