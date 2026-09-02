"use client";

import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { Templated } from "@/i18n/Templated";
import { useT } from "@/i18n/provider";
import { track } from "@/lib/analytics/client";

const GOALS = [
  "Brand awareness at scale",
  "Drive app installs",
  "Product launch push",
  "Grow social following",
  "Sales & conversions",
  "Something else",
];

const BUDGETS = [
  "Under $5,000 / month",
  "$5,000 – $15,000 / month",
  "$15,000 – $50,000 / month",
  "$50,000 – $150,000 / month",
  "$150,000+ / month",
];

type Fields = {
  name: string;
  email: string;
  website: string;
  goal: string;
  budget: string;
};

const EMPTY: Fields = { name: "", email: "", website: "", goal: "", budget: "" };

function validate(values: Fields, e: Dictionary["contact"]["errors"]) {
  const errors: Partial<Record<keyof Fields, string>> = {};
  if (!values.name.trim()) errors.name = e.name;
  if (!values.email.trim()) errors.email = e.email;
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim()))
    errors.email = e.emailInvalid;
  if (!values.website.trim()) errors.website = e.website;
  if (!values.goal) errors.goal = e.goal;
  if (!values.budget) errors.budget = e.budget;
  return errors;
}

const FIELD_BASE =
  "w-full rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-4 py-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-soft focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent-soft aria-[invalid=true]:border-red-600";

const CHEVRON_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235b5d68' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")";

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  const required = useT().common.required;
  return (
    <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-ink">
      {children}{" "}
      <span className="text-accent" aria-hidden="true">
        *
      </span>
      <span className="sr-only">{required}</span>
    </label>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-[12.5px] font-medium text-red-700">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="mt-px shrink-0">
        <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.9" />
        <path d="M12 7.4v5.4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
        <circle cx="12" cy="16.4" r="1.15" fill="currentColor" />
      </svg>
      {message}
    </p>
  );
}

export function BrandOnboardingForm() {
  const t = useT().contact;
  const [values, setValues] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [wantsAgency, setWantsAgency] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const update =
    (key: keyof Fields) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setValues((v) => ({ ...v, [key]: e.target.value }));
      setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    };

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nextErrors = validate(values, t.errors);
    setErrors(nextErrors);
    const firstBad = (Object.keys(nextErrors) as (keyof Fields)[])[0];
    if (firstBad) {
      document.getElementById(firstBad)?.focus();
      return;
    }
    // Placeholder build — no backend yet. Swap for a route handler when one exists.
    track("brand_form_submitted", { outcome: "success" });
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="flex min-h-[460px] flex-col items-center justify-center px-6 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M5 12.5L10 17.5L19 7.5"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <h3 className="mt-5 font-[var(--font-display)] text-[24px] font-extrabold tracking-tight text-ink">
          {t.successTitle.replace("{name}", values.name.trim().split(" ")[0])}
        </h3>
        <p className="mt-2.5 max-w-sm text-[14px] leading-relaxed text-ink-soft">
          {/* The address is a Latin run inside a Hebrew sentence — Templated
              gives it its own LTR isolation as well as its weight. */}
          <Templated
            template={t.successBody.replace("{agency}", wantsAgency ? t.successAgency : "")}
            token="email"
            value={values.email.trim()}
            className="font-semibold text-ink"
          />
        </p>
        <button
          type="button"
          onClick={() => {
            setValues(EMPTY);
            setWantsAgency(false);
            setSubmitted(false);
          }}
          className="mt-7 rounded-[var(--radius-token-pill)] border border-line px-5 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-sunken"
        >
          {t.submitAnother}
        </button>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="px-6 py-10 sm:px-10 sm:py-12">
      <div className="mx-auto max-w-[460px]">
        <h2 className="font-[var(--font-display)] text-[22px] font-extrabold tracking-tight text-ink">
          {t.formTitle}
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
          {t.formSubtitle}
        </p>

        <div className="mt-7 space-y-5">
          <div>
            <Label htmlFor="name">{t.name}</Label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder={t.namePlaceholder}
              value={values.name}
              onChange={update("name")}
              required
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "name-error" : undefined}
              className={`mt-2 ${FIELD_BASE}`}
            />
            <FieldError id="name-error" message={errors.name} />
          </div>

          <div>
            <Label htmlFor="email">{t.email}</Label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder={t.emailPlaceholder} dir="ltr"
              value={values.email}
              onChange={update("email")}
              required
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              className={`mt-2 ${FIELD_BASE}`}
            />
            <FieldError id="email-error" message={errors.email} />
          </div>

          <div>
            <Label htmlFor="website">{t.website}</Label>
            <input
              id="website"
              name="website"
              type="url"
              autoComplete="url"
              placeholder={t.websitePlaceholder} dir="ltr"
              value={values.website}
              onChange={update("website")}
              required
              aria-invalid={!!errors.website}
              aria-describedby={errors.website ? "website-error" : undefined}
              className={`mt-2 ${FIELD_BASE}`}
            />
            <FieldError id="website-error" message={errors.website} />
          </div>

          <div>
            <Label htmlFor="goal">{t.goal}</Label>
            <select
              id="goal"
              name="goal"
              value={values.goal}
              onChange={update("goal")}
              required
              aria-invalid={!!errors.goal}
              aria-describedby={errors.goal ? "goal-error" : undefined}
              className={`mt-2 appearance-none bg-[length:16px] bg-[right_1rem_center] bg-no-repeat pr-11 ${FIELD_BASE}`}
              style={{ backgroundImage: CHEVRON_BG }}
            >
              <option value="">{t.goalPlaceholder}</option>
              {GOALS.map((g) => (
                <option key={g} value={g}>
                  {t.goals[g as keyof typeof t.goals] ?? g}
                </option>
              ))}
            </select>
            <FieldError id="goal-error" message={errors.goal} />
          </div>

          <div>
            <Label htmlFor="budget">{t.budget}</Label>
            <select
              id="budget"
              name="budget"
              value={values.budget}
              onChange={update("budget")}
              required
              aria-invalid={!!errors.budget}
              aria-describedby={errors.budget ? "budget-error" : undefined}
              className={`mt-2 appearance-none bg-[length:16px] bg-[right_1rem_center] bg-no-repeat pr-11 ${FIELD_BASE}`}
              style={{ backgroundImage: CHEVRON_BG }}
            >
              <option value="">{t.budgetPlaceholder}</option>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>
                  {t.budgets[b as keyof typeof t.budgets] ?? b}
                </option>
              ))}
            </select>
            <FieldError id="budget-error" message={errors.budget} />
          </div>

          <label className="flex cursor-pointer items-start gap-3 pt-1">
            <input
              type="checkbox"
              checked={wantsAgency}
              onChange={(e) => setWantsAgency(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-line accent-[var(--accent)]"
            />
            <span className="text-[13.5px] leading-snug text-ink-soft">
              {t.agency}
            </span>
          </label>
        </div>

        <button
          type="submit"
          className="mt-8 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-accent px-7 py-3 text-[14px] font-bold text-white transition-colors hover:bg-accent-ink"
        >
          {t.submit}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="dir-flip">
            <path
              d="M5 12H19M19 12L13 6M19 12L13 18"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <p className="mt-4 text-[12px] leading-relaxed text-ink-soft">
          {t.note}
        </p>
      </div>
    </form>
  );
}
