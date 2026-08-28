"use client";

import Link from "next/link";
import { useAuth } from "./AuthProvider";
import { GoogleSignInButton } from "./GoogleSignInButton";

/**
 * Renders `children` once a Google account is signed in; otherwise shows the
 * sign-in panel. Used by /onboarding so "Become a Creator" lands on sign-in
 * first and continues into the wizard without a second navigation.
 */
export function AuthGate({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const { user, loading, configured, error } = useAuth();

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[420px] max-w-[440px] items-center justify-center">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
      </div>
    );
  }

  if (user) return <>{children}</>;

  return (
    <div className="mx-auto max-w-[440px] rounded-[var(--radius-token-lg)] bg-surface p-9 text-center shadow-[var(--shadow-float)]">
      <span
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-[14px] text-white"
        style={{ background: "linear-gradient(140deg, var(--accent), var(--accent-violet))" }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2.9l7.8 4.3v9.6L12 21.1l-7.8-4.3V7.2L12 2.9z"
            fill="white"
            fillOpacity="0.22"
            stroke="white"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M10.4 9.2l5 2.8-5 2.8V9.2z" fill="white" />
        </svg>
      </span>

      <h1 className="mt-5 font-[var(--font-display)] text-[26px] font-extrabold tracking-tight text-ink">
        {title}
      </h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-ink-soft">{subtitle}</p>

      <div className="mt-7">
        <GoogleSignInButton />
      </div>

      {error && <p className="mt-4 text-[13px] font-medium text-red-600">{error}</p>}

      {!configured && (
        <p className="mt-4 rounded-[var(--radius-token-md)] bg-surface-sunken px-4 py-3 text-left text-[12.5px] leading-relaxed text-ink-soft">
          Firebase isn&apos;t configured. Copy <code className="font-mono">.env.example</code> to{" "}
          <code className="font-mono">.env.local</code>, fill in your Firebase web-app keys, and
          restart the dev server.
        </p>
      )}

      <p className="mt-6 text-[12.5px] leading-relaxed text-ink-soft">
        By continuing you agree to our{" "}
        <Link href="/terms" className="font-medium text-ink underline underline-offset-2">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="font-medium text-ink underline underline-offset-2">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
