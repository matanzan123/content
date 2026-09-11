import { requireStage } from "@/lib/server/page-guard";
import { getI18n } from "@/i18n/server";
import { resolveAvailabilityConfig } from "@/lib/server/interview-availability";
import { InterviewConfirmation } from "@/components/onboarding/InterviewConfirmation";
import { StageNotice } from "../StageNotice";

type Params = { params: Promise<{ locale: string }> };

/**
 * Server-guarded. Someone in a different stage is redirected to the page that
 * explains THEIR situation, so this URL cannot be used to peek at a state the
 * caller is not in.
 *
 * EVERYTHING SHOWN HERE IS A STORED FACT. The instant, the duration and the
 * meeting link come from the applicant's own booking row; the timezone is the
 * operator's configuration. Nothing is derived, assumed or padded out — where
 * a fact does not exist yet (a meeting link staff have not pasted), the page
 * says so rather than rendering a control that cannot work.
 */
export const dynamic = "force-dynamic";

export default async function Page({ params }: Params) {
  const { locale, t } = await getI18n(params);
  const context = await requireStage(locale, ["awaiting_review"]);
  const copy = t.approval.awaiting_review;
  const detail = t.approval.booked;
  const shared = t.approval.interview;
  const booking = context.booking;

  // The stage guard only proves the applicant is awaiting review. A row that
  // cannot be read is not a reason to invent a confirmation, so the plain
  // notice stands in — it states the situation without claiming a time.
  if (!booking) {
    return <StageNotice title={copy.title} body={copy.body} />;
  }

  /*
   * Times are shown in the zone the interview is actually held in, matching
   * the booking screen. If that configuration is unreadable the zone is simply
   * omitted rather than labelling a time with one we cannot vouch for.
   */
  const availability = resolveAvailabilityConfig();
  const timezone = availability.ok ? availability.config.timezone : null;
  const intlLocale = locale === "he" ? "he-IL" : "en-US";
  const at = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(intlLocale, timezone ? { ...options, timeZone: timezone } : options);

  const rows = [
    {
      label: detail.dateLabel,
      icon: "calendar" as const,
      value: at({ weekday: "long", month: "long", day: "numeric" }).format(booking.scheduledAt),
    },
    {
      label: detail.timeLabel,
      icon: "clock" as const,
      value: at({ hour: "numeric", minute: "2-digit" }).format(booking.scheduledAt),
    },
    {
      // The duration stored ON THE BOOKING, so a later configuration change
      // cannot retroactively resize an interview someone already agreed to.
      label: shared.durationLabel,
      icon: "timer" as const,
      value: shared.durationValue.replace("{minutes}", String(booking.durationMinutes)),
    },
    { label: shared.formatLabel, icon: "video" as const, value: shared.formatValue },
    ...(timezone
      ? [
          {
            label: shared.timezoneLabel,
            icon: "globe" as const,
            // An IANA zone is an identifier, so it stays LTR inside Hebrew.
            value: <span className="ltr-token">{timezone}</span>,
          },
        ]
      : []),
  ];

  return (
    <InterviewConfirmation
      eyebrow={detail.eyebrow}
      title={copy.title}
      body={copy.body}
      detailsTitle={detail.detailsTitle}
      rows={rows}
      meetingUrl={booking.meetingUrl}
      joinLabel={detail.join}
      linkPending={detail.linkPending}
      nextTitle={detail.nextTitle}
      steps={detail.steps}
    />
  );
}
