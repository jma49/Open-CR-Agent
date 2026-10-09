---
"@open-cr-agent/vcs-local": patch
"@open-cr-agent/core": patch
---

### Security

- Range, commit and pull request reviews read `.gitattributes` from the base commit (git 2.41 or later), so the reviewed change cannot mark its own files binary to keep them from review.
- A file whose name says text but that was skipped as binary gets a warning.
- git runs with only the environment variables it needs: model keys and platform tokens no longer reach it, except the tokens credential helpers read when ocra fetches a pull request's commits.
