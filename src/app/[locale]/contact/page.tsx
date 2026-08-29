import type { Metadata } from "next";
import { ContactExperience } from "@/components/ContactExperience";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.contact.metaTitle,
    description: t.contact.metaDescription,
    alternates: { languages: alternateLanguages("/contact") },
  };
}

export default function ContactPage() {
  return <ContactExperience />;
}
