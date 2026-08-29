import { Fragment } from "react";

/**
 * Content primitives for the legal pages.
 *
 * Deliberately NOT a "use client" module: the page files are server components
 * and build their document by calling these helpers, which a client module
 * cannot expose. `LegalDocument` is the client half and only renders what these
 * produce.
 */

export type Block =
  | { kind: "p"; text: React.ReactNode }
  | { kind: "h3"; text: string }
  | { kind: "list"; items: React.ReactNode[] }
  | { kind: "callout"; text: React.ReactNode };

export type Section = {
  id: string;
  title: string;
  /** Optional grouping — supply on every section, or on none. */
  part?: string;
  blocks: Block[];
};

export function p(text: React.ReactNode): Block {
  return { kind: "p", text };
}

export function h3(text: string): Block {
  return { kind: "h3", text };
}

/**
 * Bullet list. Items are keyed here rather than at render time: an array of
 * unkeyed elements sitting in a prop is walked by the server renderer on its
 * way to the client boundary, which warns before the list component ever sees
 * it.
 */
export function list(items: React.ReactNode[]): Block {
  return {
    kind: "list",
    items: items.map((item, i) => <Fragment key={i}>{item}</Fragment>),
  };
}

export function callout(text: React.ReactNode): Block {
  return { kind: "callout", text };
}

/**
 * Renders a value from legal-config that ClipRewards still has to supply. It is
 * styled to stand out precisely so an unfilled placeholder cannot ship unnoticed.
 */
export function Ph({ children }: { children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[0.88em] font-semibold text-accent-ink">
      {children}
    </span>
  );
}
