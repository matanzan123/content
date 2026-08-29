import type { Metadata } from "next";
import { FAQsExperience } from "@/components/FAQsExperience";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.faqs.metaTitle,
    description: t.meta.faqsDescription,
    alternates: { languages: alternateLanguages("/faqs") },
  };
}

export default function FAQsPage() {
  return <FAQsExperience />;
}
