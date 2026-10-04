# ADR-0025: Models and reasoning effort per agent, set in the repository or in ocra Cloud

- Status: accepted
- Date: 2026-10-04

## Context

ocra's model layer is the multi-agent pipeline: reviewers (correctness, security, performance, docs, AGENTS.md, and any a plugin adds), a verifier, a judge, and helper calls (grouping files, relocating quotes). Today a model is chosen per tier only (`models.top`, `models.standard`, `models.light`), each agent is bound to a tier in code (correctness, security and performance use `standard`; docs and AGENTS.md `light`; the verifier `standard`; the judge `top`; helpers `light`), and configuration can only turn a reviewer off or move the risk tier it starts at. There is no notion of reasoning effort, although most current models take one (OpenAI-style `reasoning_effort`, Anthropic's thinking budget, Gemini's thinking level or budget, OpenRouter's `reasoning.effort`), and effort trades cost and latency for recall as much as the choice of model does.

The maintainer asked (2026-10-04) for ocra Cloud to let a user choose the runtime and, per agent, the model and the effort level, with the levels limited to what the model supports.

## Decision

**1. One vocabulary of agents.** The agents a user can configure are the reviewer ids (built-in and plugin), plus three roles: `verifier`, `judge` and `helper` (grouping files and relocating quotes, nothing else). A reviewer's settings cover every call made on its behalf: its review tasks and its plan call. The verifier and the judge never inherit a reviewer's settings, so checking stays independent of what was checked. The tier binding stays the default: an agent with no settings uses its tier's chain, so every existing configuration means what it meant.

**2. Configuration (the open engine), all optional:**

```json
{
  "effort": { "standard": "medium", "top": "high" },
  "reviewers": {
    "security": { "models": ["anthropic/claude-sonnet-5-5"], "effort": "high" },
    "docs": { "enabled": false }
  },
  "roles": {
    "judge": { "models": ["openai/gpt-5.5"], "effort": "high" },
    "helper": { "effort": "minimal" }
  }
}
```

- `reviewers.<id>` gains `models` (one model or a failback chain, like a tier) and `effort`, beside `enabled` and `minTier`.
- `roles.<verifier|judge|helper>` takes `models` and `effort`.
- `effort.<tier>` sets a tier's default effort.
- Effort is one of `none`, `minimal`, `low`, `medium`, `high`. Resolution for a call: the agent's effort, else its tier's, else unset. Unset sends nothing (the provider's default); `none` turns reasoning off where a provider can say so (OpenAI `none`, a Gemini budget of 0, Anthropic thinking absent) and is otherwise dropped with a warning.
- **Effort and sampling do not mix.** When an effort other than `none` is sent, the call sends no `temperature` or `seed` (OpenAI's reasoning models reject a temperature; Anthropic's thinking requires temperature 1 and no top_p), and provenance lists them as not applied.
- The report's provenance gains `agents.<id>: { models, effort, applied }`, the resolved chain and level and what the runtime actually sent; the configuration hash covers them, so evaluation runs stay comparable (provenance as in ADR-0018). `--plan` prints the resolved model and effort per task.

**3. The runtimes map one level to each provider's parameter, and never fail a review over it.**

- `direct`: sends `reasoning_effort` (OpenAI's Chat Completions field, also accepted by the Gemini API's OpenAI-compatible endpoint and by OpenRouter). A declared provider may set `"effort": "openrouter"` to send `reasoning: { effort }` instead. An HTTP 400 that names the effort parameter is retried once without it, recorded as not applied: it is not a model failure and does not move the chain.
- `opencode`: sets the model's provider options in the OpenCode configuration it writes: `reasoningEffort` for OpenAI; a thinking budget for Anthropic (at least 1,024 tokens and below the model's output limit, derived per level from that limit) and for older Gemini models; `thinkingLevel` for the newest Gemini models. Two agents on one model at different levels get one model alias per (model, level) pair. This half is built after the `direct` one.
- **A capability table lives in core:** model pattern to parameter style and the levels it takes. Runtimes use it to map a level; ocra Cloud imports it from the published package and overlays OpenRouter's live `supported_parameters`. A level the table says a model cannot take is dropped with one warning per run naming the agent and model; the engine never refuses a review on the table's account, since the table goes stale as models ship.

**4. ocra Cloud stores the same settings per account and the CLI applies them as defaults.** The web's Agents page shows the runtime (`direct` or `opencode`), and for each agent: on or off, the model chain (models of providers whose key the account holds), and the effort, offering only the levels the chosen model supports: OpenRouter lists `reasoning` among a model's supported parameters; for other providers the page offers low, medium and high for models a static table knows reason, and nothing for the rest. Plugin reviewers the page cannot know appear once a review's provenance has named them, read-only until then. The CLI fetches the settings with the session (ADR-0024) and layers them **under** the repository's configuration: a key the repository sets wins, a key it leaves out takes the account's value, and the built-in default comes last. A pull request review still reads the base commit's configuration (ADR-0013).

**5. Policy and security.** An organization policy (ADR-0022), when it exists, caps all of these: its `models.allow` applies to every chain (`models.*`, `reviewers.*.models`, `roles.*.models`), and it gains `effort.max`. A per-agent model can name only providers already reachable (providers declared in trusted configuration, catalog providers with keys in the environment, or the gateway's server-fixed list), so this opens no new path for code to leave; the new lever is cost, bounded by `maxCostUsd`, the policy and the gateway's daily cap.

## Consequences

- One review can mix models: a strong model with high effort for security on a sensitive change, a cheap one for docs, a small one for helpers. Cost control stays per run (`maxCostUsd`), and the per-agent provenance makes the cost of each choice visible in reports and in ocra Cloud's statistics.
- Prompts, rules and reviewers are unchanged: this changes which model runs an agent, not what the agent is asked, so it needs no eval to merge. Changing the shipped defaults (for example a default effort) does, under the evaluation rule.
- The configuration schema, the manual (en, zh) and the JSON report schema change; existing files keep working.
- The capability table goes stale as models ship; the engine only warns on its account, and ocra Cloud overlays live data where a provider publishes it.
- No eval is needed to merge, but the acceptance test is a dogfood run with effort set on the `direct` runtime (and, when built, one Anthropic model through OpenCode), since no fake proves a provider accepts the parameter.
- Order: (1) effort per tier, reviewer and role on the `direct` runtime, with the sampling rule, the retry without the parameter, per-agent provenance and `--plan` output; (2) per-agent model chains; (3) the OpenCode mapping; (4) the web's Agents page; (5) `effort.max` in the policy and a per-agent cost estimate in `--plan`.

Reviewed with Claude Fable 5.1: accepted with the sampling rule, the plan-call scope, the retry without the parameter, the policy cap on every chain and an engine-resident capability table.

## Alternatives considered

- **Effort per tier only.** Simpler, but the ask is per agent, and the tier is a proxy: security on a sensitive diff deserves more thought than performance on the same diff.
- **A free-form `providerOptions` object per agent.** Maximally flexible, but it ties configuration files to one runtime's and one SDK's option names, and a level vocabulary is what the web page can offer safely.
- **The cloud overriding the repository.** Rejected: a team's committed configuration must mean the same on every machine; personal defaults fill gaps only.
