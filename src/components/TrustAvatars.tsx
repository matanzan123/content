import Image from "next/image";

const SEEDS = [23, 36, 49, 15, 60, 8];

export function TrustAvatars({ isBrand, size = 36 }: { isBrand: boolean; size?: number }) {
  return (
    <div className="flex -space-x-3">
      {SEEDS.map((seed) => (
        <Image
          key={seed}
          src={`https://i.pravatar.cc/96?img=${seed}`}
          alt=""
          width={size}
          height={size}
          unoptimized
          className="rounded-full object-cover shadow-[0_6px_14px_-4px_rgba(20,21,26,0.35)] transition-transform duration-200 hover:z-10 hover:scale-110"
          style={{
            width: size,
            height: size,
            borderWidth: 2,
            borderStyle: "solid",
            borderColor: isBrand ? "var(--surface-inverse)" : "var(--surface-sunken)",
          }}
        />
      ))}
    </div>
  );
}
