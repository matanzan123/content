"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/* ==========================================================================
   REPAIR ACTIONS on the admin finance dashboard.

   The three repair endpoints existed and were reachable only with a terminal.
   The dashboard listed their URLs as prose — method, path, a sentence — and gave
   an operator no way to run one. This is that missing half, and it is written to
   the same rules the endpoints themselves enforce.

   DRY RUN IS THE DEFAULT, AND IT IS THE DEFAULT HERE TOO. The routes treat a
   missing `dry_run` as true; this component sends `dry_run: true` explicitly and
   makes a live run a separate, deliberate act. Two independent defaults pointing
   the same way is not redundancy — it is what stops one of them being quietly
   inverted.

   A LIVE RUN IS CONFIRMED. It posts real accounting corrections, so it asks
   first. The confirmation names the endpoint, because "are you sure?" tells an
   operator nothing about what they are about to change.

   THE HTTP STATUS IS THE TRUTH. A 401, 403, 409 or 429 is reported as the
   failure it is, with its status and the server's own error name. Collapsing
   every non-success into one "failed" label is how a rate-limited repair comes
   to look like a completed one, and how an operator retries something that
   already half-ran.

   NOTHING IS PATCHED IN LOCALLY. A run that changed anything calls
   `router.refresh()`, so every figure on the page is re-read from the server
   rather than adjusted in the browser's copy.
   ========================================================================== */

export type RepairTarget = {
  /** Stable id, used for React keys and for the busy flag. */
  id: string;
  label: string;
  body: string;
  endpoint: string;
};

type Outcome = {
  ok: boolean;
  /** The HTTP status actually returned. Zero when the request never completed. */
  status: number;
  /** Whether the run that produced this was a dry run. */
  dryRun: boolean;
  text: string;
};

export function RepairActions({
  targets,
  copy,
}: {
  targets: RepairTarget[];
  copy: {
    dryRun: string;
    live: string;
    running: string;
    confirmLive: string;
    examined: string;
    wouldChange: string;
    changed: string;
    failed: string;
    dryRunBadge: string;
    liveBadge: string;
    endpointLabel: string;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /** Which target is mid-flight. One at a time, so a run cannot overlap itself. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  async function run(target: RepairTarget, dryRun: boolean) {
    /* ONE RUN AT A TIME, ACROSS EVERY BUTTON. Guarding per-button would still
     * let an operator start a live fee repair while a live refund repair was in
     * flight, and both post accounting corrections. */
    if (busyId !== null || pending) return;

    if (!dryRun && !window.confirm(`${copy.confirmLive}\n\n${target.endpoint}`)) return;

    setBusyId(target.id);
    setOutcomes((prev) => {
      const next = { ...prev };
      delete next[target.id];
      return next;
    });

    try {
      const response = await fetch(target.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // EXPLICIT, both ways. The route defaults to a dry run; saying so here
        // means the two cannot disagree about which happened.
        body: JSON.stringify({ dry_run: dryRun }),
      });

      const body = (await response.json().catch(() => null)) as {
        error?: string;
        dry_run?: boolean;
        examined?: number;
        outcomes?: unknown[];
      } | null;

      if (!response.ok) {
        /* THE STATUS AND THE SERVER'S OWN NAME FOR THE FAULT. `rate_limited` at
         * 429 and `forbidden` at 403 are different problems with different
         * responses, and an operator needs to see which they have. */
        setOutcomes((prev) => ({
          ...prev,
          [target.id]: {
            ok: false,
            status: response.status,
            dryRun,
            text: `${copy.failed} — ${response.status}${body?.error ? ` ${body.error}` : ""}`,
          },
        }));
        return;
      }

      /* A 200 CARRYING AN ERROR IS STILL AN ERROR. The admin wrapper serialises
       * an in-handler refusal as a 200 with `{ error }`, so `response.ok` alone
       * would read those as successes. */
      if (body?.error) {
        setOutcomes((prev) => ({
          ...prev,
          [target.id]: {
            ok: false,
            status: response.status,
            dryRun,
            text: `${copy.failed} — ${body.error}`,
          },
        }));
        return;
      }

      /* THE SERVER SAYS WHICH MODE RAN, not this component. If they ever
       * disagree, the server's answer is the one displayed — a dry run that
       * reported itself as live would be the more dangerous confusion. */
      const serverDryRun = body?.dry_run ?? dryRun;
      const examined = typeof body?.examined === "number" ? body.examined : 0;
      const changed = Array.isArray(body?.outcomes) ? body.outcomes.length : 0;

      setOutcomes((prev) => ({
        ...prev,
        [target.id]: {
          ok: true,
          status: response.status,
          dryRun: serverDryRun,
          text: `${serverDryRun ? copy.dryRunBadge : copy.liveBadge} · ${copy.examined} ${examined} · ${
            serverDryRun ? copy.wouldChange : copy.changed
          } ${changed}`,
        },
      }));

      // Only a live run can have changed anything worth re-reading.
      if (!serverDryRun) startTransition(() => router.refresh());
    } catch {
      setOutcomes((prev) => ({
        ...prev,
        [target.id]: { ok: false, status: 0, dryRun, text: `${copy.failed} — network` },
      }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {targets.map((target) => {
        const outcome = outcomes[target.id];
        const busy = busyId === target.id;
        const blocked = busyId !== null || pending;

        return (
          <div
            key={target.id}
            className="rounded-lg border border-[color:var(--a-border)] bg-[color:var(--a-panel-raised)] p-3"
          >
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-semibold">{target.label}</p>
                <p className="mt-0.5 text-[11.5px] text-[color:var(--a-text-muted)]">{target.body}</p>
                <p className="mt-1 font-mono text-[10.5px] text-[color:var(--a-text-dim)]">
                  <span className="me-1 font-bold">{copy.endpointLabel}</span>
                  {target.endpoint}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => run(target, true)}
                  disabled={blocked}
                  aria-busy={busy}
                  className="rounded-md border border-[color:var(--a-border-strong)] px-2 py-1 text-[11px] font-bold text-[color:var(--a-text-muted)] transition-colors hover:border-[color:var(--a-accent)] hover:text-[color:var(--a-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? copy.running : copy.dryRun}
                </button>
                <button
                  type="button"
                  onClick={() => run(target, false)}
                  disabled={blocked}
                  aria-busy={busy}
                  className="rounded-md px-2 py-1 text-[11px] font-bold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    background: "color-mix(in srgb, var(--a-negative) 16%, transparent)",
                    color: "var(--a-negative)",
                  }}
                >
                  {busy ? copy.running : copy.live}
                </button>
              </div>
            </div>

            {outcome && (
              <p
                className="mt-2 text-[11px] font-semibold"
                style={{
                  color: outcome.ok
                    ? outcome.dryRun
                      ? "var(--a-text-muted)"
                      : "var(--a-positive)"
                    : "var(--a-negative)",
                }}
              >
                {outcome.text}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
