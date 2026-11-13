# @z1/prompt

Deterministic composition of the z1 system prompt. Pure functions: no I/O, no
model calls, no dependencies.

## Sections

A prompt is a list of `PromptSection`s. Each one is a stable `id`, a `slot`, a
`priority`, an optional `required` flag, and a markdown `body`:

```ts
import { stackSections } from '@z1/prompt'

const result = stackSections(
  [
    { id: 'core.identity', slot: 'core', priority: 0, required: true, body: 'You are z1.' },
    { id: 'task.current', slot: 'task', priority: 0, body: 'Implement {{task.id}}.' },
  ],
  { task: { id: 'T32' } },
)
```

Order is fixed by slot (`core → role → task → context → contract → custom`),
then `priority` ascending, then `id`. Duplicate ids keep the first section in
that order, so a caller-supplied section can replace a default by sorting before
it rather than by mutating the defaults. Bodies render `{{dotted.path}}`
placeholders (array indices allowed, objects and arrays JSON-stringified,
missing values empty, prototype keys blocked); whitespace-only sections are
skipped and the rest are joined with a blank line, verbatim.

## Roles

`buildPrompt` starts from `DEFAULT_SECTIONS` (the z1 core prompt), appends one
role delta from `ROLE_SECTIONS` (`planner`, `coder`, `reviewer`, `summarizer`,
`judge`, `router`; `coder` is the default and adds only a two-line note), then
appends any extra sections:

```ts
import { buildPrompt } from '@z1/prompt'

const prompt = buildPrompt({
  role: 'reviewer',
  vars: { graph_ports: '- findings (data)', autonomy: 'ask', memory: envelope },
  sections: [{ id: 'task.diff', slot: 'task', priority: 0, body: diff }],
  budgetTokens: 6000,
})
```

## Budget

`tokens` is `ceil(chars / 4)` per section. Over `budgetTokens` (default 6000),
optional sections are dropped from the lowest priority upward — ties drop the
later slot, then the later id. `required` sections are never dropped; if they
alone exceed the budget the stack renders anyway and reports the real total.

## Hash

`result.hash` is the SHA-256 of the canonical JSON of the ordered, rendered
`{id, slot, priority, required, text}` list. It ignores input order, so it is a
cache key and an audit anchor: store it with the message or journal entry to
prove which prompt text produced a run, and compare it to detect drift after a
template edit. `sectionHash(section)` is the same idea for a single definition
and is useful for per-section change detection.

`PROMPT_VERSION` names the current default text; bump it when the core changes
in a way that should invalidate stored prompts.
