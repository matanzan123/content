import { AdminPage, adminMetadata, type AdminPageProps } from "@/components/admin/AdminPage";
import { FunnelsBody } from "@/components/admin/sections/AnalyticsSections";

export const generateMetadata = adminMetadata("funnels");

/** Authorization runs in the admin layout and again in AdminPage. */
export const dynamic = "force-dynamic";

export default function Page(props: AdminPageProps) {
  return <AdminPage {...props} titleKey="funnels" showRange={true} body={FunnelsBody} />;
}
