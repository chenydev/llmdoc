import { CliError } from "../lib/errors.js";
import { findProjectRoot } from "../lib/fs.js";
import { getMetaBaselineRevision, persistMetaAndSnapshots, updateMetaDigests } from "../lib/state.js";
import { loadWorkspace, validateWorkspace } from "../lib/workspace.js";
import type { WorkspaceResolutionOptions } from "../types.js";

export interface FinalizeOptions extends WorkspaceResolutionOptions {
  cwd: string;
  all?: boolean;
  verified?: string[];
  update?: string[];
  requireClean?: boolean;
  json?: boolean;
}

export interface FinalizeResult {
  status: "success" | "no_change";
  updateAll: boolean;
  updated: string[];
  removedOrphans: string[];
  baselineDigest: string | null;
  baselineRevision: string | null;
  metaPath: string;
  dirtyPaths: string[];
}

/**
 * Core Git-free finalization primitive:
 *   1. Validates the entire llmdoc workspace (fail-closed on structural errors)
 *   2. Computes and writes content digests (`llmdoc.meta/v4`) + local surface snapshots
 *   3. Cleans orphan ledger entries for deleted documents
 * Never touches Git; works identically in non-Git, unborn, rebased, and multi-repo workspaces.
 */
export function executeFinalize(options: FinalizeOptions): FinalizeResult {
  const rootDir = findProjectRoot(options.cwd, options);
  const workspace = loadWorkspace(rootDir, options);

  const requestedPaths = uniquePaths(
    [...(options.verified ?? []), ...(options.update ?? [])].map((value) =>
      value.startsWith("llmdoc/") ? value.slice("llmdoc/".length) : value
    )
  );
  if (options.all && requestedPaths.length > 0) {
    throw new CliError("finalize cannot use --all together with --verified or --update.");
  }
  for (const docPath of requestedPaths) {
    if (!workspace.documentsByLlmdocPath.has(docPath)) {
      throw new CliError(`Document does not exist: ${docPath}`);
    }
  }

  // Validate structurally; orphan entries are cleaned by finalize itself, so exempt meta.entry.orphaned.
  const issues = validateWorkspace(workspace);
  const blockingErrors = issues.filter((issue) => issue.severity === "error" && issue.code !== "meta.entry.orphaned");
  if (blockingErrors.length > 0) {
    throw new CliError(
      `Validation failed; refusing to finalize:\n${blockingErrors.map((issue) => `  ${issue.code} (${issue.path ?? "workspace"}) ${issue.message}`).join("\n")}`
    );
  }

  if (!workspace.meta) {
    throw new CliError(`${workspace.metaDisplayPath} is missing; run \`llmdoc init-state\` first.`);
  }

  const updateAll = Boolean(options.all);
  let updateResult;
  try {
    updateResult = updateMetaDigests({
      workspace,
      llmdocPaths: requestedPaths,
      updateAll,
      requireClean: Boolean(options.requireClean)
    });
  } catch (error) {
    throw new CliError(`Finalize preflight failed: ${(error as Error).message}`, 70);
  }

  if (!updateResult.changed) {
    return {
      status: "no_change",
      updateAll,
      updated: [],
      removedOrphans: [],
      baselineDigest: updateResult.meta.baseline.surfaceDigest,
      baselineRevision: getMetaBaselineRevision(updateResult.meta),
      metaPath: workspace.metaDisplayPath,
      dirtyPaths: updateResult.dirtyPaths
    };
  }

  persistMetaAndSnapshots({
    workspace,
    meta: updateResult.meta,
    surface: updateResult.surface,
    updatedDocPaths: updateResult.updatedPaths,
    advanceBaseline: updateAll
  });

  return {
    status: "success",
    updateAll,
    updated: updateResult.updatedPaths,
    removedOrphans: updateResult.removedOrphans,
    baselineDigest: updateResult.meta.baseline.surfaceDigest,
    baselineRevision: getMetaBaselineRevision(updateResult.meta),
    metaPath: workspace.metaDisplayPath,
    dirtyPaths: updateResult.dirtyPaths
  };
}

export function runFinalize(options: FinalizeOptions): unknown {
  const result = executeFinalize(options);
  if (options.json) {
    return result;
  }
  if (result.status === "no_change") {
    return "no_change: fingerprints are already current";
  }
  const lines = [
    `finalized: ${result.updated.length} document(s)${result.updateAll ? ", baseline advanced" : ""}${result.removedOrphans.length > 0 ? `, removed ${result.removedOrphans.length} orphan(s)` : ""}`
  ];
  if (result.baselineDigest) {
    lines.push(`digest: ${result.baselineDigest.slice(0, 19)}`);
  }
  if (result.dirtyPaths.length > 0) {
    lines.push(`note: finalized against uncommitted workspace changes (${result.dirtyPaths.length} file(s))`);
  }
  return lines.join("\n");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}
