---
"@open-cr-agent/cli": minor
---

### Removed

- The container image no longer drops a leading `ocra` from its arguments: run `docker run <image> review …`, not `docker run <image> ocra review …` ([Installation](https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/installation.mdx#container-image)).
