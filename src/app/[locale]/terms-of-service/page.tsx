import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { LegalDocument } from "@/components/legal/LegalDocument";
import { termsSectionsEn } from "@/content/legal/terms.en";
import { termsSectionsHe } from "@/content/legal/terms.he";
import { LEGAL_LAST_UPDATED, formatLegalDate } from "@/lib/legal-config";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: `${t.legal.termsTitle} | ClipRewards`,
    description: t.legal.termsMetaDescription,
    alternates: { languages: alternateLanguages("/terms-of-service") },
  };
}

/* ==========================================================================
   TERMS OF SERVICE

   The document body lives in src/content/legal/terms.{en,he}.tsx, and the note
   about what this contract deliberately leaves undefined stays with the English
   source there. The three parts are jump navigation, never tabs — every section
   stays on the page in both languages, because a user must not be able to
   accept terms they were never shown. Section ids match across languages so
   deep links survive a switch.
   ========================================================================== */

export default async function TermsOfServicePage({ params }: Params) {
  const { locale, t } = await getI18n(params);
  const sections = locale === "he" ? termsSectionsHe() : termsSectionsEn();

  const parts = [
    { key: "general", label: t.legal.parts.general, tocLabel: t.legal.partTocs.general },
    { key: "creators", label: t.legal.parts.creators, tocLabel: t.legal.partTocs.creators },
    { key: "brands", label: t.legal.parts.brands, tocLabel: t.legal.partTocs.brands },
  ];

  return (
    <>
      <Header role="creator" />
      <LegalDocument
        label={t.legal.label}
        title={t.legal.termsTitle}
        intro={t.legal.termsIntro}
        lastUpdated={formatLegalDate(LEGAL_LAST_UPDATED, locale)}
        sections={sections}
        partLabels={parts}
      />
      <Footer role="creator" />
    </>
  );
}
