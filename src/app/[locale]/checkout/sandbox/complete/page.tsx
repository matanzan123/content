import { notFound } from "next/navigation";
import { isLocale, LOCALE_DIRECTION, type Locale } from "@/i18n/config";
import { getPaymentOrder, isOrderId } from "@/lib/server/payment-orders";
import { isSandboxOrderingEnabled } from "@/lib/server/sandbox-orders";

/* ==========================================================================
   CHECKOUT RETURN PAGE

   Where Whop sends the buyer back after a redirect-based payment method.

   THE QUERY STRING IS NOT EVIDENCE. `?status=success` is something anyone can
   type, so it is used for one thing only: choosing between "we are verifying"
   and "that did not go through" as the sentence to show. It never marks an
   order paid, never writes `financial_ledger`, and never claims funds were
   received.

   The status shown comes from OUR database, which only a verified webhook plus
   a server-side provider lookup can move to `paid`. Until they do, this page
   says the payment is being verified — which is the truth.
   ========================================================================== */

export const dynamic = "force-dynamic";

const COPY = {
  en: {
    verifying: "Payment submitted. Verifying payment…",
    verifyingBody:
      "Whop has taken the payment details. ClipRewards confirms a payment only from Whop's signed webhook and a server-side lookup, so this page will not say 'paid' until both agree.",
    paid: "Payment verified",
    paidBody:
      "The provider payment matched this order exactly — company, amount, currency and status. No ledger entry was written: that is a later step.",
    failed: "The payment did not go through",
    failedBody: "Nothing was charged. You can start another test order.",
    unknown: "Nothing to show for this order",
    orderLabel: "Order",
    statusLabel: "Order status",
    sandbox: "Sandbox · test payment",
    back: "Back to the test checkout",
  },
  he: {
    verifying: "התשלום נשלח. מאמתים את התשלום…",
    verifyingBody:
      "Whop קיבלה את פרטי התשלום. ClipRewards מאשרת תשלום רק מתוך webhook חתום של Whop ובדיקה בצד השרת, ולכן העמוד הזה לא יגיד ״שולם״ עד ששניהם יסכימו.",
    paid: "התשלום אומת",
    paidBody:
      "התשלום אצל הספק תאם להזמנה בדיוק — חברה, סכום, מטבע וסטטוס. לא נרשמה שורה בספר החשבונות: זה שלב מאוחר יותר.",
    failed: "התשלום לא עבר",
    failedBody: "לא בוצע חיוב. אפשר להתחיל הזמנת בדיקה נוספת.",
    unknown: "אין מה להציג עבור ההזמנה הזו",
    orderLabel: "הזמנה",
    statusLabel: "סטטוס ההזמנה",
    sandbox: "סנדבוקס · תשלום בדיקה",
    back: "חזרה לעמוד הבדיקה",
  },
} as const;

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SandboxCheckoutCompletePage({ params, searchParams }: Params) {
  if (!isSandboxOrderingEnabled()) notFound();

  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;
  const copy = COPY[locale];

  const query = await searchParams;
  const orderId = typeof query.order_id === "string" ? query.order_id : null;

  // The database, not the query string.
  const order = orderId && isOrderId(orderId) ? await getPaymentOrder(orderId) : null;

  const headline =
    order === null ? copy.unknown
    : order.status === "paid" ? copy.paid
    : order.status === "failed" ? copy.failed
    : copy.verifying;

  const body =
    order === null ? ""
    : order.status === "paid" ? copy.paidBody
    : order.status === "failed" ? copy.failedBody
    : copy.verifyingBody;

  return (
    <main dir={LOCALE_DIRECTION[locale]} className="min-h-screen bg-[#faf8f5] px-4 py-16">
      <section className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-neutral-200 bg-white/70 p-6 shadow-sm sm:p-8">
        <span className="inline-flex w-fit items-center rounded-full bg-amber-100 px-3 py-1 text-[12px] font-bold uppercase tracking-wide text-amber-900">
          {copy.sandbox}
        </span>

        <h1 className="text-2xl font-extrabold tracking-tight">{headline}</h1>
        {body && <p className="text-[15px] leading-relaxed text-neutral-600">{body}</p>}

        {order && (
          <dl className="flex flex-col gap-2 rounded-xl bg-neutral-50 px-4 py-3 text-[14px]">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-neutral-500">{copy.orderLabel}</dt>
              {/* Isolated: a uuid must not reorder inside an RTL line. */}
              <dd><bdi className="admin-num">{order.orderId}</bdi></dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-neutral-500">{copy.statusLabel}</dt>
              <dd><bdi className="admin-num font-semibold">{order.status}</bdi></dd>
            </div>
          </dl>
        )}

        <a
          href={`/${locale}/checkout/sandbox`}
          className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-[14px] font-bold text-white"
        >
          {copy.back}
        </a>
      </section>
    </main>
  );
}
