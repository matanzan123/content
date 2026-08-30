import type { Metadata } from "next";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { LegalDocument } from "@/components/legal/LegalDocument";
import { accessibilitySectionsEn } from "@/content/legal/accessibility.en";
import { accessibilitySectionsHe } from "@/content/legal/accessibility.he";
import { LEGAL_LAST_UPDATED, formatLegalDate } from "@/lib/legal-config";
import { alternateLanguages } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: `${t.legal.accessibilityTitle} | ClipRewards`,
    description: t.legal.accessibilityMetaDescription,
    alternates: { languages: alternateLanguages("/accessibility") },
  };
}

/* ==========================================================================
   ACCESSIBILITY STATEMENT

   The document body lives in src/content/legal/accessibility.{en,he}.tsx —
   long-form prose does not belong in the flat dictionaries, and keeping one
   module per language keeps the page free of per-locale conditionals in JSX.
   Section ids are identical across languages so deep links survive a switch.
   ========================================================================== */

export default async function AccessibilityPage({ params }: Params) {
  const { locale, t } = await getI18n(params);
  const sections = locale === "he" ? accessibilitySectionsHe() : accessibilitySectionsEn();

  return (
    <>
      <Header role="creator" />
      <LegalDocument
        label={t.legal.accessibilityLabel}
        title={t.legal.accessibilityTitle}
        intro={t.legal.accessibilityIntro}
        lastUpdated={formatLegalDate(LEGAL_LAST_UPDATED, locale)}
        sections={sections}
      />
      <Footer role="creator" />
    </>
  );
}
