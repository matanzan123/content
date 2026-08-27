import Image from "next/image";
import type { Role } from "./RoleToggle";

const BRAND_LOGOS = [
  { name: "Northwind", code: "NW", gradient: "linear-gradient(135deg, var(--accent), var(--accent-2))" },
  { name: "Solace", code: "SL", gradient: "linear-gradient(135deg, var(--accent-violet), var(--accent-cyan))" },
  { name: "Fernway", code: "FW", gradient: "linear-gradient(135deg, var(--accent-cyan), var(--accent-2))" },
];

// Deterministic mix of avatar photos and occasional brand-logo tiles, so the
// strip reads as "real people + a few brand partners", not decoration.
function buildStrip(count: number) {
  const items: { type: "avatar" | "brand"; seed: number }[] = [];
  for (let i = 0; i < count; i++) {
    items.push(i > 0 && i % 6 === 0 ? { type: "brand", seed: i } : { type: "avatar", seed: i });
  }
  return items;
}

function Tile({ type, seed }: { type: "avatar" | "brand"; seed: number }) {
  if (type === "brand") {
    const brand = BRAND_LOGOS[seed % BRAND_LOGOS.length];
    return (
      <span
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-[11px] font-black text-white shadow-[0_10px_20px_-6px_rgba(20,21,26,0.35)] transition-transform duration-200 hover:scale-110"
        style={{ background: brand.gradient }}
        title={brand.name}
      >
        {brand.code}
      </span>
    );
  }
  const size = 56;
  return (
    <span className="relative shrink-0 transition-transform duration-200 hover:scale-110">
      <Image
        src={`https://i.pravatar.cc/112?img=${(seed % 70) + 1}`}
        alt=""
        width={size}
        height={size}
        className="h-14 w-14 rounded-full object-cover shadow-[0_10px_20px_-6px_rgba(20,21,26,0.35)]"
        unoptimized
      />
      {seed % 4 !== 0 && (
        <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-surface bg-emerald-500" />
      )}
    </span>
  );
}

export function ActiveCreatorsStrip({ role }: { role: Role }) {
  const isBrand = role === "brand";
  const items = buildStrip(30);

  return (
    <section
      className={[
        "relative overflow-hidden pb-20 pt-2 transition-colors duration-300",
        isBrand ? "bg-surface-inverse" : "bg-surface-sunken",
      ].join(" ")}
    >
      <div className="mx-auto mb-5 flex max-w-[1240px] items-center justify-between px-6">
        <p
          className={[
            "text-[12px] font-bold uppercase tracking-[0.14em]",
            isBrand ? "text-ink-inverse-soft" : "text-ink-soft",
          ].join(" ")}
        >
          Active {role === "brand" ? "Brands" : "Creators"}
        </p>
        <p className={["text-[13px] font-semibold", isBrand ? "text-ink-inverse" : "text-ink"].join(" ")}>
          6,200+ online right now
        </p>
      </div>

      <div
        className="marquee-wrap relative"
        style={{
          maskImage: "linear-gradient(90deg, transparent, black 8%, black 92%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, black 8%, black 92%, transparent)",
        }}
      >
        <div className="marquee-track flex w-max items-center gap-5" style={{ animationDuration: "54s" }}>
          {[...items, ...items].map((item, idx) => (
            <Tile key={idx} type={item.type} seed={item.seed} />
          ))}
        </div>
      </div>
    </section>
  );
}
