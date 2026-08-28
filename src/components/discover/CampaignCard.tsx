"use client";

import Link from "next/link";
import type { Campaign, Platform } from "@/data/campaigns";
import { PlatformIcon } from "./PlatformIcon";

function money(n: number) {
  return n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K` : `$${n}`;
}

export function CampaignCard({ campaign, isBrand }: { campaign: Campaign; isBrand: boolean }) {
  const pct = campaign.budget > 0 ? Math.min(100, (campaign.paidOut / campaign.budget) * 100) : 0;

  return (
    <Link
      href={`/discover/${campaign.id}`}
      className={[
        "group flex flex-col overflow-hidden rounded-[16px] border transition-colors",
        isBrand
          ? "border-white/10 bg-surface-inverse-raised hover:border-white/20"
          : "border-line bg-surface hover:border-accent/40",
      ].join(" ")}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-surface-sunken">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={campaign.image}
          alt=""
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <span className="absolute left-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur">
          {campaign.status}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-1.5">
          <span
            className={[
              "text-[12.5px] font-medium",
              isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
            ].join(" ")}
          >
            {campaign.owner}
          </span>
          {campaign.ownerVerified && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-label="Verified">
              <path
                d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-1.2 2.8 1.2 2.8-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9L3.2 15.8 4.4 13 3.2 10.2l2.5-1.7.9-2.9 3 .2L12 2z"
                fill="var(--accent)"
              />
              <path d="M8.6 12.2l2.3 2.3 4.5-4.6" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span
            className={[
              "ml-auto text-[12px]",
              isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
            ].join(" ")}
          >
            {campaign.posted}
          </span>
        </div>

        <h3
          className={[
            "mt-1.5 line-clamp-2 text-[14.5px] font-bold leading-snug",
            isBrand ? "text-ink-inverse" : "text-ink",
          ].join(" ")}
        >
          {campaign.title}
        </h3>

        <div className="mt-3 flex items-center gap-1.5">
          {campaign.platforms.map((p: Platform) => (
            <span
              key={p}
              className={[
                "flex h-6 w-6 items-center justify-center rounded-md",
                isBrand ? "bg-white/10 text-ink-inverse" : "bg-surface-sunken text-ink",
              ].join(" ")}
            >
              <PlatformIcon platform={p} size={13} />
            </span>
          ))}
          <span
            className={[
              "ml-auto text-[13px] font-bold",
              isBrand ? "text-ink-inverse" : "text-ink",
            ].join(" ")}
          >
            ${campaign.cpm.toFixed(2)}
            <span className={isBrand ? "text-ink-inverse-soft" : "text-ink-soft"}>/1K</span>
          </span>
        </div>

        <div className="mt-4">
          <div className={["h-1.5 overflow-hidden rounded-full", isBrand ? "bg-white/10" : "bg-surface-sunken"].join(" ")}>
            <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <p
            className={[
              "mt-2 text-[12px]",
              isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
            ].join(" ")}
          >
            {money(campaign.paidOut)} of {money(campaign.budget)} paid out
          </p>
        </div>
      </div>
    </Link>
  );
}
