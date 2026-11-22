import { CliError } from "../lib/errors.js";
import { getMetaBaselineRevision, persistMetaAndSnapshots, updateMetaDigests } from "../lib/state.js";
import { loadWorkspace } from "../lib/workspace.js";
import type { WorkspaceResolutionOptions } from "../types.js";

interface FingerprintOptions extends WorkspaceResolutionOptions {
  cwd: string;
  json?: boolean;
  update?: string[];
  all?: boolean;
  requireClean?: boolean;
}

export function runFingerprint(options: FingerprintOptions): unknown {
  const workspace = loadWorkspace(options.cwd, options);
  const targetPaths = options.update?.map((value) => (value.startsWith("llmdoc/") ? value.slice("llmdoc/".length) : value)) ?? [];

  if (options.all && targetPaths.length > 0) {
    throw new CliError("fingerprint cannot use --all and --update together.");
  }

  if (!options.all && targetPaths.length === 0) {
    throw new CliError("fingerprint requires --all or --update <path...>.");
  }

  for (const docPath of targetPaths) {
    if (!workspace.documentsByLlmdocPath.has(docPath)) {
      throw new CliError(`Document does not exist: ${docPath}`);
    }
  }

  try {
    const result = updateMetaDigests({
      workspace,
      llmdocPaths: targetPaths,
      updateAll: Boolean(options.all),
      requireClean: Boolean(options.requireClean)
    });
    persistMetaAndSnapshots({
      workspace,
      meta: result.meta,
      surface: result.surface,
      updatedDocPaths: result.updatedPaths,
      advanceBaseline: Boolean(options.all)
    });

    const baselineDigest = result.meta.baseline.surfaceDigest;
    const baselineRevision = getMetaBaselineRevision(result.meta);

    if (options.json) {
      return {
        status: "success",
        updateAll: Boolean(options.all),
        updated: result.updatedPaths,
        baselineDigest,
        baselineRevision,
        ...(result.dirtyPaths.length > 0 ? { dirtyPaths: result.dirtyPaths } : {})
      };
    }

    const lines = [
      `fingerprint: updated ${result.updatedPaths.length} document(s)${
        options.all ? ` and baseline -> ${baselineDigest?.slice(0, 19) ?? baselineRevision ?? "updated"}` : ""
      }`
    ];
    if (result.dirtyPaths.length > 0) {
      lines.push(`note: fingerprinted against uncommitted workspace changes (${result.dirtyPaths.length} file(s))`);
    }
    return lines.join("\n");
  } catch (error) {
    throw new CliError((error as Error).message);
  }
}
