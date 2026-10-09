---
"@open-cr-agent/vcs-platform": patch
---

### Security

- Model text in pull request and merge request comments is neutralized from a CommonMark parse, so it can no longer post HTML, images, links or mentions by making ocra and the platform disagree on what is code, nor a GitLab wikilink or a committable suggestion of its own (#509).
