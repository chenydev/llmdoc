# Startup and Workspace Configuration

Read this reference when configuring SessionStart guidance, preload documents, local ledger storage, external `docsDir`, or federated `codeRoots`, or when a workflow renames, merges, or deletes a document named in startup preload.

## File and schema

Place the optional `llmdoc.config.json` at the workspace root. Root discovery priority is:

`--root` / `LLMDOC_ROOT` > ancestor `llmdoc.config.json` (crossing nested sub-repo `.git`) > ancestor `llmdoc/` > nearest `.git` root (for `new` only; falls back to current directory without Git).

```json
{
  "$schema": "https://llmdoc.tokenroll.ai/schemas/config.schema.json",
  "schema": "llmdoc.config/v1",
  "docsDir": "llmdoc",
  "codeRoots": [
    { "name": "api", "path": "./repos/api" },
    { "name": "web", "path": "./repos/web" }
  ],
  "state": {
    "location": "tracked"
  },
  "startup": {
    "remindSkill": true,
    "preload": [
      "architecture.mdx",
      "api-client/contracts.mdx"
    ]
  }
}
```

- `docsDir` (optional): defaults to `llmdoc`. May point to a custom relative or absolute directory (overridable via `--docs-dir` or `LLMDOC_DOCS_DIR`).
- `codeRoots` (optional): multi-repo federated code roots (strings or `{ name, path }` entries). When omitted, the workspace root is the single code root (and pure filesystem scanning still traverses nested sub-repos cleanly).
- `state.location` (optional): `"tracked"` (default, writes `<docsDir>/meta.json`) or `"local"` (writes to `.llmdoc-tmp/meta.json` by default, or `~/.local/state/llmdoc/<workspace-id>/meta.json` when `state.localPath` is `"user"`).
- `startup.remindSkill` defaults to `true`. Set it to `false` only when the workspace deliberately supplies equivalent operating guidance elsewhere or wants no proactive reminder.
- `startup.preload` contains exact `.mdx` document IDs in declaration order. An entry may include the `llmdoc/` prefix.
- Cold SessionStart injects configured bodies directly and has no llmdoc character or token budget. A final completion marker distinguishes a complete preload from host-side truncation; if it is absent, retrieve only the missing body with `show`.
- Compact re-entry lists configured document IDs without injecting the bodies again. Use the compacted `LLMDOC_STATE` first and retrieve a body only when needed.

## Validation and degradation

Run `validate` after creating or editing the file. Invalid JSON or schema cannot preserve field intent, so hooks use the default reminder and skip preload. When the schema is valid but a preload path is invalid or missing, hooks preserve the valid `remindSkill` choice and skip the preload field. Entries that normalize to the same document are deduplicated with a warning.

## Structural changes

A preload entry is a persistent reference and must stay synchronized with document identity:

- `llmdoc mv` rewrites matching preload entries transactionally (via `.llmdoc-tmp/txn/`, no Git required) along with document references and the ledger.
- Before a prune workflow manually merges or deletes documents, inspect the report's startup preload references and update or remove affected entries in the same write set.
- After any manual path change, run `validate` before `finalize` / `commit`. A missing preload target is an error and intentionally blocks finalization.

Do not create this file during init unless the user or workspace requirements call for non-default startup behavior, preload, local state, external docs, or multi-repo code roots.
