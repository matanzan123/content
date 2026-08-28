/**
 * Fictional brand dataset for the Brand realm.
 *
 * Every name, category, mark and palette here is invented for this build.
 * Nothing is copied from, or intended to resemble, a real company — the marks
 * are original geometry drawn on a 24x24 grid, and the palettes stay inside the
 * warm copper/amber world with a few muted supporting hues so the wall reads as
 * many different companies rather than one template recoloured.
 *
 * The first six entries are the ones the Hero already renders; their order must
 * stay stable so the Hero's composition is unaffected.
 */

export type BrandStyle = "gradient" | "dark" | "outline" | "solid";

export type Brand = {
  /** Display name. */
  name: string;
  /** Short niche line shown under the name. */
  sector: string;
  /** Two-letter monogram — used only for small corner badges, never as tile content. */
  monogram: string;
  /** Gradient endpoints for the mark. */
  from: string;
  to: string;
  /** Original mark geometry, 24x24 viewBox. */
  d: string;
  /** Fill the path as well as stroke it (solid-shape marks). */
  fill?: boolean;
  /** Preferred tile treatment, so the wall varies by brand rather than by position. */
  style: BrandStyle;
  /** Deterministic seed for this brand's product/campaign imagery. */
  seed: string;
  /** Swatches for identity tiles. */
  palette: [string, string, string];
};

const COPPER = "var(--accent)";
const EMBER = "var(--accent-2)";
const AMBER = "var(--accent-cyan)";
const RUST = "var(--accent-violet)";
const WARM = "var(--accent-warm)";
const TEAL = "#2f6f62";
const OLIVE = "#7a8b3f";
const CLAY = "#a35b3f";
const SLATE = "#5c5a51";
const PLUM = "#6d3f4a";

export const BRANDS: Brand[] = [
  // --- the six the Hero renders; order is load-bearing ---
  {
    name: "Northwind",
    sector: "Energy drinks",
    monogram: "NW",
    from: COPPER,
    to: EMBER,
    d: "M4 8.5h10.5M4 12.5h15.5M4 16.5h7.5",
    style: "gradient",
    seed: "bNorthwind",
    palette: [COPPER, EMBER, "#3c2415"],
  },
  {
    name: "Vertex Labs",
    sector: "Skincare",
    monogram: "VX",
    from: RUST,
    to: COPPER,
    d: "M12 3.4l7.4 4.3v8.6L12 20.6 4.6 16.3V7.7L12 3.4z",
    fill: true,
    style: "gradient",
    seed: "bVertex",
    palette: [RUST, COPPER, "#f7f0e8"],
  },
  {
    name: "Lumen Co.",
    sector: "Home tech",
    monogram: "LM",
    from: AMBER,
    to: EMBER,
    d: "M12 8.2a3.8 3.8 0 100 7.6 3.8 3.8 0 000-7.6zM12 3.2v2.1M12 18.7v2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M3.2 12h2.1M18.7 12h2.1M5.8 18.2l1.5-1.5M16.7 7.3l1.5-1.5",
    style: "dark",
    seed: "bLumen",
    palette: [AMBER, EMBER, "#2a1d12"],
  },
  {
    name: "Kite Audio",
    sector: "Headphones",
    monogram: "KA",
    from: COPPER,
    to: AMBER,
    d: "M12 3.2l6.2 8.8-6.2 8.8-6.2-8.8L12 3.2z",
    fill: true,
    style: "gradient",
    seed: "bKite",
    palette: [COPPER, AMBER, "#1a1108"],
  },
  {
    name: "Pulse Fit",
    sector: "Wearables",
    monogram: "PF",
    from: EMBER,
    to: RUST,
    d: "M3 12.5h3.4l2.2-6 3.8 11.6 2.3-5.6H21",
    style: "dark",
    seed: "bPulse",
    palette: [EMBER, RUST, "#f7f0e8"],
  },
  {
    name: "Orbit Nine",
    sector: "Streetwear",
    monogram: "O9",
    from: AMBER,
    to: COPPER,
    d: "M12 5.9a6.1 6.1 0 100 12.2 6.1 6.1 0 000-12.2zM21.4 12a9.4 3.1 0 11-18.8 0 9.4 3.1 0 0118.8 0z",
    style: "outline",
    seed: "bOrbit",
    palette: [AMBER, COPPER, "#3c2415"],
  },

  // --- extended roster ---
  {
    name: "Fernway",
    sector: "Travel gear",
    monogram: "FW",
    from: TEAL,
    to: EMBER,
    d: "M3.2 18.4l5.2-8.2 3.3 5.1 2.6-4 6.5 7.1H3.2zM8.4 7.4a1.7 1.7 0 100-3.4 1.7 1.7 0 000 3.4z",
    fill: true,
    style: "dark",
    seed: "bFernway",
    palette: [TEAL, EMBER, "#f7f0e8"],
  },
  {
    name: "Saltmarsh",
    sector: "Coastal apparel",
    monogram: "SM",
    from: WARM,
    to: COPPER,
    d: "M3 8.6c2.3-1.9 4.5-1.9 6.8 0s4.5 1.9 6.8 0 4.5-1.9 4.4 0M3 13c2.3-1.9 4.5-1.9 6.8 0s4.5 1.9 6.8 0 4.5-1.9 4.4 0M3 17.4c2.3-1.9 4.5-1.9 6.8 0s4.5 1.9 6.8 0 4.5-1.9 4.4 0",
    style: "solid",
    seed: "bSaltmarsh",
    palette: [WARM, COPPER, "#2a1d12"],
  },
  {
    name: "Ardent",
    sector: "Hot sauce",
    monogram: "AR",
    from: COPPER,
    to: RUST,
    d: "M12 21c3.6 0 6.2-2.5 6.2-6 0-4.4-4.3-6.6-4.3-10.8-2.6 1.3-3.6 3.6-3.6 5.7 0 1.6-1 2.3-1.8 1.5-.6-.6-.8-1.6-.8-1.6-1.2 1.6-1.9 3.3-1.9 5.2 0 3.5 2.6 6 6.2 6z",
    fill: true,
    style: "gradient",
    seed: "bArdent",
    palette: [COPPER, RUST, "#1a1108"],
  },
  {
    name: "Cobalt Row",
    sector: "Furniture",
    monogram: "CR",
    from: RUST,
    to: EMBER,
    d: "M4.5 6.5h15M7 11h12.5M4.5 15.5h15M9.5 20h10",
    style: "solid",
    seed: "bCobalt",
    palette: [RUST, EMBER, "#f7f0e8"],
  },
  {
    name: "Vireo",
    sector: "Plant care",
    monogram: "VR",
    from: OLIVE,
    to: WARM,
    d: "M12 20.5V11m0 0c0-3.5 2.6-6.4 6.4-6.9.5 3.9-1.9 7-6.4 6.9zm0 0C12 8.2 9.9 5.9 6.6 5.4 6.2 8.7 8.2 11.2 12 11z",
    fill: true,
    style: "dark",
    seed: "bVireo",
    palette: [OLIVE, WARM, "#2a1d12"],
  },
  {
    name: "Halden",
    sector: "Insurance",
    monogram: "HD",
    from: EMBER,
    to: COPPER,
    d: "M12 3l7.6 3.3v5.4c0 4.8-3.3 8.2-7.6 9.5-4.3-1.3-7.6-4.7-7.6-9.5V6.3L12 3zM12 9.4a1.9 1.9 0 00-1 3.5v2.3h2v-2.3a1.9 1.9 0 00-1-3.5z",
    fill: true,
    style: "outline",
    seed: "bHalden",
    palette: [EMBER, COPPER, "#3c2415"],
  },
  {
    name: "Bloom Supply",
    sector: "Florals",
    monogram: "BS",
    from: PLUM,
    to: COPPER,
    d: "M12 3.6a4.1 4.1 0 014.1 4.1c0 2.3-1.8 4.1-4.1 4.1S7.9 10 7.9 7.7A4.1 4.1 0 0112 3.6zM12 11.8v8.6M7.7 14.3c2 .4 3.5 1.9 4.3 3.8M16.3 14.3c-2 .4-3.5 1.9-4.3 3.8",
    style: "dark",
    seed: "bBloom",
    palette: [PLUM, COPPER, "#f7f0e8"],
  },
  {
    name: "Solace",
    sector: "Sleep & rest",
    monogram: "SO",
    from: SLATE,
    to: AMBER,
    d: "M15.6 4.2a8.4 8.4 0 100 15.6 9.2 9.2 0 010-15.6z",
    fill: true,
    style: "outline",
    seed: "bSolace",
    palette: [SLATE, AMBER, "#2a1d12"],
  },
  {
    name: "Afterglow",
    sector: "Candles",
    monogram: "AG",
    from: WARM,
    to: RUST,
    d: "M4 17.6h16M6.6 17.6a5.4 5.4 0 0110.8 0M12 5.2v2.4M6.4 7.6l1.7 1.7M17.6 7.6l-1.7 1.7",
    style: "gradient",
    seed: "bAfterglow",
    palette: [WARM, RUST, "#1a1108"],
  },
  {
    name: "Meridian Goods",
    sector: "Home fragrance",
    monogram: "MG",
    from: COPPER,
    to: WARM,
    d: "M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3z",
    fill: true,
    style: "solid",
    seed: "bMeridian",
    palette: [COPPER, WARM, "#3c2415"],
  },
  {
    name: "Tallow & Co.",
    sector: "Grooming",
    monogram: "TC",
    from: CLAY,
    to: AMBER,
    d: "M12 3.4c2.8 3.6 5.2 6.2 5.2 9.4a5.2 5.2 0 11-10.4 0c0-3.2 2.4-5.8 5.2-9.4z",
    fill: true,
    style: "dark",
    seed: "bTallow",
    palette: [CLAY, AMBER, "#f7f0e8"],
  },
  {
    name: "Harborline",
    sector: "Logistics",
    monogram: "HL",
    from: SLATE,
    to: EMBER,
    d: "M4.6 8.6a4 4 0 014-4h3v3h-3a1 1 0 00-1 1v3h-3v-3zM19.4 15.4a4 4 0 01-4 4h-3v-3h3a1 1 0 001-1v-3h3v3z",
    fill: true,
    style: "dark",
    seed: "bHarbor",
    palette: [SLATE, EMBER, "#2a1d12"],
  },
  {
    name: "Ridgeway",
    sector: "Outdoor",
    monogram: "RW",
    from: TEAL,
    to: COPPER,
    d: "M4 15l8-7 8 7M4 20l8-7 8 7",
    style: "outline",
    seed: "bRidgeway",
    palette: [TEAL, COPPER, "#3c2415"],
  },
  {
    name: "Cinder Studio",
    sector: "Design tools",
    monogram: "CS",
    from: RUST,
    to: AMBER,
    d: "M12 3.4v17.2M4.6 7.7l14.8 8.6M19.4 7.7L4.6 16.3",
    style: "gradient",
    seed: "bCinder",
    palette: [RUST, AMBER, "#1a1108"],
  },
  {
    name: "Palewell",
    sector: "Ceramics",
    monogram: "PW",
    from: CLAY,
    to: WARM,
    d: "M6.5 20V8.6a5.5 5.5 0 1111 0V20M6.5 13.6h11",
    style: "outline",
    seed: "bPalewell",
    palette: [CLAY, WARM, "#f7f0e8"],
  },
  {
    name: "Nocturne",
    sector: "Audio label",
    monogram: "NC",
    from: PLUM,
    to: AMBER,
    d: "M15.4 4.6a8.2 8.2 0 100 14.8 9 9 0 010-14.8zM19.4 5.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7z",
    fill: true,
    style: "dark",
    seed: "bNocturne",
    palette: [PLUM, AMBER, "#2a1d12"],
  },
  {
    name: "Sable Row",
    sector: "Eyewear",
    monogram: "SR",
    from: SLATE,
    to: COPPER,
    d: "M12 3.6l4.6 4.6L12 12.8 7.4 8.2 12 3.6zM12 11.2l4.6 4.6L12 20.4l-4.6-4.6L12 11.2z",
    fill: true,
    style: "solid",
    seed: "bSable",
    palette: [SLATE, COPPER, "#1a1108"],
  },
  {
    name: "Ironvale",
    sector: "Cookware",
    monogram: "IV",
    from: COPPER,
    to: SLATE,
    d: "M3.6 18.6h16.8M5.8 15l4-6.4 3 4.6 2.4-3.4 3 5.2",
    style: "dark",
    seed: "bIronvale",
    palette: [COPPER, SLATE, "#f7f0e8"],
  },
  {
    name: "Cove & Cedar",
    sector: "Furnishings",
    monogram: "CC",
    from: OLIVE,
    to: EMBER,
    d: "M12 3.6l5 7h-3l4 6H6l4-6H7l5-7zM12 16.6v3.8",
    fill: true,
    style: "outline",
    seed: "bCove",
    palette: [OLIVE, EMBER, "#2a1d12"],
  },
  {
    name: "Halcyon",
    sector: "Wellness",
    monogram: "HC",
    from: AMBER,
    to: TEAL,
    d: "M4 14.6c3.2-3.2 5.6-3.2 8 0 2.4-3.2 4.8-3.2 8 0M4 9.4c3.2-3.2 5.6-3.2 8 0 2.4-3.2 4.8-3.2 8 0",
    style: "gradient",
    seed: "bHalcyon",
    palette: [AMBER, TEAL, "#3c2415"],
  },
  {
    name: "Quillon",
    sector: "Stationery",
    monogram: "QL",
    from: EMBER,
    to: PLUM,
    d: "M12 3.4l6.6 6.6-6.6 10.6L5.4 10 12 3.4zM12 3.4v17.2",
    fill: true,
    style: "solid",
    seed: "bQuillon",
    palette: [EMBER, PLUM, "#1a1108"],
  },
  {
    name: "Marrow Goods",
    sector: "Pantry",
    monogram: "MW",
    from: CLAY,
    to: EMBER,
    d: "M3.6 11h16.8a8.4 8.4 0 01-16.8 0zM12 3.4v4.2M8.4 5.2v2.4M15.6 5.2v2.4",
    fill: true,
    style: "dark",
    seed: "bMarrow",
    palette: [CLAY, EMBER, "#f7f0e8"],
  },
  {
    name: "Thistlebone",
    sector: "Leather goods",
    monogram: "TB",
    from: PLUM,
    to: WARM,
    d: "M8 8.2a4 4 0 108 0 4 4 0 10-8 0zM8 15.8a4 4 0 108 0 4 4 0 10-8 0z",
    style: "outline",
    seed: "bThistle",
    palette: [PLUM, WARM, "#2a1d12"],
  },
  {
    name: "Everdusk",
    sector: "Photography",
    monogram: "ED",
    from: RUST,
    to: SLATE,
    d: "M3.8 16.4l4.6-5.6 3.2 3.8 3-3.6 5.6 5.4M3.8 16.4h16.4M16.2 7.6a1.8 1.8 0 100-3.6 1.8 1.8 0 000 3.6z",
    fill: true,
    style: "gradient",
    seed: "bEverdusk",
    palette: [RUST, SLATE, "#1a1108"],
  },
];

/** Fictional people shown on portrait tiles. Names and roles are invented. */
export type Founder = { img: number; name: string; role: string };

export const FOUNDERS: Founder[] = [
  { img: 14, name: "Mara Ellison", role: "Founder · Northwind" },
  { img: 36, name: "Tobias Reyn", role: "CMO · Kite Audio" },
  { img: 49, name: "Ines Vogel", role: "Founder · Vireo" },
  { img: 61, name: "Dara Okonkwo", role: "Growth · Halden" },
  { img: 22, name: "Petra Lindqvist", role: "Founder · Saltmarsh" },
  { img: 45, name: "Noor Haddad", role: "Brand lead · Ardent" },
  { img: 68, name: "Elias Moreau", role: "Founder · Cobalt Row" },
  { img: 12, name: "Rhys Calloway", role: "Head of brand · Fernway" },
  { img: 32, name: "Sena Adeyemi", role: "Founder · Bloom Supply" },
  { img: 5, name: "Johan Brandt", role: "CMO · Ridgeway" },
  { img: 27, name: "Liv Sandoval", role: "Founder · Afterglow" },
  { img: 55, name: "Amir Tehrani", role: "Growth · Cinder Studio" },
];
