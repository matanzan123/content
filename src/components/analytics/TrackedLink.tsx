"use client";

import { forwardRef } from "react";
import { Link } from "@/i18n/Link";
import { track } from "@/lib/analytics/client";
import type { CtaId } from "@/lib/analytics/cta";

/**
 * A locale-aware link that reports its own conversion click.
 *
 * Wrapping the link rather than adding an onClick at each call site means a CTA
 * cannot be added without an id, and `sendBeacon` inside `track` survives the
 * navigation that follows — so the event is not lost to the page unload.
 *
 * `ctaId` is a `CtaId`, so a typo or a raw label is a type error.
 */
type Props = React.ComponentProps<typeof Link> & { ctaId: CtaId };

export const TrackedLink = forwardRef<HTMLAnchorElement, Props>(function TrackedLink(
  { ctaId, onClick, ...rest },
  ref,
) {
  return (
    <Link
      {...rest}
      ref={ref}
      onClick={(event) => {
        track("cta_clicked", { cta_id: ctaId });
        onClick?.(event);
      }}
    />
  );
});
