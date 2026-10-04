"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useT } from "@/i18n/provider";
import { ISO_COUNTRY_CODES } from "@/lib/country-codes";

type CountryResponse = {
  country_code?: string | null;
  locked?: boolean;
  error?: string;
};

type AccountResponse = {
  ok?: boolean;
  created?: boolean;
  error?: string;
};

export function WhopPayoutSetup({ locale }: { locale: string }) {
  const dict = useT();
  const t = dict.dashboard.whop.payout;
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [selectedCountry, setSelectedCountry] = useState("");
  const [savedCountry, setSavedCountry] = useState("");
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "create">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const countries = useMemo(() => {
    let displayNames: Intl.DisplayNames | null = null;

    try {
      displayNames = new Intl.DisplayNames([locale], { type: "region" });
    } catch {
      displayNames = null;
    }

    const collator = new Intl.Collator(locale, { sensitivity: "base" });

    return ISO_COUNTRY_CODES.map((code) => ({
      code,
      name: displayNames?.of(code) ?? code,
    })).sort((a, b) => collator.compare(a.name, b.name));
  }, [locale]);

  useEffect(() => {
    if (authLoading || !user) return;

    let cancelled = false;

    (async () => {
      try {
        const idToken = await user.getIdToken();
        const response = await fetch("/api/whop/country", {
          headers: { authorization: `Bearer ${idToken}` },
          cache: "no-store",
        });

        const body = (await response.json().catch(() => null)) as CountryResponse | null;

        if (cancelled) return;

        if (!response.ok) {
          setError(t.errors.load);
          return;
        }

        const country = body?.country_code ?? "";
        setSelectedCountry(country);
        setSavedCountry(country);
        setLocked(body?.locked === true);
      } catch {
        if (!cancelled) setError(t.errors.load);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, user, t.errors.load]);

  async function saveCountry() {
    if (!user || !selectedCountry || locked || busy) return;

    setBusy("save");
    setError(null);
    setMessage(null);

    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/whop/country", {
        method: "POST",
        headers: {
          authorization: `Bearer ${idToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ country_code: selectedCountry }),
      });

      const body = (await response.json().catch(() => null)) as CountryResponse | null;

      if (!response.ok) {
        if (body?.error === "country_locked") {
          setLocked(true);
          setError(t.locked);
        } else {
          setError(t.errors.save);
        }
        return;
      }

      const country = body?.country_code ?? selectedCountry;
      setSelectedCountry(country);
      setSavedCountry(country);
      setMessage(t.saved);
    } catch {
      setError(t.errors.save);
    } finally {
      setBusy(null);
    }
  }

  async function createAccount() {
    if (!user || busy || locked) return;

    if (!savedCountry || selectedCountry !== savedCountry) {
      setError(t.unsaved);
      return;
    }

    setBusy("create");
    setError(null);
    setMessage(null);

    try {
      const idToken = await user.getIdToken();

      const response = await fetch("/api/whop/account", {
        method: "POST",
        headers: {
          authorization: `Bearer ${idToken}`,
        },
      });

      const body = (await response.json().catch(() => null)) as AccountResponse | null;

      if (!response.ok) {
        if (body?.error === "platforms_access_required") {
          setError(t.errors.platforms);
        } else if (body?.error === "whop_identity_required") {
          setError(t.errors.connectFirst);
        } else if (body?.error === "country_required") {
          setError(t.unsaved);
        } else {
          setError(t.errors.create);
        }
        return;
      }

      setLocked(true);
      setMessage(t.created);
    } catch {
      setError(t.errors.create);
    } finally {
      setBusy(null);
    }
  }

  if (!authLoading && !user) {
    return (
      <div className="mb-6 rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-5 py-4">
        <p role="alert" className="text-[13px] font-medium text-red-700">
          {t.errors.load}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mb-6 rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-5 py-4">
        <p className="text-[13px] text-ink-soft">{t.loading}</p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-5 py-5">
      <h3 className="text-[14px] font-bold text-ink">{t.title}</h3>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-soft">
        {t.body}
      </p>

      <label className="mt-4 block text-[12.5px] font-semibold text-ink">
        {t.countryLabel}
      </label>

      <select
        value={selectedCountry}
        onChange={(event) => {
          setSelectedCountry(event.target.value);
          setMessage(null);
          setError(null);
        }}
        disabled={locked || busy !== null}
        className="mt-2 w-full max-w-md rounded-[var(--radius-token-md)] border border-line bg-surface px-4 py-3 text-[14px] text-ink outline-none focus:border-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">{t.chooseCountry}</option>
        {countries.map(({ code, name }) => (
          <option key={code} value={code}>
            {name} ({code})
          </option>
        ))}
      </select>

      {locked ? (
        <p className="mt-3 text-[12.5px] font-medium text-ink-soft">{t.locked}</p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={saveCountry}
            disabled={
              busy !== null ||
              !selectedCountry ||
              selectedCountry === savedCountry
            }
            className="rounded-[var(--radius-token-pill)] border border-line bg-surface px-5 py-2.5 text-[13.5px] font-semibold text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "save" ? t.saving : t.saveCountry}
          </button>

          <button
            type="button"
            onClick={createAccount}
            disabled={
              busy !== null ||
              !savedCountry ||
              selectedCountry !== savedCountry
            }
            className="rounded-[var(--radius-token-pill)] bg-ink px-5 py-2.5 text-[13.5px] font-bold text-white transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "create" ? t.creating : t.createAccount}
          </button>
        </div>
      )}

      {message && (
        <p role="status" className="mt-3 text-[13px] font-medium text-ink">
          {message}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[13px] font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}