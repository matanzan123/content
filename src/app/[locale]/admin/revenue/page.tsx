import { AdminPage, adminMetadata, type AdminPageProps } from "@/components/admin/AdminPage";
import { RevenueBody } from "@/components/admin/sections/BusinessSections";

export const generateMetadata = adminMetadata("revenue");

/** Authorization runs in the admin layout and again in AdminPage. */
export const dynamic = "force-dynamic";

export default function Page(props: AdminPageProps) {
  return <AdminPage {...props} titleKey="revenue" showRange={true} body={RevenueBody} />;
}
