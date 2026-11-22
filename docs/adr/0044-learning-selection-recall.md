# ADR-0044: Learning selection reads paths and names the way people write them

- Status: accepted
- Date: 2026-11-22

## Context

ADR-0037 point 4 matches a learning's `paths` as literal globs, its `symbols` as literal identifiers and its `keywords` word by word, and ranks a path match above any symbol match. A replay of 46 changes (`core/src/knowledge/recall-cases.fakes.ts`) found 11 the selection missed: `*.sql`, `Dockerfile` and `services/payments/` match nothing below the root; `createCharge` misses `create_charge` in a Python service; `pool.connect` misses `pool?.connect()`; `retry` misses "retries"; a Chinese keyword misses a Chinese comment, which has no spaces between words. Among many learnings on one directory, a learning whose symbol the change uses lost to learnings matched by the path alone and was not even listed.

## Decision

Amends ADR-0037 point 4.

1. **Paths follow `.gitignore`:** a pattern without a slash matches at any depth, a directory matches what is under it, a leading `/` or `./` anchors it to the root, and case is ignored (`core/src/knowledge/paths.ts`).
2. **A symbol of two words or more matches in any naming convention** (`createCharge`, `create_charge`, `CreateCharge`, `CREATE_CHARGE`), and member access matches as `.` whether written `?.`, `!.`, `->` or `::`. A one-word symbol stays literal and case-sensitive, so `USER` is not `user`.
3. **A keyword matches its plural and its singular,** and a keyword token in a script written without spaces (Han, Hiragana, Katakana, Thai) matches anywhere in the patch.
4. **Evidence ranks before a bare path:** a critical learning whose path matches; then a path match with a symbol or keyword in the patch; then a symbol alone; then a path alone; then a keyword alone. Within a rank, more symbols, more keywords and more title terms come first, then the id.
5. **The replay gates more than recall** (`select-recall.test.ts`): at least 95% of the needed learnings given, every one given or listed, none labelled unrelated given, and a ratchet on the mean tokens learnings add to a prompt. A repository whose paths each hold ten learnings must still give every needed learning the change has a symbol or keyword of. Property tests (`select-properties.test.ts`, fast-check) hold for any learnings and bundle: order does not matter, limits hold, every candidate is given or left, learnings that match nothing change nothing.

## Consequences

- Recall on the replay goes from 78% to 100%; where each path holds ten learnings, from 61% to 86% given and 69% to 90% given or listed. The learnings add 54 tokens to a prompt on average, up from 46, for the learnings that were missed.
- `*.sql` in a hand-written learning now matches every SQL file, as its author meant; `ocra learn` already writes `dir/**` and is unaffected.
- Many learnings on one path with no symbol or keyword in the change still tie and are broken by id; past the listing they are only counted. Symbols from the code graph remain the planned remedy (ADR-0037).
