"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/* ==========================================================================
   RETRY CALENDAR PROVISIONING for one booking.

   THE CLIENT DECIDES NOTHING. It posts a booking id to an admin-only route
   which re-runs the same provisioning path the booking flow uses — the one
   that reconciles an existing event instead of creating a second. Whatever
   comes back is re-read from the server rather than patched in locally.
   ========================================================================== */

export function CalendarRetry({
  bookingId,
  label,
  busyLabel,
  doneLabel,
  failedLabel,
}: {
  bookingId: string;
  label: string;
  busyLabel: string;
  doneLabel: string;
  failedLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function retry() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/admin/interviews/${bookingId}/calendar/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json().catch(() => null)) as { status?: string } | null;
      if (response.ok && body?.status === "ready") {
        setNote({ ok: true, text: doneLabel });
        startTransition(() => router.refresh());
      } else {
        setNote({ ok: false, text: failedLabel });
      }
    } catch {
      setNote({ ok: false, text: failedLabel });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={retry}
        disabled={busy || pending}
        aria-busy={busy}
        className="rounded-md border border-[color:var(--a-border-strong)] px-2 py-0.5 text-[11px] font-bold text-[color:var(--a-text-muted)] transition-colors hover:border-[color:var(--a-accent)] hover:text-[color:var(--a-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? busyLabel : label}
      </button>
      {note && (
        <span
          className={
            note.ok
              ? "text-[10.5px] font-semibold text-[color:var(--a-positive)]"
              : "text-[10.5px] font-semibold text-[color:var(--a-negative)]"
          }
        >
          {note.text}
        </span>
      )}
    </span>
  );
}
