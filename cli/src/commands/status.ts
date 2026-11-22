import { readRepositoryRevisionHealth } from "../lib/repository-health.js";
import { analyzeDelta, computeGrowthState, getMetaBaselineDigest, getMetaBaselineRevision } from "../lib/state.js";
import { loadWorkspace } from "../lib/workspace.js";
import type { WorkspaceResolutionOptions } from "../types.js";

interface StatusOptions extends WorkspaceResolutionOptions {
  cwd: string;
  json?: boolean;
}

export function runStatus(options: StatusOptions): unknown {
  const workspace = loadWorkspace(options.cwd, options);
  const delta = analyzeDelta(workspace);
  const growth = computeGrowthState(workspace);
  const baselineRevision = getMetaBaselineRevision(workspace.meta);
  const baselineDigest = getMetaBaselineDigest(workspace.meta);
  const relevantCommitsBehindHead = readRepositoryRevisionHealth(
    workspace.rootDir,
    baselineRevision,
    delta.git,
    workspace.llmdocDir
  ).relevantCommitsBehindHead;

  if (options.json) {
    return {
      baseline: baselineRevision ?? baselineDigest,
      baselineDigest,
      trackingMode: delta.trackingMode,
      metaSchema: workspace.meta?.schema ?? null,
      metaLocation: workspace.metaLocation,
      head: delta.git.headRevision,
      commitsBehindHead: delta.git.baselineBehindHead,
      relevantCommitsBehindHead,
      degradedReason: delta.git.degradedReason,
      documents: {
        total: workspace.documents.length,
        impacted: delta.impacts.length,
        needsReview: delta.needsReview.length,
        dirty: delta.dirtyDocuments.length
      },
      unmapped: {
        committed: delta.unmappedCommittedPaths,
        dirty: delta.unmappedDirtyPaths
      },
      growth
    };
  }

  const baselineLabel = formatBaselineLabel(
    baselineDigest,
    baselineRevision,
    delta.trackingMode,
    delta.git.baselineBehindHead,
    relevantCommitsBehindHead,
    delta.surfaceDigest
  );
  const unmapped = [...delta.unmappedCommittedPaths, ...delta.unmappedDirtyPaths];
  const growthLabel =
    growth.baselineDocumentCount === null
      ? `growth: ${growth.currentDocumentCount} docs, ~${growth.currentTotalEstimatedTokens} tokens (no convergence baseline)`
      : `growth: ${growth.currentDocumentCount} docs, ~${growth.currentTotalEstimatedTokens} tokens (baseline ${growth.baselineDocumentCount} docs, ~${growth.baselineTotalEstimatedTokens} tokens) — ${growth.exceedsGate ? "above gate" : "below gate"}`;

  const lines = [
    `baseline: ${baselineLabel}`,
    `documents: ${workspace.documents.length} total / ${delta.impacts.length} impacted / ${delta.needsReview.length} needs-review / ${delta.dirtyDocuments.length} dirty`
  ];
  if (unmapped.length > 0) {
    const shown = unmapped.slice(0, 5);
    const rest = unmapped.length - shown.length;
    lines.push(`unmapped changes (${unmapped.length}): ${shown.join(", ")}${rest > 0 ? ` … +${rest} more (use --json for all)` : ""}`);
  }
  lines.push(growthLabel);
  if (delta.git.degradedReason) {
    lines.push(`degraded: ${delta.git.degradedReason}`);
  }
  return lines.join("\n");
}

function formatBaselineLabel(
  baselineDigest: string | null,
  baselineRevision: string | null,
  trackingMode: "git-hybrid" | "filesystem",
  commitsBehindHead: number | null,
  relevantCommitsBehindHead: number | null,
  currentSurfaceDigest: string
): string {
  if (!baselineDigest && !baselineRevision) {
    return "missing (unknown)";
  }
  if (baselineDigest) {
    const shortDigest = baselineDigest.slice(0, 19);
    const digestStatus = baselineDigest === currentSurfaceDigest ? "content current" : "content changed";
    if (commitsBehindHead !== null) {
      const gitLabel = formatBehindLabel(commitsBehindHead, relevantCommitsBehindHead);
      return `${shortDigest} (${digestStatus}; ${gitLabel})`;
    }
    return `${shortDigest} (${digestStatus}; ${trackingMode})`;
  }
  return `${baselineRevision} (${formatBehindLabel(commitsBehindHead, relevantCommitsBehindHead)})`;
}

function formatBehindLabel(commitsBehindHead: number | null, relevantCommitsBehindHead: number | null): string {
  if (commitsBehindHead === null) {
    return "unknown";
  }
  if (commitsBehindHead > 0 && relevantCommitsBehindHead === 0) {
    return `${commitsBehindHead} commits behind HEAD, metadata-only; knowledge clean`;
  }
  if (commitsBehindHead > 0 && relevantCommitsBehindHead !== null) {
    return `${commitsBehindHead} commits behind HEAD, ${relevantCommitsBehindHead} relevant source commits`;
  }
  return `${commitsBehindHead} commits behind HEAD`;
}
