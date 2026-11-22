---
name: update
description: "Explicit V3 semantic verification and sync of existing llmdoc knowledge against the current repository."
argument-hint: "[summary] [--scope <topic|path...>] [--reflection [<candidate...>]]"
---

# /llmdoc:update

Use this command when codebase changes require `llmdoc/` knowledge to be verified or synchronized. Works in Git repositories, non-Git directories, and multi-repo federated workspaces.

Load the `llmdoc` skill before broad exploration. Run CLI commands directly as `llmdoc <cmd>`.

## Authorization

An explicit `/llmdoc:update` invocation authorizes this run to:

- read workspace state and existing llmdoc docs
- write impacted `llmdoc/` documents and update the `meta.json` ledger via CLI
- write temporary investigation reports under `.llmdoc-tmp/investigations/`
- read and resolve declared reflection candidates under `.llmdoc-tmp/reflections/`

This command does not authorize source-code edits.

## Preconditions

- Before rewriting existing docs, record the original write-set (or rely on CLI transactions such as `mv`, which back up to `.llmdoc-tmp/txn/` and roll back automatically).
- If `validate` fails after writes and cannot be repaired in-run, restore the touched `llmdoc/` files (and delete newly created docs) before reporting failure; never leave a broken knowledge surface behind.

## Workflow

1. Measure the current doc state.
   - Run `status`.
   - Run `delta` with any explicit scope flags.
   - Read each explicitly declared `--reflection` candidate. When the flag has no paths, read all Markdown candidates directly under `.llmdoc-tmp/reflections/pending/`. A pending candidate is an update signal even when code delta is empty.

2. Gate reflection candidates before promotion.
   - Require a verifiable trigger, wrong assumption or action, root cause, preventive rule, scope, confidence, and existing-doc match.
   - Verify workspace claims against code, tests, or stable docs. User corrections prove intent, not repository facts.
   - Reject transient tool failures, one-task preferences, and unverified speculation. Use `search` and targeted `show` to find an existing owner before creating a document.

3. Choose the lightest sufficient path from delta plus any qualified candidates.
   - Light: owners are mapped and facts are clear.
   - Deep: files are unmapped, owner/root cause is unclear, boundaries changed, facts conflict, or impact is broad.
   - This choice controls evidence gathering only. It does not decide whether prose must change.
   - For unmapped or moved code and boundary changes, read [Knowledge Topology and Context Floor](../llmdoc/references/knowledge-topology.md) and classify each surface as missing mapping, missing owner, or intentional no-doc.

4. Decide the semantic outcome with `recorder`.
   - Treat `delta` and candidates as review evidence, not a write list or prose to copy.
   - Rewrite only false/incomplete claims or new conclusions that pass the Stable Knowledge Gate. Reflection candidates must pass both gates.
   - Gate prose and routing independently; true prose may still need routing metadata repair.
   - If the document remains true and the change adds only reconstructable evidence, mark it verified unchanged.
   - Light: `recorder` decides from targeted CLI reads. Deep: `investigator` reports evidence, then `recorder` applies the gate.
   - Scaffold brand-new docs with `new`; register docs that already exist as files with `adopt <path...>` — never hand-edit `meta.json` or recreate the file through `new`.

5. Finalize.
   - If document identities changed, read [Startup Configuration](../llmdoc/references/startup-config.md). `mv` rewrites renames without Git; sync manual merges/deletions before validation.
   - Run `validate`; after mapping/boundary changes, also run scoped routing acceptance.
   - Run `finalize --verified <path...>` (or `finalize --all` for full sync) to validate, record `llmdoc.meta/v4` digests, and clean orphan entries without Git.
   - In Git repos, optionally run `commit -m "<message>" [--verified <path...> | --all]` to finalize and land docs + `meta.json` in one commit (add `--require-clean` to require committed source).

6. Fold durable lessons into stable docs directly.
   - Put reusable cautions, invariants, and workflow fixes into the relevant architecture or guide docs.
   - Reflection candidates are a temporary evidence queue, not a tracked reflection kind or a second knowledge tree.
   - On `success`, resolve consumed candidates. On `no_change`, resolve only already-covered or rejected candidates. Leave them pending after `incomplete` or `failed`.

## State Invariants

- Full successful updates (`--all`) advance the workspace baseline surface digest.
- Scoped updates (`--verified`) update only per-document content digests, not the global baseline.
- Update never changes convergence state. If growth requires convergence, finish update and ask once before running the separate prune workflow.

## Result Contract

- `success`: the declared scope was semantically verified, any necessary prose changes were written, and applicable content digests advanced via `finalize` (or optional `commit`).
- `no_change`: the declared scope was already current, so neither prose nor digest state needed to change.
- `dry_run`: the user asked for a dry run, or only status/delta/investigation/planning output was produced without writing `llmdoc/`; do not advance state.
- `incomplete`: evidence was insufficient, user input is required, or the scope belongs to a different explicit maintenance workflow; roll back writes and do not advance state.
- `failed`: update failed and doc writes were rolled back.

Always report:

- the chosen path (`light` or `deep`) and why
- the `status` and `delta` signals used
- any investigation report path
- each reflection candidate and its disposition (`promoted`, `already_covered`, `dismissed`, or `pending`)
- the stable docs changed and the docs verified unchanged by `recorder`
- routing classifications and checks when topology changed
- the `finalize` (or optional `commit`) result — validate gate and content-digest refresh — or why finalization was skipped
