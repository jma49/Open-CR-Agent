import type { GoldenCase } from "./golden.js";
import type { Imported } from "./golden-import.js";

type Claim = GoldenCase["expect"][number];

const isPersons = (e: Claim) => e.producer === "human";
const hasPersons = (c: GoldenCase) => c.expect.some(isPersons);

// The order to vet candidates in: cases restating a person's comment first
// (ADR-0036 point 1), each group in the order it was imported.
function vettingOrder(imported: readonly Imported[]): GoldenCase[] {
  const cases = imported.map((i) => i.case);
  return [...cases.filter(hasPersons), ...cases.filter((c) => !hasPersons(c))];
}

function count(keys: readonly string[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const k of keys) totals.set(k, (totals.get(k) ?? 0) + 1);
  return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]) {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---|").join("")}`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ];
}

// People's and models' claims side by side, per key.
function split(claims: readonly Claim[], key: (e: Claim) => string): string[][] {
  return count(claims.map(key)).map(([k]) => {
    const own = claims.filter((e) => key(e) === k);
    return [
      k,
      String(own.filter(isPersons).length),
      String(own.filter((e) => !isPersons(e)).length),
    ];
  });
}

// What a reviewer of the candidates needs to see first: how they spread, and
// the order to vet them in.
export function renderImportSummary(imported: readonly Imported[]): string {
  const cases = vettingOrder(imported);
  const claims = cases.flatMap((c) => c.expect);
  const seeds = imported.flatMap((i) => i.forbidSeeds);
  const people = claims.filter(isPersons).length;
  return [
    "# AACR-Bench golden candidates",
    "",
    `${cases.length} case(s) with ${claims.length} expected finding(s): ${people} restate a person's review comment and ${claims.length - people} a model's (optional until vetted). Unverified: check each expectation, and the repository's licence, before moving the case to evals/golden. forbid-seeds.json holds ${seeds.length} comment(s) AACR-Bench labels incorrect on ${new Set(seeds.map((s) => s.case)).size} of these pull requests, to vet into forbid ranges.`,
    "",
    ...table(
      ["Language", "Cases", "People's claims", "Models' claims"],
      count(cases.map((c) => c.language)).map(([language, n]) => {
        const own = cases.filter((c) => c.language === language).flatMap((c) => c.expect);
        return [language, n, own.filter(isPersons).length, own.filter((e) => !isPersons(e)).length];
      }),
    ),
    ...table(
      ["Category", "People's claims", "Models' claims"],
      split(claims, (e) => e.category),
    ),
    ...table(["minSeverity (defaulted)", "Count"], count(claims.map((e) => e.minSeverity))),
    ...table(["Written by (expected findings)", "Count"], count(claims.map((e) => e.producer))),
    ...table(["Licence at head (cases)", "Count"], count(cases.map((c) => c.source.licence))),
    ...table(
      ["Left out (in-scope comments)", "Count"],
      count(imported.flatMap((i) => i.leftOut.map((l) => l.reason.split(":")[0] ?? l.reason))),
    ),
    "## Vetting order",
    "",
    "Cases with a person's comment first, then those with models' only.",
    "",
    ...table(
      ["#", "Case", "Language", "People's claims", "Models' claims", "Licence"],
      cases.map((c, n) => [
        n + 1,
        c.id,
        c.language,
        c.expect.filter(isPersons).length,
        c.expect.filter((e) => !isPersons(e)).length,
        c.source.licence,
      ]),
    ),
  ].join("\n");
}
