---
"@open-cr-agent/cli": patch
---

### Changed

- The repository moved to `ocrahq/Open-CR-Agent`. `ocra init` writes the Action as `ocrahq/Open-CR-Agent@<commit>` and links there; workflows that name `jma49/Open-CR-Agent` keep working through GitHub's redirect. Container images from the next release on are `ghcr.io/ocrahq/ocra`; images up to 0.17.0 stay at `ghcr.io/jma49/ocra`.
