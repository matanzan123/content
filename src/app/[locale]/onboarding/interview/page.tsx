import { requireStage } from "@/lib/server/page-guard";
import { getI18n } from "@/i18n/server";
import { listAvailableSlots } from "@/lib/server/interview-availability";
import { StageNotice } from "../StageNotice";
import { InterviewBooking } from "@/components/onboarding/InterviewBooking";

type Params = { params: Promise<{ locale: string }> };

/**
 * Server-guarded booking page.
 *
 * Only an applicant who has finished onboarding and has no live booking sees
 * this; everyone else is redirected to the page for their own stage.
 *
 * FAILS SAFE WHEN AVAILABILITY IS UNCONFIGURED. ClipRewards has no operating
 * hours configured yet, so rather than showing an empty calendar or inventing
 * a schedule, the page says booking is not open. The exact settings an
 * operator must supply are listed in `interview-availability.ts`.
 */
export const dynamic = "force-dynamic";

export default async function Page({ params }: Params) {
  const { locale, t } = await getI18n(params);
  await requireStage(locale, ["interview_required"]);

  const listing = listAvailableSlots(new Date());
  if (!listing.ok) {
    return (
      <StageNotice
        title={t.approval.interview.title}
        body={t.approval.interview.unavailable}
      />
    );
  }

  return (
    <main id="main-content" className="flex-1 px-5 py-14 sm:py-20">
      <div className="mx-auto max-w-[980px]">
        <div className="mx-auto max-w-[620px] text-center">
          <span className="inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-accent-soft px-3.5 py-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-accent-ink">
            {t.approval.interview.eyebrow}
          </span>
          <h1 className="mt-5 font-[var(--font-display)] text-[30px] font-extrabold leading-tight tracking-tight text-ink sm:text-[34px]">
            {t.approval.interview.title}
          </h1>
          <p className="mx-auto mt-3.5 max-w-[520px] text-[15px] leading-relaxed text-ink-soft">
            {t.approval.interview.body}
          </p>
        </div>

        <InterviewBooking
          slots={listing.slots}
          timezone={listing.timezone}
          locale={locale}
          /* The operator's real configured slot length, not a guess. */
          durationMinutes={listing.slotMinutes}
        />
      </div>
    </main>
  );
}
