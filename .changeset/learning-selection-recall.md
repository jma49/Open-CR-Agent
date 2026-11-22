---
"@open-cr-agent/core": patch
---

### Fixed

- Learning paths read like `.gitignore`: `*.sql` and `Dockerfile` match at any depth, `dir/` matches what is under it, a leading `/` anchors to the root, and case is ignored.
- A learning's compound symbol matches in any naming convention (`createCharge`, `create_charge`) and member access written `?.`, `->` or `::`; keywords match plurals and Chinese or Japanese text without spaces.
- A learning whose symbol the change uses is no longer crowded out by learnings that only share its path.
- `ocra learn` gives a learning drafted from a fix that moved a file both the old and the new directory.
