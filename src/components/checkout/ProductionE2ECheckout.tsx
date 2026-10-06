"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const WhopCheckoutEmbed = dynamic(
  () => import("@whop/checkout/react").then((m) => m.WhopCheckoutEmbed),
  { ssr: false }
);

type Session = {
  order_id: string;
  checkout_id: string;
  amount_minor: number;
  currency: string;
  environment: "production";
};

type Phase =
  | { name: "idle" }
  | { name: "starting" }
  | { name: "ready"; session: Session }
  | { name: "submitted"; orderId: string }
  | { name: "error"; message: string };

const STORAGE_KEY = "cr-production-e2e-session";

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;

  const v = value as Record<string, unknown>;

  return (
    typeof v.order_id === "string" &&
    typeof v.checkout_id === "string" &&
    v.checkout_id.startsWith("ch_") &&
    v.amount_minor === 107 &&
    v.currency === "usd" &&
    v.environment === "production"
  );
}

export function ProductionE2ECheckout({
  locale,
}: {
  locale: "en" | "he";
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const inFlight = useRef(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed: unknown = JSON.parse(raw);

      if (isSession(parsed)) {
        setPhase({ name: "ready", session: parsed });
      }
    } catch {
      // Ignore unavailable or invalid session storage.
    }
  }, []);

  const begin = useCallback(async () => {
    if (inFlight.current) return;

    inFlight.current = true;
    setPhase({ name: "starting" });

    try {
      const response = await fetch("/api/admin/production-e2e-checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          confirm: "CREATE_PRODUCTION_E2E_107_CENTS",
        }),
      });

      const body: unknown = await response.json();

      if (!response.ok || !isSession(body)) {
        setPhase({
          name: "error",
          message: `Could not create checkout (${response.status}).`,
        });
        return;
      }

      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(body));
      setPhase({ name: "ready", session: body });
    } catch {
      setPhase({
        name: "error",
        message: "Could not create checkout.",
      });
    } finally {
      inFlight.current = false;
    }
  }, []);

  const isHebrew = locale === "he";

  return (
    <section
      dir={isHebrew ? "rtl" : "ltr"}
      className="mx-auto flex w-full max-w-xl flex-col gap-6 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <div className="flex flex-col gap-3">
        <span className="w-fit rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-900">
          Production E2E · REAL PAYMENT
        </span>

        <h1 className="text-2xl font-extrabold">
          {isHebrew ? "בדיקת תשלום אמיתי" : "Real payment test"}
        </h1>

        <p className="text-sm leading-relaxed text-neutral-600">
          {isHebrew
            ? "הבדיקה תחייב $1.07 USD בכרטיס אמיתי. אל תאשר את התשלום בתוך Whop עד שאתה מוכן לחיוב אמיתי."
            : "This test will charge $1.07 USD to a real card. Do not submit the Whop payment until you are ready for a real charge."}
        </p>
      </div>

      <div className="rounded-xl bg-neutral-50 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-500">
            {isHebrew ? "סכום" : "Amount"}
          </span>
          <strong>$1.07 USD</strong>
        </div>
      </div>

      {phase.name === "idle" && (
        <button
          type="button"
          onClick={begin}
          className="rounded-xl bg-neutral-900 px-5 py-3 font-bold text-white"
        >
          {isHebrew ? "צור Checkout של $1.07" : "Create $1.07 checkout"}
        </button>
      )}

      {phase.name === "starting" && (
        <p className="text-sm text-neutral-600">
          {isHebrew ? "יוצר Checkout..." : "Creating checkout..."}
        </p>
      )}

      {phase.name === "ready" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {isHebrew
              ? "מכאן זה Checkout אמיתי של Production. אישור התשלום בתוך Whop יחייב כסף אמיתי."
              : "This is now a real Production checkout. Submitting the Whop form will charge real money."}
          </div>

          <WhopCheckoutEmbed
            sessionId={phase.session.checkout_id}
            returnUrl={`${window.location.origin}/${locale}/checkout/production-e2e/complete?order_id=${encodeURIComponent(phase.session.order_id)}`}
            environment="production"
            theme="light"
            onComplete={() =>
              setPhase({
                name: "submitted",
                orderId: phase.session.order_id,
              })
            }
            onPaymentError={() =>
              setPhase({
                name: "error",
                message: "Whop reported a payment error.",
              })
            }
          />
        </div>
      )}

      {phase.name === "submitted" && (
        <div className="rounded-xl bg-neutral-50 px-4 py-4">
          <strong>
            {isHebrew
              ? "התשלום נשלח לאימות."
              : "Payment submitted for verification."}
          </strong>

          <p className="mt-2 text-sm text-neutral-600">
            Order: {phase.orderId}
          </p>
        </div>
      )}

      {phase.name === "error" && (
        <div className="rounded-xl bg-red-50 px-4 py-4 text-sm text-red-900">
          {phase.message}
        </div>
      )}
    </section>
  );
}
