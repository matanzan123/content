"use client";

import { useState } from "react";

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

function validate(values: Fields) {
  const errors: Partial<Record<keyof Fields, string>> = {};
  if (!values.name.trim()) errors.name = "Tell us who we're talking to.";
  if (!values.email.trim()) errors.email = "We need an email to reply to.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email.trim()))
    errors.email = "That doesn't look like a valid email.";
  if (!values.website.trim()) errors.website = "Add your company website.";
  if (!values.goal) errors.goal = "Pick the goal closest to yours.";
  if (!values.budget) errors.budget = "Pick a budget range.";
  return errors;
}

const FIELD_BASE =
  "w-full rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-4 py-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-soft/70 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent-soft";

const CHEVRON_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235b5d68' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")";

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-[13px] font-semibold text-ink">
      {children} <span className="text-accent">*</span>
    </label>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[12.5px] font-medium text-red-600">
      {message}
    </p>
  );
}

export function BrandOnboardingForm() {
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
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    // Placeholder build — no backend yet. Swap for a route handler when one exists.
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
          Thanks, {values.name.trim().split(" ")[0]} — we&apos;ve got it.
        </h3>
        <p className="mt-2.5 max-w-sm text-[14px] leading-relaxed text-ink-soft">
          A campaign strategist will reply to{" "}
          <span className="font-semibold text-ink">{values.email.trim()}</span> within one business
          day{wantsAgency ? ", along with a matched Verified Agency." : "."}
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
          Submit another request
        </button>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="px-6 py-10 sm:px-10 sm:py-12">
      <div className="mx-auto max-w-[460px]">
        <h2 className="font-[var(--font-display)] text-[22px] font-extrabold tracking-tight text-ink">
          Brand Onboarding
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
          Tell us what you&apos;re launching and we&apos;ll map the right creator mix for it.
        </p>

        <div className="mt-7 space-y-5">
          <div>
            <Label htmlFor="name">Name</Label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Jordan Reyes"
              value={values.name}
              onChange={update("name")}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "name-error" : undefined}
              className={`mt-2 ${FIELD_BASE}`}
            />
            <FieldError id="name-error" message={errors.name} />
          </div>

          <div>
            <Label htmlFor="email">Company Email</Label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={values.email}
              onChange={update("email")}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              className={`mt-2 ${FIELD_BASE}`}
            />
            <FieldError id="email-error" message={errors.email} />
          </div>

          <div>
            <Label htmlFor="website">Company Website</Label>
            <input
              id="website"
              name="website"
              type="url"
              autoComplete="url"
              placeholder="https://company.com"
              value={values.website}
              onChange={update("website")}
              aria-invalid={!!errors.website}
              aria-describedby={errors.website ? "website-error" : undefined}
              className={`mt-2 ${FIELD_BASE}`}
            />
            <FieldError id="website-error" message={errors.website} />
          </div>

          <div>
            <Label htmlFor="goal">What Are Your Goals</Label>
            <select
              id="goal"
              name="goal"
              value={values.goal}
              onChange={update("goal")}
              aria-invalid={!!errors.goal}
              aria-describedby={errors.goal ? "goal-error" : undefined}
              className={`mt-2 appearance-none bg-[length:16px] bg-[right_1rem_center] bg-no-repeat pr-11 ${FIELD_BASE}`}
              style={{ backgroundImage: CHEVRON_BG }}
            >
              <option value="">Select a goal</option>
              {GOALS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <FieldError id="goal-error" message={errors.goal} />
          </div>

          <div>
            <Label htmlFor="budget">Marketing Budget</Label>
            <select
              id="budget"
              name="budget"
              value={values.budget}
              onChange={update("budget")}
              aria-invalid={!!errors.budget}
              aria-describedby={errors.budget ? "budget-error" : undefined}
              className={`mt-2 appearance-none bg-[length:16px] bg-[right_1rem_center] bg-no-repeat pr-11 ${FIELD_BASE}`}
              style={{ backgroundImage: CHEVRON_BG }}
            >
              <option value="">Select a range</option>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>
                  {b}
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
              Would you like guaranteed results by working with a Verified Agency?
            </span>
          </label>
        </div>

        <button
          type="submit"
          className="mt-8 inline-flex items-center gap-2 rounded-[var(--radius-token-pill)] bg-accent px-7 py-3 text-[14px] font-bold text-white transition-colors hover:bg-accent-ink"
        >
          Submit
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
          Placeholder build — submissions aren&apos;t sent anywhere yet.
        </p>
      </div>
    </form>
  );
}
