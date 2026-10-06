import { notFound } from "next/navigation";
import { isLocale, LOCALE_DIRECTION, type Locale } from "@/i18n/config";
import { getPaymentOrder, isOrderId } from "@/lib/server/payment-orders";
import { getWhopEnvironment } from "@/lib/server/whop-payments";

export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProductionE2ECompletePage({
  params,
  searchParams,
}: Params) {
  if (getWhopEnvironment() !== "production") notFound();

  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;

  const query = await searchParams;
  const orderId =
    typeof query.order_id === "string" ? query.order_id : null;

  const order =
    orderId && isOrderId(orderId)
      ? await getPaymentOrder(orderId)
      : null;

  const validE2EOrder =
    order &&
    order.environment === "production" &&
    order.purpose === "production_e2e_test" &&
    order.amountMinor === BigInt(107) &&
    order.currency === "usd";

  if (!validE2EOrder) notFound();

  const isPaid = order.status === "paid";
  const isFailed = order.status === "failed";

  const headline = isPaid
    ? "התשלום אומת"
    : isFailed
      ? "התשלום לא הושלם"
      : "התשלום נשלח — ממתינים לאימות";

  const body = isPaid
    ? "Whop אישרה את התשלום וההזמנה עודכנה במערכת."
    : isFailed
      ? "ההזמנה מסומנת ככושלת."
      : "המערכת עדיין ממתינה לאימות מצד Whop. אין להסתמך על החזרה לדפדפן כהוכחת תשלום.";

  return (
    <main
      dir={LOCALE_DIRECTION[locale]}
      className="min-h-screen bg-[#faf8f5] px-4 py-16"
    >
      <section className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-neutral-200 bg-white/70 p-6 shadow-sm sm:p-8">
        <span className="inline-flex w-fit items-center rounded-full bg-red-100 px-3 py-1 text-[12px] font-bold uppercase tracking-wide text-red-900">
          Production E2E · real payment
        </span>

        <h1 className="text-2xl font-extrabold tracking-tight">
          {headline}
        </h1>

        <p className="text-[15px] leading-relaxed text-neutral-600">
          {body}
        </p>

        <dl className="flex flex-col gap-2 rounded-xl bg-neutral-50 px-4 py-3 text-[14px]">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-neutral-500">Order</dt>
            <dd>
              <bdi className="admin-num">{order.orderId}</bdi>
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-neutral-500">Status</dt>
            <dd>
              <bdi className="admin-num font-semibold">{order.status}</bdi>
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-neutral-500">Amount</dt>
            <dd>$1.07 USD</dd>
          </div>
        </dl>

        <a
          href={`/${locale}/checkout/production-e2e`}
          className="w-fit rounded-lg bg-neutral-900 px-4 py-2 text-[14px] font-bold text-white"
        >
          חזרה לבדיקת התשלום
        </a>
      </section>
    </main>
  );
}
