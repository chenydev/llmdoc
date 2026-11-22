import fs from "node:fs";

import { CliError } from "../lib/errors.js";
import { findProjectRoot } from "../lib/fs.js";
import { isDirectGitRoot } from "../lib/git.js";
import { createInitialMetaLedger, persistMetaAndSnapshots } from "../lib/state.js";
import { loadWorkspace } from "../lib/workspace.js";
import type { WorkspaceResolutionOptions } from "../types.js";

interface InitStateOptions extends WorkspaceResolutionOptions {
  cwd: string;
  json?: boolean;
}

/**
 * Creates the initial `llmdoc.meta/v4` ledger (all docs start with `codeDigest: null`).
 * Works identically in Git repos, unborn branches, non-Git directories, and multi-repo workspaces.
 */
export function runInitState(options: InitStateOptions): unknown {
  const rootDir = findProjectRoot(options.cwd, options);
  const workspace = loadWorkspace(rootDir, options);
  if (workspace.meta || fs.existsSync(workspace.metaPath)) {
    throw new CliError(
      `${workspace.metaDisplayPath} already exists; init-state creates only the initial ledger and never overwrites it.`
    );
  }

  const { meta, surface, headRevision } = createInitialMetaLedger(workspace);
  persistMetaAndSnapshots({
    workspace,
    meta,
    surface,
    updatedDocPaths: [],
    advanceBaseline: true
  });

  const isGit = isDirectGitRoot(rootDir);
  const nextCommand = isGit
    ? 'llmdoc validate && llmdoc commit --all -m "docs: bootstrap llmdoc"'
    : "llmdoc validate && llmdoc finalize --all";

  if (options.json) {
    return {
      status: "success",
      schema: "llmdoc.meta/v4",
      documents: workspace.documents.length,
      baselineDigest: meta.baseline.surfaceDigest,
      baselineRevision: headRevision,
      metaPath: workspace.metaDisplayPath,
      next: nextCommand
    };
  }

  const digestPreview = meta.baseline.surfaceDigest ? meta.baseline.surfaceDigest.slice(0, 19) : "none";
  const revSuffix = headRevision ? `, git hint ${headRevision.slice(0, 7)}` : "";
  return `initialized ${workspace.metaDisplayPath}: ${workspace.documents.length} documents (codeDigest: null), baseline ${digestPreview}${revSuffix}\nnext: Run \`${nextCommand}\`.`;
}
