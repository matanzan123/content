import { redirect } from "next/navigation";
import { AccessDenied } from "@/components/admin/AccessDenied";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { getAdminCheck } from "@/lib/server/admin-guard";
import { localePath } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

/**
 * THE GUARD FOR THE ENTIRE ADMIN SUBTREE.
 *
 * Running it in the layout means every page under /admin is protected by
 * construction — a new section cannot be added and accidentally ship
 * unguarded. An unauthorised visitor never receives admin markup: the layout
 * returns a refusal instead of rendering `children` at all.
 *
 * This is not the only line of defence. Every admin API route runs its own
 * `withAdminApi`, because route handlers are reachable directly and are not
 * covered by any layout.
 *
 * Authorization is independent of locale — the same check decides for /en and
 * /he, and the language only chooses the words used to explain a refusal.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
  params,
}: Params & { children: React.ReactNode }) {
  const { locale, t } = await getI18n(params);
  const check = await getAdminCheck();

  if (!check.ok) {
    if (check.reason === "unauthenticated") redirect(localePath(locale, "/login"));
    const unconfigured = check.reason === "unconfigured";
    return (
      <div className="admin-root flex min-h-screen flex-col">
        <AccessDenied
          locale={locale}
          title={unconfigured ? t.admin.unconfiguredTitle : t.admin.deniedTitle}
          body={unconfigured ? t.admin.unconfiguredBody : t.admin.deniedBody}
          homeLabel={t.admin.deniedHome}
        />
      </div>
    );
  }

  return (
    <div className="admin-root flex min-h-screen">
      <AdminSidebar t={t.admin} />
      <div className="flex min-w-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}
