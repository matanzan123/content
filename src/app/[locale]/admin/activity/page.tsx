import { AdminPage, adminMetadata, type AdminPageProps } from "@/components/admin/AdminPage";
import { ActivityBody } from "@/components/admin/sections/AnalyticsSections";

export const generateMetadata = adminMetadata("activity");

/** Authorization runs in the admin layout and again in AdminPage. */
export const dynamic = "force-dynamic";

export default function Page(props: AdminPageProps) {
  return <AdminPage {...props} titleKey="activity" showRange={false} body={ActivityBody} />;
}
