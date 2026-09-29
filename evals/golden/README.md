# Golden cases

ocra's own evaluation cases (ADR-0011, `docs/adr/0011-golden-eval-set.md`), one `<id>.json` file each. Files with `tier: "adversarial"` are attacks: they plant hostile text in the case they name (ADR-0014) and run only with `--tier adversarial`. The format is in the user manual's evaluation page; `ocra-eval list --dataset golden` validates every file. Biome skips these files: `ocra-eval adjudicate` rewrites them with `JSON.stringify`, and the schema, not the formatter, checks them.
