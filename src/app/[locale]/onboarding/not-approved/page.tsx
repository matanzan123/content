import { requireStage } from "@/lib/server/page-guard";
import { getI18n } from "@/i18n/server";
import { StageNotice } from "../StageNotice";

type Params = { params: Promise<{ locale: string }> };

/**
 * Server-guarded. Someone in a different stage is redirected to the page that
 * explains THEIR situation, so this URL cannot be used to peek at a state the
 * caller is not in.
 */
export const dynamic = "force-dynamic";

export default async function Page({ params }: Params) {
  const { locale, t } = await getI18n(params);
  const context = await requireStage(locale, ["rejected"]);
  const copy = t.approval.rejected;
  return (
    <StageNotice
      title={copy.title}
      body={copy.body}
      detail={
        context.booking
          ? t.approval.bookedFor.replace(
              "{when}",
              new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
                dateStyle: "full",
                timeStyle: "short",
              }).format(context.booking.scheduledAt),
            )
          : null
      }
    />
  );
}
