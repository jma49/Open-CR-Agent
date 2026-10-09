---
"@open-cr-agent/core": patch
---

### Fixed

- A rate limit that states no wait, as Vertex AI's shared quota sends when busy, pauses the model for 15, 30, then 60 seconds instead of dropping it for the run.
- A limit that says "per-day" (OpenRouter's free models) counts as a daily limit.
