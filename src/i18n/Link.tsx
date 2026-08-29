"use client";

import NextLink from "next/link";
import { forwardRef } from "react";
import { localePath, splitLocalePath } from "./config";
import { useI18n } from "./provider";

/**
 * Locale-aware Link.
 *
 * Every internal href in the product is written in its plain form — "/discover",
 * "/privacy-policy" — and this prefixes it with the language the visitor is
 * reading in. Without it, one un-prefixed link would silently drop a Hebrew
 * visitor back into English mid-journey.
 *
 * Left alone:
 *   - absolute URLs (http:, mailto:, tel:) — someone else's site,
 *   - hash-only links — same page,
 *   - /api/… — route handlers have no locale segment,
 *   - anything already carrying a locale prefix, so double-prefixing is
 *     impossible even if a caller passes "/he/faqs".
 */
function withLocale(href: string, locale: "en" | "he"): string {
  if (!href.startsWith("/")) return href; // http, mailto, tel, #hash, relative
  if (href.startsWith("/api/")) return href;

  const [pathAndQuery, hash] = href.split("#");
  const [path, query] = pathAndQuery.split("?");

  if (splitLocalePath(path).locale) return href;

  const prefixed = localePath(locale, path);
  return `${prefixed}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}

type LinkProps = React.ComponentProps<typeof NextLink>;

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, ...rest },
  ref,
) {
  const { locale } = useI18n();
  const resolved = typeof href === "string" ? withLocale(href, locale) : href;
  return <NextLink ref={ref} href={resolved} {...rest} />;
});

export default Link;
