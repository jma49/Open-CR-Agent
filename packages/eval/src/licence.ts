import { isAllowedLicence, type Licence, UNCHECKED_LICENCE } from "./golden.js";

// What the files at a repository's root say about its licence, for a golden
// candidate (ADR-0036 point 3). Written here rather than taken from a
// library: the npm licence tools read installed packages' metadata, not a
// repository's licence texts, and a candidate needs only the allowlist's ids,
// told apart conservatively. Anything unclear stays NOASSERTION, and the
// vetter confirms every licence before a case moves into evals/golden.

export interface RootFile {
  name: string;
  text: string;
}

export interface LicenceVerdict {
  licence: Licence | typeof UNCHECKED_LICENCE;
  // How the verdict was reached, in a few words, for the case's source.ref.
  note: string;
}

const LICENCE_TEXT = /^(licen[cs]e|copying|unlicense)([-._][a-z0-9._-]*)?$/i;
const METADATA = new Set(["package.json", "composer.json", "Cargo.toml", "pyproject.toml"]);

export function isLicenceSource(name: string): boolean {
  return LICENCE_TEXT.test(name) || METADATA.has(name);
}

// Each licence by phrases its text contains, matched on the text lowercased
// with everything but letters, digits, '.', ',' and '/' turned into spaces.
// The GNU texts do not say whether "-only" or "-or-later" applies: that is
// stated in the source files' headers, so the text alone leaves both open.
interface Text {
  name: string;
  ids: readonly string[];
  all: readonly RegExp[];
  none?: readonly RegExp[];
}

const gnu = (name: string, header: RegExp): Text => ({
  name,
  ids: [`${name}-only`, `${name}-or-later`],
  all: [header],
});
const MIT_GRANT = /permission is hereby granted, free of charge, to any person obtaining a copy/;
const MIT_NOTICE = /the above copyright notice and this permission notice shall be included/;
const BSD_GRANT =
  /redistribution and use in source and binary forms, with or without modification, are permitted/;
const BSD_ENDORSE = /to endorse or promote products derived from this software/;
const BSD_ADVERTISING = /advertising materials/;
const ISC_GRANT =
  /permission to use, copy, modify, and(\/or)? distribute this software for any purpose with or without fee is hereby granted/;
const ISC_NOTICE =
  /provided that the above copyright notice and this permission notice appear in all copies/;

const TEXTS: readonly Text[] = [
  { name: "Apache-2.0", ids: ["Apache-2.0"], all: [/apache license,? version 2\.0/] },
  { name: "MIT", ids: ["MIT"], all: [MIT_GRANT, MIT_NOTICE] },
  { name: "MIT-0", ids: ["MIT-0"], all: [MIT_GRANT], none: [MIT_NOTICE] },
  {
    name: "BSD-3-Clause",
    ids: ["BSD-3-Clause"],
    all: [BSD_GRANT, BSD_ENDORSE],
    none: [BSD_ADVERTISING],
  },
  { name: "BSD-2-Clause", ids: ["BSD-2-Clause"], all: [BSD_GRANT], none: [BSD_ENDORSE] },
  { name: "BSD-4-Clause", ids: ["BSD-4-Clause"], all: [BSD_GRANT, BSD_ADVERTISING] },
  { name: "ISC", ids: ["ISC"], all: [ISC_GRANT, ISC_NOTICE] },
  { name: "0BSD", ids: ["0BSD"], all: [ISC_GRANT], none: [ISC_NOTICE] },
  gnu("GPL-2.0", /gnu general public license version 2, june 1991/),
  gnu("GPL-3.0", /gnu general public license version 3, 29 june 2007/),
  gnu("LGPL-2.0", /gnu library general public license version 2, june 1991/),
  gnu("LGPL-2.1", /gnu lesser general public license version 2\.1, february 1999/),
  gnu("LGPL-3.0", /gnu lesser general public license version 3, 29 june 2007/),
  gnu("AGPL-3.0", /gnu affero general public license version 3, 19 november 2007/),
  { name: "MPL-2.0", ids: ["MPL-2.0"], all: [/mozilla public license,? version 2\.0/] },
  { name: "BSL-1.0", ids: ["BSL-1.0"], all: [/boost software license version 1\.0/] },
  {
    name: "Unlicense",
    ids: ["Unlicense"],
    all: [/this is free and unencumbered software released into the public domain/],
  },
  {
    name: "Zlib",
    ids: ["Zlib"],
    all: [
      /this software is provided as is, without any express or implied warranty/,
      /permission is granted to anyone to use this software for any purpose, including commercial applications/,
    ],
  },
  { name: "EPL-2.0", ids: ["EPL-2.0"], all: [/eclipse public license v 2\.0/] },
  { name: "PHP-3.01", ids: ["PHP-3.01"], all: [/the php license, version 3\.01/] },
  {
    name: "Python-2.0",
    ids: ["Python-2.0"],
    all: [/python software foundation license version 2/],
  },
  {
    name: "PostgreSQL",
    ids: ["PostgreSQL"],
    all: [
      /permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and without a written agreement is hereby granted/,
    ],
  },
  // Source-available licences, named so a note can say why a case is refused.
  { name: "Elastic-2.0", ids: ["Elastic-2.0"], all: [/elastic license 2\.0|elastic license v2/] },
  { name: "SSPL-1.0", ids: ["SSPL-1.0"], all: [/server side public license/] },
  { name: "BUSL-1.1", ids: ["BUSL-1.1"], all: [/business source license/] },
  {
    name: "Sustainable Use License",
    ids: ["LicenseRef-Sustainable-Use"],
    all: [/sustainable use license/],
  },
  { name: "Timescale License", ids: ["LicenseRef-Timescale"], all: [/timescale license/] },
  { name: "Commons Clause", ids: ["LicenseRef-Commons-Clause"], all: [/commons clause/] },
];

// One file's or one metadata field's reading: the licences it allows, or
// why it allows no conclusion.
interface Clear {
  from: string;
  ids: readonly string[];
  what: string;
  // Read from a licence text, not from package metadata.
  text: boolean;
}
type Reading = Clear | { from: string; unclear: string };

export function detectLicence(files: readonly RootFile[]): LicenceVerdict {
  const readings = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((f) => readFile(f));
  if (readings.length === 0) {
    return {
      licence: UNCHECKED_LICENCE,
      note: "licence not determined: no licence file at the root",
    };
  }
  const unclear = readings.flatMap((r) => ("unclear" in r ? [`${r.from}: ${r.unclear}`] : []));
  if (unclear.length > 0) {
    return { licence: UNCHECKED_LICENCE, note: `licence not determined: ${unclear.join("; ")}` };
  }
  const clear = lesserWithItsGpl(readings.filter((r): r is Clear => "ids" in r));
  const from = clear.map((r) => r.from).join(", ");
  let ids = clear[0]?.ids ?? [];
  for (const r of clear) ids = ids.filter((id) => r.ids.includes(id));
  const [id] = ids;
  if (ids.length > 1 || id === undefined) {
    const each = clear.map((r) => `${r.from}: ${r.what}`).join("; ");
    return {
      licence: UNCHECKED_LICENCE,
      note: `licence not determined: ${id === undefined ? `the files disagree (${each})` : `${ids.join(" or ")} (${from})`}`,
    };
  }
  if (!isAllowedLicence(id)) {
    return {
      licence: UNCHECKED_LICENCE,
      note: `licence ${id} (${from}) is not on ADR-0036's allowlist`,
    };
  }
  return { licence: id, note: `licence ${id} read from ${from}` };
}

// The LGPL is the GPL plus additional permissions, so a project under the
// LGPL ships both texts (COPYING and COPYING.LESSER); the GPL text then
// says nothing of its own.
function lesserWithItsGpl(readings: readonly Clear[]): Clear[] {
  const lesser = readings.some((r) => r.text && r.what === "LGPL-3.0");
  return readings.filter((r) => !(lesser && r.text && r.what === "GPL-3.0"));
}

function readFile(file: RootFile): Reading[] {
  if (METADATA.has(file.name)) return readMetadata(file);
  const text = normalize(file.text);
  const found = TEXTS.filter(
    (t) => t.all.every((re) => re.test(text)) && !(t.none ?? []).some((re) => re.test(text)),
  );
  const [only] = found;
  if (only === undefined) return [{ from: file.name, unclear: "text not recognised" }];
  if (found.length > 1) {
    return [
      { from: file.name, unclear: `several licences (${found.map((t) => t.name).join(", ")})` },
    ];
  }
  return [{ from: file.name, ids: only.ids, what: only.name, text: true }];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.,/]+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();
}

// The licence field of package metadata, an SPDX expression. Only a single
// id is read; a choice or a combination of licences is left to the vetter.
function readMetadata(file: RootFile): Reading[] {
  const value = metadataLicence(file);
  if (value === undefined) return [];
  if (!/^[A-Za-z0-9.+() -]{1,100}$/.test(value)) {
    return [{ from: file.name, unclear: "a licence field ocra does not read" }];
  }
  const ids = spdxIds(value);
  return ids
    ? [{ from: file.name, ids, what: value, text: false }]
    : [{ from: file.name, unclear: `"${value}" is not a single licence ocra reads` }];
}

function metadataLicence(file: RootFile): string | undefined {
  if (file.name.endsWith(".json")) {
    let data: unknown;
    try {
      data = JSON.parse(file.text);
    } catch {
      return undefined;
    }
    const license = (data as { license?: unknown } | null)?.license;
    if (typeof license === "string") return license;
    if (Array.isArray(license) && license.every((l) => typeof l === "string")) {
      return license.join(" OR ");
    }
    return undefined;
  }
  return (
    /^\s*license\s*=\s*"([^"\n]*)"/m.exec(file.text)?.[1] ??
    /^\s*license\s*=\s*\{\s*text\s*=\s*"([^"\n]*)"/m.exec(file.text)?.[1]
  );
}

// SPDX's deprecated GNU ids ("GPL-3.0", "GPL-3.0+") are what authors often
// write; without the suffix, "-only" is not taken for granted.
function spdxIds(value: string): readonly string[] | undefined {
  const id = value.trim();
  const gnuId = /^((?:A|L)?GPL-\d\.\d)(\+)?$/.exec(id);
  if (gnuId?.[1])
    return gnuId[2] ? [`${gnuId[1]}-or-later`] : [`${gnuId[1]}-only`, `${gnuId[1]}-or-later`];
  if (/\s/.test(id) || id.endsWith("+")) return undefined;
  const known = TEXTS.flatMap((t) => t.ids);
  return known.includes(id) ? [id] : undefined;
}
