---
name: llmdoc
description: >-
  Default V3 operating skill for llmdoc-enabled projects. Route discovery —
  exploring the codebase, locating a concept or contract, judging the blast
  radius of a change — through the llmdoc CLI instead of broad file crawling.
allowed-tools: 'Read, Glob, Grep, Bash, Write, Edit, WebSearch, WebFetch'
---

# /llmdoc

Use the CLI to retrieve durable architecture, constraints, and working agreements from `llmdoc/` workspaces (Git or non-Git). Run commands with the installed `llmdoc <cmd>` binary.

## Retrieval Gate

Apply this gate before the first discovery action of a task, and again whenever investigation crosses into a new subsystem. Choose the one entry point that matches the intent:

| Intent | Entry point |
|---|---|
| Concept, contract, term, "where is X?" | `search <query>` |
| Background or blast radius of concrete source files | `context --files <path...>` |
| Cold start, unclear scope | `tree` |
| Known topic or document kind | `index --topic <topic>` / `--kind <kind>` |
| Bodies of documents already identified | `show <path...>` |

The gate guards broad native discovery: recursive or cross-directory exploration with Read, Grep, Glob, or shell outside a working set llmdoc has already narrowed.

Once llmdoc has narrowed that working set, native tools own the exact facts — source text, line numbers, test behavior, counts, workspace state. The knowledge surface deliberately does not duplicate those.

These entry points are alternatives, not a sequence. Stop as soon as the task has enough context; that permission applies after choosing an entry point, never instead of choosing one.

`status` and `delta` are not retrieval. Use them to assess content-digest staleness or to prepare `/llmdoc:update`, where `delta` decides light vs deep.

## CLI Invocation

Invoke the locally installed fork CLI directly as `llmdoc <cmd>`.

- Never add llmdoc to the project's `package.json` or lockfile, and never invoke `npx llmdoc` or upstream npm packages.
- Use `--root` / `LLMDOC_ROOT` or `--docs-dir` / `LLMDOC_DOCS_DIR` for external roots.
- If `llmdoc` is unavailable on PATH, note the degraded path and continue with scoped native tools.

## Operating Rules

- Reuse `LLMDOC_STATE` across continuation; do not replay prior reads unless evidence or scope changed.
- Put scratch notes in `.llmdoc-tmp/`, not stable docs.
- Stable `llmdoc/` writes belong to `recorder`; ledger updates (`meta.json`, tracked or local) go through CLI only (`new`, `adopt`, `mv`, `fingerprint`, `finalize`, `commit`). Register existing `.mdx` files via `adopt <path...>`, never recreate through `new`.
- Align with the user before non-trivial edits.
- If `llmdoc/` does not exist, suggest `/llmdoc:init`; do not fabricate docs ad hoc.
- Delegate needed `/llmdoc:update` alongside verification; finalize only after verification passes.
- For topology/routing, read [Knowledge Topology](references/knowledge-topology.md).
- For SessionStart, preload, local state, or multi-repo roots, read [Startup Configuration](references/startup-config.md).
- Never suggest `/llmdoc:upgrade` unless explicitly requested.

## Reflection Gate

Strong reflection signals expose a reusable project or workflow lesson:

- the user corrects an assistant assumption or action
- verification proves the chosen approach wrong
- substantial rework, rollback, or an instruction violation occurs
- a missing project signal would likely prevent recurrence

Skip transient tool failures, trivial typos, speculation, and one-task preferences unless marked durable.

On a strong signal, continue the task and give `reflector` compact evidence while context is fresh. It writes a privacy-safe candidate under `.llmdoc-tmp/reflections/pending/`, never the transcript or tracked knowledge. A pending candidate triggers update review even with no source delta. At task end, name the lesson and ask once to run `/llmdoc:update --reflection <path>`; wait for authorization.

## Continuation State

On compact or resume, keep `LLMDOC_STATE` small and practical:

- active goal
- documents already read
- key conclusions and invariants
- user decisions and constraints
- next action
- open risks or unknowns
- pending lesson candidates, if any

If that state is still sufficient, continue without re-running `tree`, `index`, or prior `show` reads.

## Roles

- `investigator`: current-state research, scoped evidence gathering, scratch reports under `.llmdoc-tmp/`
- `reflector`: turns strong corrections, verified mistakes, and major rework into structured candidates under `.llmdoc-tmp/reflections/pending/`
- `recorder`: the only writer of tracked `llmdoc/` knowledge
