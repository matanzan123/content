"use client";

import { useState } from "react";
import { useT } from "@/i18n/provider";
import { useAuth } from "./AuthProvider";

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.8-2 5.1-4.4 6.7v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.4z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.8-12.3-9H4.4v5.7C8 41.6 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.7 28.3c-.4-1.3-.7-2.7-.7-4.3s.3-3 .7-4.3v-5.7H4.4A22 22 0 0 0 2 24c0 3.6.9 6.9 2.4 9.9l7.3-5.6z"
      />
      <path
        fill="#EA4335"
        d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8 6.4 4.4 14.1l7.3 5.7c1.7-5.2 6.6-9.1 12.3-9.1z"
      />
    </svg>
  );
}

export function GoogleSignInButton({ label }: { label?: string }) {
  const t = useT().onboarding;
  const { signInWithGoogle, configured } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      await signInWithGoogle();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !configured}
      className="inline-flex w-full items-center justify-center gap-3 rounded-[var(--radius-token-pill)] border border-line bg-surface px-6 py-3.5 text-[14.5px] font-semibold text-ink shadow-[var(--shadow-card)] transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
    >
      <GoogleMark />
      {busy ? t.openingGoogle : (label ?? t.continueWithGoogle)}
    </button>
  );
}
