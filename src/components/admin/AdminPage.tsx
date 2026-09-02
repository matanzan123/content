import type { Metadata } from "next";
import { AdminTopBar } from "./AdminTopBar";
import { getAdminPageContext } from "@/lib/admin/context";
import { getAdminCheck } from "@/lib/server/admin-guard";
import { ADMIN_TIMEZONE } from "@/lib/analytics/range";
import { getI18n } from "@/i18n/server";
import type { Dictionary } from "@/i18n/dictionaries/en";
import type { CompareKey, RangeKey } from "@/lib/analytics/range";

/* ==========================================================================
   ADMIN PAGE SCAFFOLD

   Thirteen sections share the same frame: guarded context, a top bar, a main
   landmark. Building it once means a new section is a body function, and it
   cannot ship without the guard or without a title.
   ========================================================================== */

export type AdminPageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export type AdminBodyProps = {
  t: Dictionary["admin"];
  locale: "en" | "he";
  range: RangeKey;
  compare: CompareKey;
  search: Record<string, string | string[] | undefined>;
};

/**
 * Every admin page is noindex — hygiene layered on top of the guard.
 *
 * The title is also authorized. `generateMetadata` runs before the page body
 * and is not covered by the layout's refusal, so without this check an
 * unauthorised visitor would still receive "Revenue · ClipRewards Admin" in a
 * <title> tag. That is not a breach, but a refused response should not
 * enumerate the sections behind it.
 */
export function adminMetadata(
  titleKey: keyof Dictionary["admin"]["nav"],
): (args: { params: Promise<{ locale: string }> }) => Promise<Metadata> {
  return async ({ params }) => {
    const { t } = await getI18n(params);
    const robots = { index: false, follow: false, nocache: true } as const;
    const check = await getAdminCheck();
    if (!check.ok) return { title: t.admin.deniedTitle, robots };
    return { title: `${t.admin.nav[titleKey]} · ${t.admin.title}`, robots };
  };
}

export async function AdminPage({
  params,
  searchParams,
  titleKey,
  showRange = true,
  body: Body,
}: AdminPageProps & {
  titleKey: keyof Dictionary["admin"]["nav"];
  showRange?: boolean;
  body: (props: AdminBodyProps) => Promise<React.ReactElement> | React.ReactElement;
}) {
  const ctx = await getAdminPageContext(params, searchParams);
  // The layout already refused unauthorised callers; this is the second lock,
  // so moving a page out of the subtree cannot silently unprotect it.
  if (!ctx.authorized) return null;

  return (
    <>
      <AdminTopBar
        t={ctx.t.admin}
        title={ctx.t.admin.nav[titleKey]}
        email={ctx.admin?.email ?? null}
        timezone={ADMIN_TIMEZONE}
        showRange={showRange}
      />
      <main id="main-content" className="flex-1 px-4 py-5 sm:px-6">
        <Body
          t={ctx.t.admin}
          locale={ctx.locale}
          range={ctx.range}
          compare={ctx.compare}
          search={ctx.search}
        />
      </main>
    </>
  );
}
