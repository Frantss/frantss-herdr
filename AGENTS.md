# Agents

## Coding standards

1. **YAGNI**: Do not build it until it is needed.
2. **DIE**: Extract duplicated patterns when a shared implementation simplifies maintenance.
3. **KISS**: Build the obvious solution first. Optimize when measurements or explicit requirements show a need.
4. **SOLID**: Check your solutions against the 5 SOLID principles.
5. **Delete aggressively**: Remove code that you can verify is unused or unnecessary for required behavior. Aim for simplicity.
6. **The Boy Scout Rule**: Refactor as needed. If the refactor is out of scope, report the opportunity.
7. **Semantic naming**: Use self-documenting names. Prefer descriptive, unambiguous names over abbreviated names.
8. When these coding standards conflict, prefer the simplest approach. Justify added complexity in terms of task requirements or project constraints.

## Communicating

- Use clear English guided by ASD-STE100.
- Avoid preamble.
- Start each response with a direct answer to the user's request.
- End each response with brief **Goal**, **Done**, **Next**, and **Needs you**. Drop each if nothing to show.

## Autonomy

- Weigh blast radius. After approval, proceed with small, reversible changes. Present a proposal before requesting approval for architectural or cross-cutting changes.
- Request approval before running any action with side effects.
- After approval, fix encountered bugs directly related to your work and report the fixes afterwards. Apply the same proposal requirement to architectural or cross-cutting bug fixes.

## Context management

- Keep the main context focused on the goal, constraints, decisions, and integration.
- When sub-agents are available and permitted, delegate bounded research, code exploration, implementation, reviews, and output-heavy checks. Handle trivial operations directly when delegation adds more overhead than it removes.
- Give each sub-agent a clear goal, relevant context, constraints, and completion criteria. Pass only the context needed for its task.
- Require a concise summary of results, evidence references, verification outcomes, and unresolved issues. Keep detailed searches, logs, and intermediate output in the sub-agent's context.
- Verify consequential conclusions against the referenced evidence. Read additional details when needed to resolve uncertainty or integrate changes.
- Give concurrent sub-agents separate edit ownership. Coordinate work that depends on shared files or results.

## Proposing solutions

- Propose at least two viable approaches.
- For each viable approach, state how the change can be verified once implemented.
- For each viable approach, state the **risks** it poses and how to mitigate them.
- Briefly state rejected approaches.
- When only one viable approach exists, present that approach without manufacturing alternatives. Still explain verification and risks, and check the approach against our coding standards.
- Check your proposal against our [coding standards](#coding-standards).

## Before changing code

- Read the relevant module documentation and code.
- Identify the intended behavior and constraints that must remain as is.

## Before reporting completion

- If code was written, check it against our [coding standards](#coding-standards).
- Run checks proportional to the change. Report their results and explain any skipped checks.
- Collect evidence of the changed behavior and identify any remaining limitations.
- Apply the [documentation rules](#writing-documentation) to the change.

## Writing documentation

- Change documentation only when requested or needed for a concrete reader task. Identify the missing or incorrect guidance before writing; otherwise leave documentation unchanged.
- Include only what enables that task. Keep implementation summaries, test inventories, and run results in the task report unless needed for continued use or maintenance.
- Prefer updating the relevant existing document. Keep each fact in one place and avoid restating details already clear from code or configuration.
- Remove obsolete or redundant text in documentation you touch.

## Git & GitHub

- Use conventional commits (`feat:`, `chore:`, `docs:`, ...).
- Keep the commit's subject on one line.
- When committing, give each commit one purpose. Include the implementation, tests, and documentation required for that purpose. Put independent changes in separate commits.
- When both tools support the operation, prefer `gh` over `git`.
