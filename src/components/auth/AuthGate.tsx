"use client";

import { Link } from "@/i18n/Link";
import { useAuth } from "./AuthProvider";
import { useT } from "@/i18n/provider";
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
  const t = useT().onboarding;

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

      {error && (
        <p role="alert" className="mt-4 text-[13px] font-medium text-red-600">
          {t[error]}
        </p>
      )}

      {!configured && (
        <p className="mt-4 rounded-[var(--radius-token-md)] bg-surface-sunken px-4 py-3 text-start text-[12.5px] leading-relaxed text-ink-soft">
          {/* The two filenames keep their monospace treatment in both languages. */}
          {(() => {
            const [lead, rest = ""] = t.firebaseNotConfigured.split("{example}");
            const [mid, tail = ""] = rest.split("{local}");
            return (
              <>
                {lead}
                <code className="ltr-token font-mono">.env.example</code>
                {mid}
                <code className="ltr-token font-mono">.env.local</code>
                {tail}
              </>
            );
          })()}
        </p>
      )}

      {/* The spacing around each part comes from the dictionary, because Hebrew
          attaches "ל" straight onto the next word where English needs a space. */}
      <p className="mt-6 text-[12.5px] leading-relaxed text-ink-soft">
        {t.agreePrefix}
        <Link href="/terms-of-service" className="font-medium text-ink underline underline-offset-2">
          {t.agreeTerms}
        </Link>
        {t.agreeAnd}
        <Link href="/privacy-policy" className="font-medium text-ink underline underline-offset-2">
          {t.agreePrivacy}
        </Link>
        .
      </p>
    </div>
  );
}
