---
"@open-cr-agent/cli": minor
---

### Changed

- The container image runs `ocra` as its entrypoint (`docker run <image> review …`; the 0.2.0 form `docker run <image> ocra review …` still works). A GitLab job using the image sets `entrypoint: [""]`.
