/**
 * Translation completeness check.
 *
 * TypeScript already forbids a missing Hebrew key, because `he` is typed as
 * `Dictionary`. This catches the two things the type system cannot see:
 *
 *   1. a Hebrew value left identical to the English one (an untranslated stub);
 *   2. a placeholder like {count} present in one language and missing in the
 *      other, which would render a literal "{count}" to a visitor.
 *
 * Run with `node scripts/i18n-check.mjs`. Exits non-zero on a real problem.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = (() => {
  try {
    return require("typescript");
  } catch {
    return null;
  }
})();

if (!ts) {
  console.error("typescript is required to run the i18n check");
  process.exit(1);
}

/** Strips types and runs a dictionary module, returning its named export. */
function loadDictionary(file, exportName) {
  const source = readFileSync(file, "utf8")
    .replace(/^import[^;]+;$/gm, "")
    .replace(/:\s*Dictionary\b/g, "")
    .replace(/\bas const\b/g, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  // Named `mod`, not `module`: Next lints against shadowing the CommonJS global,
  // and the transpiled dictionary only cares about the two arguments below.
  const mod = { exports: {} };
  new Function("module", "exports", js)(mod, mod.exports);
  return mod.exports[exportName];
}

const dir = path.resolve("src/i18n/dictionaries");
const en = loadDictionary(path.join(dir, "en.ts"), "en");
const he = loadDictionary(path.join(dir, "he.ts"), "he");

/** Values that are legitimately the same in both languages. */
const SHARED_ON_PURPOSE = new Set([
  "brand.protection.cpm",
  "brand.results.cpm",
  "home.hero.ugc",
  "home.campaigns.perThousand",
  "discover.perThousand",
  "footer.copyright",
  "footer.brandCopyright",
  "brand.campaigns.ss24",
  // Acronyms and product names that are identical in both languages.
  "admin.dau",
  "admin.wau",
  "admin.mau",
  "admin.svcFirebase",
  "admin.svcWhop",
  // The interview is held on Google Meet; the product name is not translated.
  "approval.interview.formatValue",
  "contact.emailPlaceholder",
  "contact.websitePlaceholder",
  "onboarding.referralSources.TikTok",
  "onboarding.referralSources.YouTube",
  "onboarding.referralSources.Twitter/X",
  "onboarding.languages.Hebrew",
  "discover.contentTypes.UGC Face",
  "discover.contentTypes.UGC Faceless",
  "legal.termsSuffix",
]);

/**
 * Placeholders that are intentionally absent in one language. Hebrew states a
 * singular without the numeral — "קמפיין אחד", "תוצאה אחת" — so forcing {count}
 * in would produce copy no Israeli product would ship.
 */
const PLACEHOLDER_EXEMPT = new Set(["discover.campaignCountOne", "faqs.resultFor"]);

const missing = [];
const untranslated = [];
const placeholderMismatch = [];
const extra = [];

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (s) => [...String(s).matchAll(PLACEHOLDER)].map((m) => m[1]).sort().join(",");

function walk(a, b, trail = []) {
  for (const [key, value] of Object.entries(a)) {
    const keyPath = [...trail, key];
    const id = keyPath.join(".");
    const other = b?.[key];

    if (other === undefined) {
      missing.push(id);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      walk(value, other, keyPath);
      continue;
    }
    if (placeholders(value) !== placeholders(other) && !PLACEHOLDER_EXEMPT.has(id)) {
      placeholderMismatch.push(`${id} — en{${placeholders(value)}} vs he{${placeholders(other)}}`);
    }
    if (value === other && !SHARED_ON_PURPOSE.has(id) && !/^[\s\-–—·|]*$/.test(String(value))) {
      untranslated.push(`${id} = "${value}"`);
    }
  }
  for (const key of Object.keys(b ?? {})) {
    if (!(key in a)) extra.push([...trail, key].join("."));
  }
}

walk(en, he);

function report(title, list) {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  for (const item of list) console.log(`  - ${item}`);
}

const total = (function count(o) {
  return Object.values(o).reduce((n, v) => n + (typeof v === "object" && v ? count(v) : 1), 0);
})(en);

console.log(`i18n check — ${total} keys in en`);
report("MISSING in he", missing);
report("EXTRA in he (not in en)", extra);
report("PLACEHOLDER MISMATCH", placeholderMismatch);
report("IDENTICAL to English (likely untranslated)", untranslated);

const failed = missing.length + extra.length + placeholderMismatch.length + untranslated.length;
if (failed === 0) console.log("\nOK — every key is present, translated and placeholder-consistent.");
process.exit(failed === 0 ? 0 : 1);
