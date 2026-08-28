const CARDS = [
  {
    title: "Flag Content",
    description: "Report anything off-brief in one click — our team reviews it within hours, not days.",
    art: "flag" as const,
  },
  {
    title: "Bot Detection",
    description: "Sudden view spikes and suspicious activity are caught automatically, before you ever pay for them.",
    art: "shield" as const,
  },
  {
    title: "Priority Support",
    description: "Verified brands get a direct line to our team — not a ticket queue.",
    art: "headset" as const,
  },
];

function CardArt({ kind }: { kind: "flag" | "shield" | "headset" }) {
  if (kind === "flag") {
    return (
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
        <path d="M6 3V21" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <path d="M6 4.5C9 3 11 6 14 4.5C16 3.5 18 4.5 18 4.5V12C18 12 16 11 14 12C11 13.5 9 10.5 6 12V4.5Z" fill="white" fillOpacity="0.25" stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "shield") {
    return (
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
        <path d="M12 3L19 6V11C19 15.5 16 19 12 21C8 19 5 15.5 5 11V6L12 3Z" fill="white" fillOpacity="0.2" stroke="white" strokeWidth="1.8" />
        <path d="M9 12L11.2 14.2L15.5 9.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
      <path d="M4 13V11C4 6.6 7.6 3 12 3C16.4 3 20 6.6 20 11V13" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="3" y="13" width="4.5" height="6" rx="2" fill="white" fillOpacity="0.25" stroke="white" strokeWidth="1.6" />
      <rect x="16.5" y="13" width="4.5" height="6" rx="2" fill="white" fillOpacity="0.25" stroke="white" strokeWidth="1.6" />
    </svg>
  );
}

export function BrandProtection() {
  return (
    <section className="relative overflow-hidden bg-surface-inverse px-6 pb-20 pt-4">
      <div className="relative mx-auto max-w-[1240px] text-center">
        <p className="font-[var(--font-display)] text-[12px] font-bold uppercase tracking-[0.14em] text-ink-inverse-soft">
          Protection
        </p>
        <h2 className="mx-auto mt-4 max-w-lg font-[var(--font-display)] text-[38px] font-black leading-tight tracking-tight text-ink-inverse">
          Every Campaign, Protected
        </h2>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-ink-inverse-soft">
          Built-in safeguards keep your budget safe and your results real.
        </p>

        <div className="mx-auto mt-12 grid max-w-3xl grid-cols-1 gap-6 sm:grid-cols-3">
          {CARDS.map((card) => (
            <div
              key={card.title}
              className="group overflow-hidden rounded-[26px] border border-white/10 bg-surface-inverse-raised text-left shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] transition-all duration-300 hover:-translate-y-1.5 hover:border-accent/40"
            >
              <div
                className="flex h-[120px] items-center justify-center"
                style={{ background: "linear-gradient(135deg, var(--accent-violet), var(--accent-2))" }}
              >
                <CardArt kind={card.art} />
              </div>
              <div className="p-5">
                <h3 className="text-[16px] font-extrabold text-ink-inverse">{card.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink-inverse-soft">{card.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
