"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { track } from "@/lib/analytics/client";

/**
 * One logical navigation, one page_view.
 *
 * Everything here exists to stop double counting. React Strict Mode runs
 * effects twice in development, the locale provider re-renders on a language
 * switch, and hydration replays the tree — any of which would fire a second
 * event for the same page. The guard is a ref holding the last path actually
 * reported: a re-run for an unchanged path is a no-op, so only a genuine route
 * change emits.
 *
 * Mounted once in the locale layout, so it covers every localized route
 * without each page opting in.
 */
export function PageViewTracker() {
  const pathname = usePathname();
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || lastReported.current === pathname) return;

    // A session's first page view is also its start. Emitting both keeps
    // session-level reporting independent of page-level reporting.
    if (lastReported.current === null) track("session_started");

    lastReported.current = pathname;
    track("page_view");
  }, [pathname]);

  return null;
}
