import type { Metadata } from "next";
import { requireApprovedPage } from "@/lib/server/page-guard";
import { getI18n } from "@/i18n/server";
import { alternateLanguages } from "@/i18n/config";
import { WhopConnectionCard } from "@/components/dashboard/WhopConnectionCard";
import { WhopVerificationCard } from "@/components/dashboard/WhopVerificationCard";
import { WhopPayoutStatusCard } from "@/components/dashboard/WhopPayoutStatusCard";
import { CreatorEarningsCard } from "@/components/dashboard/CreatorEarningsCard";
import { CreatorWithdrawCard } from "@/components/dashboard/CreatorWithdrawCard";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { t } = await getI18n(params);
  return {
    title: t.dashboard.metaTitle,
    robots: { index: false, follow: false },
    alternates: { languages: alternateLanguages("/dashboard") },
  };
}

/**
 * The approved creator's home.
 *
 * AUTHORIZATION IS THE EXISTING ONE. `requireApprovedPage` resolves the same
 * `getAccessContext` every other guarded page and API route uses, and
 * redirects anyone who is not approved to the page for their actual stage —
 * an applicant to onboarding, a pending one to the waiting page, a signed-out
 * visitor to sign-in. No second auth system is introduced and nothing is
 * decided in the browser.
 *
 * WHOP CONNECTION IS NARROWER THAN THE PAGE, and is decided by the PRODUCT
 * ROLE. `mayConnectWhop` is computed from `users.role` and
 * `users.approval_status`, so an approved creator who also holds the Firebase
 * `admin` claim keeps the connection they earned, while an administrator with
 * no approved role — who has no Whop account of their own to link — does not
 * get one. The card renders on exactly the predicate `requireWhopEligible`
 * enforces, so the UI cannot offer an action the server would reject.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage({ params, searchParams }: Params) {
  const { locale, t } = await getI18n(params);
  const context = await requireApprovedPage(locale);
  const search = await searchParams;

  // The callback's outcome word. Read for a MESSAGE only — the connection
  // state itself is fetched from the API, never inferred from a query string.
  const raw = search.whop;
  const notice = typeof raw === "string" && raw.length <= 32 ? raw : null;

  // When the creator returns from Whop's hosted KYC flow, the query param
  // triggers a fresh status read. It is NEVER treated as proof of completion.
  const kycReturn = search.step === "kyc_return";
  const payoutReturn = search.step === "payout_return";

  return (
    <main id="main-content" className="flex-1 px-5 py-14 sm:py-16">
      <div className="mx-auto max-w-[720px]">
        <p className="text-[12px] font-bold uppercase tracking-[0.1em] text-ink-soft">
          {context.user?.role === "brand" ? t.dashboard.eyebrowBrand : t.dashboard.eyebrowCreator}
        </p>
        <h1 className="mt-2.5 font-[var(--font-display)] text-[30px] font-extrabold leading-tight tracking-tight text-ink sm:text-[34px]">
          {t.dashboard.title}
        </h1>
        <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-ink-soft">
          {t.dashboard.subtitle}
        </p>

        <div className="mt-9 space-y-5">
          {context.mayConnectWhop ? (
            <>
              <WhopConnectionCard locale={locale} notice={notice} />
              <WhopVerificationCard kycReturn={kycReturn} />
              <WhopPayoutStatusCard payoutReturn={payoutReturn} />
              <CreatorEarningsCard />
              <CreatorWithdrawCard />
            </>
          ) : (
            /* An administrator reaching this page: approved, but with no Whop
               account of their own. Saying so beats a button that 403s. */
            <p className="rounded-[var(--radius-token-lg)] border border-line bg-surface px-6 py-5 text-[14px] leading-relaxed text-ink-soft shadow-[var(--shadow-card)]">
              {t.dashboard.whop.adminNotice}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
