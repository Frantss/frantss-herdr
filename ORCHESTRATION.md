# Orchestration

## Delegation

- Before starting or controlling workers, read and follow the installed manual with `hc --skill` for worker lifecycle rules. If `hc` is unavailable, try `herdr-core --skill`; if neither exists, report the blocker.
- Give each worker its goal, context, constraints, owned files, completion criteria, and the coordinator's reporting address. Run independent tasks concurrently with separate edit ownership; coordinate shared files and dependencies.
- Require a concise report with evidence references, verification results, and unresolved issues. Check consequential conclusions against evidence, inspect edits, and integrate results before reporting completion.
- If a worker stalls or fails verification, narrow its task or move it to a stronger model.

## Model routing

These are strong recommendations. Prefer task fit and verified results; briefly explain material departures. Sol is the default when no category fits.

| Task category                                                        | Preferred model                          | Reasoning effort                                                                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default implementation, debugging, coordination, review              | GPT-6.1 Sol (`gpt-6.1-sol`)              | Medium; High for difficult bugs, architectural decisions, or large impact.                                                                                   |
| UI implementation, visual design, interaction, polish                | Claude Opus 5.5                          | Native adaptive/default; increase supported effort for complex interactions or design tradeoffs.                                                             |
| Extensive repetitive refactors with a clear specification            | Available free coding models in OpenCode | Native default; increase supported effort for nontrivial transformations. Sol High for planning/review requiring substantial behavior-preservation judgment. |
| Writing, screenshot interpretation, browser/computer tasks           | GPT-6.1 Terra (`gpt-6.1-terra`)          | Low for straightforward work; Medium for ambiguous visuals or synthesis across sources.                                                                      |
| Focused coding, extraction, classification, repeated transformations | GPT-6 Luna (`gpt-6-luna`)                | Start High; use Sol for broader judgment.                                                                                                                    |
| Small lookups, file discovery, short summaries, simple checks        | Claude Haiku                             | Native default; stronger model for substantial judgment.                                                                                                     |
| Bounded features, tests, routine reviews                             | Claude Sonnet                            | Native default/adaptive; increase supported effort for multi-step reasoning.                                                                                 |

## Availability and reasoning controls

- Before dispatch, discover current model IDs and availability. Explicitly select the harness, model, and supported reasoning setting using its current help. Use current Haiku/Sonnet versions. If a preferred model is unavailable, choose the closest suitable available model and report the substitution; Sol is the general fallback.
- For OpenCode, use `opencode models`. When selecting a free model, verify pricing in the current provider catalog and suitable coding/tool support. Verify status-reporting integration before relying on automatic worker status.
- Low/Medium/High are model-specific. Use supported controls or native defaults; Anthropic thinking controls are not OpenAI effort flags. Increase reasoning up to High for ambiguity, difficult diagnosis, or competing constraints; file count alone is insufficient. Never use Extra High or equivalent maximum reasoning effort, or accelerated modes such as Fast, Turbo, or priority processing. Use standard speed.
