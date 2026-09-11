import type { Metadata } from "next";
import { AuthGate } from "@/components/auth/AuthGate";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { LanguageSelector } from "@/components/LanguageSelector";
import { redirect } from "next/navigation";
import { alternateLanguages, localePath } from "@/i18n/config";
import { coerceLocale } from "@/i18n/server";
import { getAccessContext } from "@/lib/server/access";
import { STAGE_DESTINATIONS } from "@/lib/server/user-lifecycle";
import { getI18n } from "@/i18n/server";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.onboarding.metaTitle,
    description: t.meta.onboardingDescription,
    alternates: { languages: alternateLanguages("/onboarding") },
  };
}

/** The guard reads a session cookie, so this page cannot be static. */
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ params }: Params) {
  const { locale, t } = await getI18n(params);

  // SERVER-SIDE ROUTING. `AuthGate` below still renders the sign-in panel for
  // an unauthenticated visitor — that is UX — but it is no longer the only
  // thing deciding who sees what. A signed-in applicant who has already
  // finished onboarding is redirected onward to their real stage, so the
  // wizard is not a page anyone can sit on after they have outgrown it.
  //
  // An unauthenticated visitor is deliberately NOT redirected: sending them to
  // /login would bounce straight back here, since /login redirects to
  // /onboarding. They get the sign-in panel instead.
  const context = await getAccessContext();
  if (context.uid !== null && context.stage !== "onboarding_incomplete") {
    redirect(localePath(coerceLocale(locale), STAGE_DESTINATIONS[context.stage]));
  }

  return (
    <main id="main-content" className="flex-1 px-5 py-16 sm:py-24">
      <div className="mx-auto max-w-[1080px]">
        {/* These pages deliberately have no Header, but someone who lands here
            directly still has to be able to change language. */}
        <div className="mb-6 flex justify-end">
          <LanguageSelector fullNames />
        </div>
        <AuthGate title={t.onboarding.gateTitle} subtitle={t.onboarding.gateSubtitle}>
          <OnboardingWizard />
        </AuthGate>
      </div>
    </main>
  );
}
