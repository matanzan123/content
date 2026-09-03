"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

/* ==========================================================================
   SANDBOX CHECKOUT — test surface, not product UI.

   THE EMBED IS MOUNTED BY SESSION, NEVER BY PLAN. `WhopCheckoutEmbed` accepts
   either `planId` OR `sessionId` — they are separate variants of its props
   union, not a pair. Mounting by plan bypasses the checkout configuration
   entirely, which is how the first attempt produced a payment whose metadata
   was `{}`: with no `order_id` on the payment, the webhook had nothing to map
   back to. `sessionId` is the configuration id the server created and stored,
   and it is what carries `metadata.order_id` through to the payment.

   The session id is never chosen here. It arrives from the server, read out of
   the order row; this component cannot invent or substitute one.

   DOUBLE-CLICK SAFETY: a ref set synchronously, because state updates land
   after the second click of a double-click has already been handled. The
   `disabled` attribute is the visible half of the same guard.

   REFRESH RECOVERY: the order id is kept in sessionStorage so a reload
   re-fetches the SAME order's session instead of starting a new one. It is a
   hint only — the server re-reads the order and would refuse an id that is
   paid, closed or unknown.
   ========================================================================== */

const WhopCheckoutEmbed = dynamic(
  () => import("@whop/checkout/react").then((m) => m.WhopCheckoutEmbed),
  { ssr: false, loading: () => <EmbedSkeleton /> },
);

type Copy = {
  badge: string;
  title: string;
  intro: string;
  amountLabel: string;
  start: string;
  starting: string;
  preparing: string;
  orderCreated: string;
  orderLabel: string;
  payHere: string;
  submitted: string;
  submittedBody: string;
  errorTitle: string;
  errorBody: string;
  errorBusy: string;
  paymentProblem: string;
  retry: string;
  notReal: string;
  recovering: string;
};

export type SandboxCheckoutProps = {
  copy: Copy;
  locale: "en" | "he";
  /** Formatted for display only. The charge is decided server-side. */
  amountDisplay: string;
  environment: "sandbox";
  dir: "ltr" | "rtl";
  /** Dev builds surface a sanitized provider code; production never does. */
  showDiagnostics: boolean;
};

/** Exactly the fields the server sends. Nothing here is provider-shaped. */
type Session = {
  order_id: string;
  session_id: string;
  environment: string;
  status: string;
  /** Server-generated. The browser cannot choose or replace it. */
  return_url: string;
  reused?: boolean;
};

type Phase =
  | { name: "idle" }
  | { name: "recovering" }
  | { name: "starting" }
  | { name: "ready"; session: Session }
  | { name: "submitted"; orderId: string }
  | { name: "error"; busy: boolean; code?: string };

const ORDER_KEY = "cr-sandbox-order";

/** Guards what we accept back from our own API before rendering a payment form. */
function isSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.order_id === "string" &&
    typeof v.session_id === "string" &&
    v.session_id.startsWith("ch_") &&
    typeof v.return_url === "string" &&
    v.return_url.startsWith("https://") &&
    v.environment === "sandbox"
  );
}

export function SandboxCheckout({
  copy,
  amountDisplay,
  environment,
  dir,
  locale,
  showDiagnostics,
}: SandboxCheckoutProps) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const inFlight = useRef(false);

  const remember = (orderId: string) => {
    try {
      sessionStorage.setItem(ORDER_KEY, orderId);
    } catch {
      // Private mode or blocked storage: recovery simply will not happen.
    }
  };

  /** Recovers the session for an order this tab already started. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let remembered: string | null = null;
      try {
        remembered = sessionStorage.getItem(ORDER_KEY);
      } catch {
        remembered = null;
      }
      if (!remembered) return;

      setPhase({ name: "recovering" });
      try {
        const response = await fetch(
          `/api/checkout/sandbox?order_id=${encodeURIComponent(remembered)}&locale=${locale}`,
          { headers: { accept: "application/json" } },
        );
        if (cancelled) return;
        if (!response.ok) return setPhase({ name: "idle" });
        const body: unknown = await response.json();
        if (isSession(body)) return setPhase({ name: "ready", session: body });
        // Paid or closed: nothing to render, and no new order is started.
        setPhase({ name: "idle" });
      } catch {
        if (!cancelled) setPhase({ name: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const begin = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ name: "starting" });

    try {
      // One call. The server reuses an untouched order and its checkout, so a
      // second press cannot produce a second order or a second configuration.
      const response = await fetch("/api/checkout/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", locale }),
      });
      if (!response.ok) {
        return setPhase({ name: "error", busy: response.status === 409 });
      }
      const body: unknown = await response.json();
      if (!isSession(body)) return setPhase({ name: "error", busy: false });

      remember(body.order_id);
      setPhase({ name: "ready", session: body });
    } catch {
      // A provider, database or network message is never shown.
      setPhase({ name: "error", busy: false });
    } finally {
      inFlight.current = false;
    }
  }, [locale]);

  /**
   * UX ONLY — all three callbacks below. They are browser events: unsigned,
   * unverified and trivially forgeable. None of them marks an order paid,
   * pending or failed, and none writes anything. The order advances only when
   * a signed webhook and a server-side provider lookup agree.
   */
  const onComplete = useCallback(() => {
    setPhase((current) =>
      current.name === "ready" ? { name: "submitted", orderId: current.session.order_id } : current,
    );
  }, []);

  const onPaymentError = useCallback(
    (error: { message: string; code?: string }) => {
      // Only the provider's own code is kept, and only in development. The
      // message can quote buyer input, so it is never rendered or logged.
      setPhase({ name: "error", busy: false, code: showDiagnostics ? error?.code : undefined });
    },
    [showDiagnostics],
  );

  const working = phase.name === "starting" || phase.name === "recovering";

  return (
    <section
      dir={dir}
      className="mx-auto flex w-full max-w-xl flex-col gap-6 rounded-2xl border border-neutral-200 bg-white/70 p-6 shadow-sm sm:p-8"
    >
      <div className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-[12px] font-bold uppercase tracking-wide text-amber-900">
          {copy.badge}
        </span>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{copy.title}</h1>
        <p className="text-[15px] leading-relaxed text-neutral-600">{copy.intro}</p>
      </div>

      <div className="flex items-baseline justify-between rounded-xl bg-neutral-50 px-4 py-3">
        <span className="text-[13px] font-semibold uppercase tracking-wide text-neutral-500">
          {copy.amountLabel}
        </span>
        <bdi className="admin-num text-xl font-extrabold tabular-nums">{amountDisplay}</bdi>
      </div>

      {(phase.name === "idle" || working) && (
        <button
          type="button"
          onClick={begin}
          disabled={working}
          aria-busy={working}
          className="flex items-center justify-center gap-3 rounded-xl bg-neutral-900 px-5 py-3 text-[15px] font-bold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
        >
          {working && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {phase.name === "recovering" ? copy.recovering
            : phase.name === "starting" ? copy.starting
            : copy.start}
        </button>
      )}

      {phase.name === "ready" && (
        <div className="flex flex-col gap-3">
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-[14px] text-emerald-900">
            {copy.orderCreated} <bdi className="admin-num">{phase.session.order_id}</bdi>
          </p>
          <p className="text-[15px] font-bold">{copy.payHere}</p>
          <div className="overflow-hidden rounded-xl border border-neutral-200">
            <WhopCheckoutEmbed
              /* The stored checkout configuration. Mounting by plan would drop
                 `metadata.order_id` and orphan the payment. */
              sessionId={phase.session.session_id}
              /* Explicit, not implied. Redirect-based payment methods need
                 somewhere to come back to, and the value is built on the
                 server from APP_PUBLIC_URL — never chosen here. */
              returnUrl={phase.session.return_url}
              /* NEVER omitted: the component defaults to PRODUCTION when
                 `environment` is absent. */
              environment={environment}
              theme="light"
              onComplete={onComplete}
              onPaymentError={onPaymentError}
            />
          </div>
          <p className="text-[12px] text-neutral-500">{copy.notReal}</p>
        </div>
      )}

      {phase.name === "submitted" && (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-4">
          <p className="text-[15px] font-bold">{copy.submitted}</p>
          <p className="mt-1 text-[14px] leading-relaxed text-neutral-600">{copy.submittedBody}</p>
          <p className="mt-2 text-[13px] text-neutral-500">
            {copy.orderLabel} <bdi className="admin-num">{phase.orderId}</bdi>
          </p>
        </div>
      )}

      {phase.name === "error" && (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-4">
          <p className="text-[15px] font-bold text-red-900">
            {phase.code ? copy.paymentProblem : copy.errorTitle}
          </p>
          <p className="text-[14px] leading-relaxed text-red-800">
            {phase.busy ? copy.errorBusy : copy.errorBody}
          </p>
          {phase.code && (
            <p className="text-[12px] text-red-700">
              <bdi className="admin-num">code: {phase.code}</bdi>
            </p>
          )}
          <button
            type="button"
            onClick={begin}
            className="w-fit rounded-lg bg-red-900 px-4 py-2 text-[14px] font-bold text-white"
          >
            {copy.retry}
          </button>
        </div>
      )}
    </section>
  );
}

function EmbedSkeleton() {
  return <div className="h-[420px] w-full animate-pulse bg-neutral-100" />;
}
