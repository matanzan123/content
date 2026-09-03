import { notFound } from "next/navigation";
import { SandboxCheckout } from "@/components/checkout/SandboxCheckout";
import { isLocale, LOCALE_DIRECTION, type Locale } from "@/i18n/config";
import {
  isSandboxOrderingEnabled,
  SANDBOX_TEST_AMOUNT_MINOR,
  SANDBOX_TEST_CURRENCY,
} from "@/lib/server/sandbox-orders";

/* ==========================================================================
   SANDBOX CHECKOUT TEST PAGE

   Integration testing infrastructure. It exists only while the configured
   Whop environment is `sandbox`, and 404s otherwise — the gate runs before
   anything renders, so production cannot even learn the route's shape.

   Deliberately NOT linked from any navigation. It is reached by typing the
   URL, which is the right amount of discoverability for a page that mounts a
   payment form.

   Copy lives here rather than in the shared dictionaries: this is not product
   text, and it should not appear in the translation surface a real page draws
   from. Both locales are complete, and Hebrew renders RTL through the root
   layout's `dir`.
   ========================================================================== */

export const dynamic = "force-dynamic";

const COPY = {
  en: {
    badge: "Sandbox · test payment",
    title: "Whop sandbox checkout",
    intro:
      "This page charges a Whop sandbox test card. No real money moves, and nothing here is part of the ClipRewards product.",
    amountLabel: "Test amount",
    start: "Create test order",
    starting: "Creating a test order…",
    preparing: "Preparing the payment form…",
    recovering: "Restoring your test order…",
    paymentProblem: "The payment did not go through",
    orderCreated: "Test order created:",
    orderLabel: "Order",
    payHere: "Pay with a Whop test card below",
    submitted: "Payment submitted. Verifying…",
    submittedBody:
      "The browser has finished, which is not the same as the payment being confirmed. ClipRewards records it only once Whop's signed webhook and a server-side lookup agree.",
    errorTitle: "Could not start the checkout",
    errorBody: "Nothing was charged. Try again, or check the server log for the reason.",
    errorBusy: "This order is already closed. Start a new test order instead.",
    retry: "Try again",
    notReal: "Sandbox only — use a Whop test card. A real card will be declined.",
  },
  he: {
    badge: "סנדבוקס · תשלום בדיקה",
    title: "תשלום בסביבת הבדיקה של Whop",
    intro:
      "העמוד הזה מחייב כרטיס בדיקה של Whop. לא עובר כסף אמיתי, ושום דבר כאן אינו חלק ממוצר ClipRewards.",
    amountLabel: "סכום הבדיקה",
    start: "יצירת הזמנת בדיקה",
    starting: "יוצר הזמנת בדיקה…",
    preparing: "מכין את טופס התשלום…",
    recovering: "משחזר את הזמנת הבדיקה…",
    paymentProblem: "התשלום לא עבר",
    orderCreated: "נוצרה הזמנת בדיקה:",
    orderLabel: "הזמנה",
    payHere: "לתשלום עם כרטיס בדיקה של Whop למטה",
    submitted: "התשלום נשלח. מאמתים…",
    submittedBody:
      "הדפדפן סיים, וזה לא אותו דבר כמו תשלום מאושר. ClipRewards תרשום אותו רק אחרי ש-webhook חתום מ-Whop ובדיקה בצד השרת יסכימו ביניהם.",
    errorTitle: "לא הצלחנו להתחיל את התשלום",
    errorBody: "לא בוצע חיוב. אפשר לנסות שוב, או לבדוק את הלוג בצד השרת.",
    errorBusy: "ההזמנה הזו כבר סגורה. אפשר להתחיל הזמנת בדיקה חדשה.",
    retry: "נסה שוב",
    notReal: "סנדבוקס בלבד — יש להשתמש בכרטיס בדיקה של Whop. כרטיס אמיתי יידחה.",
  },
} as const;

type Params = { params: Promise<{ locale: string }> };

export default async function SandboxCheckoutPage({ params }: Params) {
  // The environment gate, before anything else.
  if (!isSandboxOrderingEnabled()) notFound();

  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale = raw as Locale;

  const amountDisplay = new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
    style: "currency",
    currency: SANDBOX_TEST_CURRENCY.toUpperCase(),
  }).format(Number(SANDBOX_TEST_AMOUNT_MINOR) / 100);

  return (
    <main className="min-h-screen bg-[#faf8f5] px-4 py-16">
      <SandboxCheckout
        copy={COPY[locale]}
        amountDisplay={amountDisplay}
        environment="sandbox"
        locale={locale}
        showDiagnostics={process.env.NODE_ENV !== "production"}
        dir={LOCALE_DIRECTION[locale]}
      />
    </main>
  );
}
