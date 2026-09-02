"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Ends the admin session server-side. The DELETE clears the httpOnly cookie
 * and revokes the account's refresh tokens, so a copy of the cookie taken
 * earlier cannot be replayed. There is nothing to clear on the client because
 * nothing privileged was ever stored there.
 */
export function AdminSignOut({ label }: { label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch("/api/admin/session", { method: "DELETE" });
        } finally {
          router.refresh();
        }
      }}
      className="rounded-[var(--radius-token-pill)] border border-line px-5 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-sunken disabled:opacity-60"
    >
      {label}
    </button>
  );
}
