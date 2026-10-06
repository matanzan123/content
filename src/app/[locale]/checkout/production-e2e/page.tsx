import { notFound } from "next/navigation";
import { ProductionE2ECheckout } from "@/components/checkout/ProductionE2ECheckout";
import { isLocale, type Locale } from "@/i18n/config";
import { getWhopEnvironment } from "@/lib/server/whop-payments";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ locale: string }>;
};

export default async function ProductionE2EPage({ params }: Params) {
  if (getWhopEnvironment() !== "production") notFound();

  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();

  const locale = raw as Locale;

  return (
    <main className="min-h-screen bg-[#faf8f5] px-4 py-16">
      <ProductionE2ECheckout locale={locale} />
    </main>
  );
}
