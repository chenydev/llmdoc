import fs from "node:fs";

import { DocumentImpact, GitState, MetaLedger, MetaLedgerV4, ParsedDocument, WorkspaceData } from "../types.js";
import { canAdvanceRevisions, gitCommitExists, readChangedPathsSince, readGitState, readGitTreeBlobHashes } from "./git.js";
import { ensureDirectory, normalizeRepoRelativePath } from "./fs.js";
import { createIgnoreEngine, IgnoreEngine } from "./ignore.js";
import { matchesCodePathPattern } from "./search.js";
import {
  computeCodeDigest,
  computeDocumentCodeDigest,
  diffFileMaps,
  saveSurfaceSnapshots,
  scanWorkspaceSurface,
  type WorkspaceSurface
} from "./surface.js";

export interface ScopeFilter {
  topics: Set<string>;
  documentPaths: Set<string>;
}

export interface DeltaState {
  git: GitState;
  trackingMode: "git-hybrid" | "filesystem";
  surfaceDigest: string;
  impacts: DocumentImpact[];
  needsReview: ParsedDocument[];
  dirtyDocuments: ParsedDocument[];
  unmappedCommittedPaths: string[];
  unmappedDirtyPaths: string[];
  suggestedMode: "light" | "deep";
  reasons: string[];
  scopedDocuments: ParsedDocument[];
}

export interface GrowthState {
  currentDocumentCount: number;
  currentTotalEstimatedTokens: number;
  baselineDocumentCount: number | null;
  baselineTotalEstimatedTokens: number | null;
  documentDelta: number | null;
  tokenDelta: number | null;
  exceedsGate: boolean;
}

export function getMetaBaselineRevision(meta: MetaLedger | null): string | null {
  if (!meta) {
    return null;
  }
  return meta.schema === "llmdoc.meta/v4" ? (meta.baseline.hintRevision ?? null) : meta.baseline.revision;
}

export function getMetaBaselineDigest(meta: MetaLedger | null): string | null {
  if (!meta || meta.schema !== "llmdoc.meta/v4") {
    return null;
  }
  return meta.baseline.surfaceDigest;
}

export function analyzeDelta(workspace: WorkspaceData, scope?: ScopeFilter): DeltaState {
  const isV3 = workspace.meta?.schema === "llmdoc.meta/v3";
  const git = readWorkspaceGitState(workspace);
  const surface = scanWorkspaceSurface(workspace);
  const ignoreEngine = createIgnoreEngine(workspace.rootDir, { llmdocDir: workspace.llmdocDir });
  const scopedDocuments = applyScope(workspace.documents, scope);

  if (isV3 && workspace.meta?.schema === "llmdoc.meta/v3") {
    return analyzeLegacyV3Delta(workspace, scopedDocuments, git, surface, ignoreEngine);
  }

  return analyzeV4Delta(workspace, scopedDocuments, git, surface, ignoreEngine);
}

function analyzeV4Delta(
  workspace: WorkspaceData,
  scopedDocuments: ParsedDocument[],
  git: GitState,
  surface: WorkspaceSurface,
  ignoreEngine: IgnoreEngine
): DeltaState {
  const meta = workspace.meta?.schema === "llmdoc.meta/v4" ? workspace.meta : null;
  const unverifiedReasons: string[] = [];
  const treeCache = new Map<string, Map<string, string> | null>();

  const getHistoricalTree = (revision: string): Map<string, string> | null => {
    if (treeCache.has(revision)) {
      return treeCache.get(revision)!;
    }
    const tree = git.available ? readGitTreeBlobHashes(workspace.rootDir, revision) : null;
    treeCache.set(revision, tree);
    return tree;
  };

  const directImpacts: DocumentImpact[] = scopedDocuments
    .map((document): DocumentImpact => {
      const entry = meta?.documents[document.llmdocPath];
      const { matchedFiles, codeDigest: currentDigest } = computeDocumentCodeDigest(document, surface.files);

      if (!entry || entry.codeDigest === null) {
        unverifiedReasons.push(`Document ${document.llmdocPath} has no verified codeDigest`);
        const matchedList = Object.keys(matchedFiles).sort();
        const dirtyPaths = matchedList.filter((filePath) => surface.dirtyPaths.has(filePath));
        return {
          document,
          changedPaths: [],
          changedCommittedPaths: [],
          dirtyPaths,
          needsReviewBecauseOf: ["codeDigest unverified"]
        };
      }

      if (entry.codeDigest === currentDigest) {
        return {
          document,
          changedPaths: [],
          changedCommittedPaths: [],
          dirtyPaths: [],
          needsReviewBecauseOf: []
        };
      }

      // Content digest changed: resolve exact changed files from local snapshot cache,
      // falling back to optional Git hintRevision tree, or listing matched paths.
      let changedPaths: string[] = [];
      const cachedDocSnapshot = surface.cache.documentSnapshots?.[document.llmdocPath];
      if (cachedDocSnapshot && cachedDocSnapshot.codeDigest === entry.codeDigest) {
        changedPaths = diffFileMaps(cachedDocSnapshot.files, matchedFiles);
      } else if (entry.hintRevision) {
        const tree = getHistoricalTree(entry.hintRevision);
        if (tree) {
          const prevMatched: Record<string, string> = {};
          for (const [relPath, hash] of tree) {
            if (ignoreEngine.isImplementationSurface(relPath) && documentMatchesPath(document, relPath)) {
              prevMatched[relPath] = hash;
            }
          }
          changedPaths = diffFileMaps(prevMatched, matchedFiles);
        }
      }

      const needsReviewBecauseOf: string[] = [];
      if (changedPaths.length === 0) {
        changedPaths = Object.keys(matchedFiles).sort();
        needsReviewBecauseOf.push("codeDigest changed");
      }

      const dirtyPaths = changedPaths.filter((filePath) => surface.dirtyPaths.has(filePath));
      const changedCommittedPaths = changedPaths.filter((filePath) => !surface.dirtyPaths.has(filePath));

      return {
        document,
        changedPaths,
        changedCommittedPaths,
        dirtyPaths,
        needsReviewBecauseOf
      };
    })
    .filter(
      (impact) =>
        impact.changedPaths.length > 0 ||
        impact.changedCommittedPaths.length > 0 ||
        impact.dirtyPaths.length > 0 ||
        impact.needsReviewBecauseOf.length > 0
    );

  const { needsReview } = expandReverseRequires(workspace.documents, scopedDocuments, directImpacts);
  const dirtyDocuments = directImpacts.filter((impact) => impact.dirtyPaths.length > 0).map((impact) => impact.document);

  // Unmapped change detection (content-digest first: if surfaceDigest matches baseline, 0 unmapped!).
  const { unmappedCommittedPaths, unmappedDirtyPaths } = computeV4UnmappedPaths(workspace, meta, git, surface, ignoreEngine);

  const reasons: string[] = [];
  if (!meta) {
    reasons.push(`${workspace.metaDisplayPath} is missing`);
  }
  if (unverifiedReasons.length > 0) {
    reasons.push(...unverifiedReasons);
  }
  if (unmappedCommittedPaths.length > 0 || unmappedDirtyPaths.length > 0) {
    reasons.push("Unmapped code paths exist");
  }
  if (needsReview.length > 0) {
    reasons.push("Documents in the reverse requires closure need review");
  }
  if (directImpacts.length > 8) {
    reasons.push("Too many documents are impacted; deep mode is recommended");
  }
  if (dirtyDocuments.length > 0) {
    reasons.push("Mapped implementation code has uncommitted changes");
  }

  return {
    git,
    trackingMode: surface.mode,
    surfaceDigest: surface.surfaceDigest,
    impacts: directImpacts.sort((left, right) => left.document.llmdocPath.localeCompare(right.document.llmdocPath)),
    needsReview,
    dirtyDocuments: dirtyDocuments.sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath)),
    unmappedCommittedPaths,
    unmappedDirtyPaths,
    suggestedMode: reasons.length > 0 ? "deep" : "light",
    reasons,
    scopedDocuments
  };
}

function computeV4UnmappedPaths(
  workspace: WorkspaceData,
  meta: MetaLedgerV4 | null,
  git: GitState,
  surface: WorkspaceSurface,
  ignoreEngine: IgnoreEngine
): { unmappedCommittedPaths: string[]; unmappedDirtyPaths: string[] } {
  const baselineDigest = meta?.baseline.surfaceDigest ?? null;
  if (baselineDigest !== null && baselineDigest === surface.surfaceDigest) {
    // Byte-for-byte identical implementation surface -> zero unmapped changes (immune to rebase/squash/amend).
    return { unmappedCommittedPaths: [], unmappedDirtyPaths: [] };
  }

  const isUnmapped = (relPath: string): boolean =>
    !workspace.documents.some((document) => documentMatchesPath(document, relPath));

  // 1. Primary path: diff against local baseline snapshot cache (works identically for Git & non-Git).
  const baselineSnap = surface.cache.baselineSnapshot;
  if (baselineSnap && baselineDigest !== null && baselineSnap.surfaceDigest === baselineDigest) {
    const changed = diffFileMaps(baselineSnap.files, surface.files).filter((relPath) => surface.files.has(relPath));
    const unmapped = changed.filter(isUnmapped);
    return {
      unmappedCommittedPaths: unmapped.filter((filePath) => !surface.dirtyPaths.has(filePath)),
      unmappedDirtyPaths: unmapped.filter((filePath) => surface.dirtyPaths.has(filePath))
    };
  }

  // 2. Cold-start fallback in Git repository when hintRevision is reachable.
  const hintRevision = meta?.baseline.hintRevision ?? null;
  if (git.available && hintRevision && git.headRevision && gitCommitExists(workspace.rootDir, hintRevision)) {
    const committed = git.committedChangedPaths.filter(
      (filePath) => ignoreEngine.isImplementationSurface(filePath) && surface.files.has(filePath) && isUnmapped(filePath)
    );
    const dirty = [...surface.dirtyPaths].filter((filePath) => surface.files.has(filePath) && isUnmapped(filePath));
    return {
      unmappedCommittedPaths: uniquePaths(committed),
      unmappedDirtyPaths: uniquePaths(dirty)
    };
  }

  // 3. Git working-tree dirty fallback (e.g. unborn branch or missing/rebased hintRevision without local cache).
  if (git.available && surface.dirtyPaths.size > 0) {
    const dirty = [...surface.dirtyPaths].filter((filePath) => surface.files.has(filePath) && isUnmapped(filePath));
    return {
      unmappedCommittedPaths: [],
      unmappedDirtyPaths: uniquePaths(dirty)
    };
  }

  // 4. Cold-start non-Git without baselineSnapshot when digest differs from baseline.
  if (baselineDigest !== null && baselineDigest !== surface.surfaceDigest) {
    const unmapped = [...surface.files.keys()].filter(isUnmapped);
    return {
      unmappedCommittedPaths: uniquePaths(unmapped),
      unmappedDirtyPaths: []
    };
  }

  return { unmappedCommittedPaths: [], unmappedDirtyPaths: [] };
}

function analyzeLegacyV3Delta(
  workspace: WorkspaceData,
  scopedDocuments: ParsedDocument[],
  git: GitState,
  surface: WorkspaceSurface,
  ignoreEngine: IgnoreEngine
): DeltaState {
  const isSurface = (repoRelativePath: string): boolean => ignoreEngine.isImplementationSurface(repoRelativePath);
  const dirtyPaths = uniquePaths([...git.stagedPaths, ...git.unstagedPaths, ...git.untrackedPaths].filter(isSurface));
  const invalidRevisionReasons: string[] = [];
  const changedPathsByRevision = new Map<string, string[]>();
  const commitExistsByRevision = new Map<string, boolean>();
  const cachedCommitExists = (revision: string): boolean => {
    const cached = commitExistsByRevision.get(revision);
    if (cached !== undefined) {
      return cached;
    }
    const exists = git.available && gitCommitExists(workspace.rootDir, revision);
    commitExistsByRevision.set(revision, exists);
    return exists;
  };

  const metaV3 = workspace.meta?.schema === "llmdoc.meta/v3" ? workspace.meta : null;

  const directImpacts: DocumentImpact[] = scopedDocuments
    .map((document): DocumentImpact => {
      const validatedRevision = metaV3?.documents[document.llmdocPath]?.validatedRevision ?? null;
      const revisionInvalid = !validatedRevision || !git.headRevision || !cachedCommitExists(validatedRevision);
      if (revisionInvalid) {
        invalidRevisionReasons.push(
          !validatedRevision
            ? `Document ${document.llmdocPath} has no validatedRevision`
            : `Document ${document.llmdocPath} has a validatedRevision that does not exist in current Git history: ${validatedRevision}`
        );
      }
      const changedCommittedPaths =
        !revisionInvalid && git.headRevision && validatedRevision !== git.headRevision
          ? getChangedPathsForRevision(workspace.rootDir, validatedRevision, git.headRevision, changedPathsByRevision).filter(
              (filePath) => isSurface(filePath) && documentMatchesPath(document, filePath)
            )
          : [];
      const dirtyDocumentPaths = dirtyPaths.filter((filePath) => documentMatchesPath(document, filePath));
      return {
        document,
        changedPaths: uniquePaths([...changedCommittedPaths, ...dirtyDocumentPaths]),
        changedCommittedPaths,
        dirtyPaths: dirtyDocumentPaths,
        needsReviewBecauseOf: revisionInvalid ? ["validatedRevision invalid"] : []
      };
    })
    .filter(
      (impact) =>
        impact.changedCommittedPaths.length > 0 ||
        impact.dirtyPaths.length > 0 ||
        impact.needsReviewBecauseOf.includes("validatedRevision invalid")
    );

  const { needsReview } = expandReverseRequires(workspace.documents, scopedDocuments, directImpacts);
  const dirtyDocuments = directImpacts.filter((impact) => impact.dirtyPaths.length > 0).map((impact) => impact.document);
  const baselineCommittedPaths = git.committedChangedPaths.filter(isSurface);
  const unmappedCommittedPaths = baselineCommittedPaths.filter(
    (filePath) => !workspace.documents.some((document) => documentMatchesPath(document, filePath))
  );
  const unmappedDirtyPaths = dirtyPaths.filter(
    (filePath) => !workspace.documents.some((document) => documentMatchesPath(document, filePath))
  );

  const reasons: string[] = [];
  if (!git.available || git.degradedReason) {
    reasons.push(git.degradedReason ?? "Git state is unavailable");
  }
  if (invalidRevisionReasons.length > 0) {
    reasons.push(...invalidRevisionReasons);
  }
  if (unmappedCommittedPaths.length > 0 || unmappedDirtyPaths.length > 0) {
    reasons.push("Unmapped code paths exist");
  }
  if (needsReview.length > 0) {
    reasons.push("Documents in the reverse requires closure need review");
  }
  if (directImpacts.length > 8) {
    reasons.push("Too many documents are impacted; deep mode is recommended");
  }
  if (dirtyDocuments.length > 0) {
    reasons.push("Mapped implementation code has uncommitted changes");
  }

  return {
    git,
    trackingMode: surface.mode,
    surfaceDigest: surface.surfaceDigest,
    impacts: directImpacts.sort((left, right) => left.document.llmdocPath.localeCompare(right.document.llmdocPath)),
    needsReview,
    dirtyDocuments: dirtyDocuments.sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath)),
    unmappedCommittedPaths,
    unmappedDirtyPaths,
    suggestedMode: reasons.length > 0 ? "deep" : "light",
    reasons,
    scopedDocuments
  };
}

function expandReverseRequires(
  allDocuments: ParsedDocument[],
  scopedDocuments: ParsedDocument[],
  directImpacts: DocumentImpact[]
): { needsReview: ParsedDocument[] } {
  const directMap = new Map(directImpacts.map((impact) => [impact.document.llmdocPath, impact]));
  const reverseRequires = buildReverseRequires(allDocuments);
  const needsReviewMap = new Map<string, ParsedDocument>();

  for (const impact of directImpacts) {
    for (const dependent of reverseRequires.get(impact.document.llmdocPath) ?? []) {
      if (!scopedDocuments.some((document) => document.llmdocPath === dependent.llmdocPath)) {
        continue;
      }
      if (!directMap.has(dependent.llmdocPath)) {
        needsReviewMap.set(dependent.llmdocPath, dependent);
      }
      const existing = directMap.get(dependent.llmdocPath);
      if (existing) {
        existing.needsReviewBecauseOf.push(impact.document.llmdocPath);
      }
    }
  }

  return {
    needsReview: [...needsReviewMap.values()].sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath))
  };
}

export function readWorkspaceGitState(workspace: WorkspaceData): GitState {
  const legacyStrict = workspace.meta?.schema === "llmdoc.meta/v3";
  return readGitState(workspace.rootDir, getMetaBaselineRevision(workspace.meta), { legacyStrict });
}

export function parseScope(values: string[] | undefined, workspace: WorkspaceData): ScopeFilter | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const topics = new Set<string>();
  const documentPaths = new Set<string>();
  for (const value of values) {
    const raw = value.trim();
    if (workspace.topics.has(raw)) {
      topics.add(raw);
      continue;
    }
    const normalized = normalizeRepoRelativePath(raw.startsWith("llmdoc/") ? raw : `llmdoc/${raw}`).slice("llmdoc/".length);
    if (workspace.topics.has(normalized)) {
      topics.add(normalized);
      continue;
    }
    if (!workspace.documentsByLlmdocPath.has(normalized)) {
      throw new Error(`Scope did not match any topic or document: ${raw}`);
    }
    documentPaths.add(normalized);
  }
  return { topics, documentPaths };
}

export function computeGrowthState(workspace: WorkspaceData): GrowthState {
  const currentDocumentCount = workspace.documents.length;
  const currentTotalEstimatedTokens = workspace.documents.reduce((sum, document) => sum + document.estimatedTokens, 0);
  const baselineDocumentCount = workspace.meta?.convergence.documentCount ?? null;
  const baselineTotalEstimatedTokens = workspace.meta?.convergence.totalEstimatedTokens ?? null;
  const documentDelta = baselineDocumentCount === null ? null : currentDocumentCount - baselineDocumentCount;
  const tokenDelta = baselineTotalEstimatedTokens === null ? null : currentTotalEstimatedTokens - baselineTotalEstimatedTokens;
  const exceedsGate = tokenDelta !== null ? tokenDelta > Math.max(500, Math.round((baselineTotalEstimatedTokens ?? 0) * 0.2)) : false;
  return {
    currentDocumentCount,
    currentTotalEstimatedTokens,
    baselineDocumentCount,
    baselineTotalEstimatedTokens,
    documentDelta,
    tokenDelta,
    exceedsGate
  };
}

/**
 * Creates a fresh `llmdoc.meta/v4` initial ledger (all docs start with `codeDigest: null`).
 * Works identically in Git repos, unborn branches, and non-Git directories.
 */
export function createInitialMetaLedger(workspace: WorkspaceData): {
  meta: MetaLedgerV4;
  surface: WorkspaceSurface;
  headRevision: string | null;
} {
  const git = readWorkspaceGitState(workspace);
  const surface = scanWorkspaceSurface(workspace);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const meta: MetaLedgerV4 = {
    schema: "llmdoc.meta/v4",
    baseline: {
      surfaceDigest: surface.surfaceDigest,
      hintRevision: git.headRevision,
      verifiedAt: now
    },
    documents: Object.fromEntries(
      workspace.documents.map((document) => [
        document.llmdocPath,
        { codeDigest: null, hintRevision: null }
      ])
    ),
    convergence: {
      capturedAt: now,
      source: "init",
      documentCount: workspace.documents.length,
      totalEstimatedTokens: workspace.documents.reduce((sum, document) => sum + document.estimatedTokens, 0)
    }
  };
  return { meta, surface, headRevision: git.headRevision };
}

export function assertDigestAdvancePreconditions(input: {
  workspace: WorkspaceData;
  llmdocPaths: string[];
  updateAll: boolean;
  requireClean?: boolean;
}): { git: GitState; surface: WorkspaceSurface; targetPaths: string[]; dirtyPaths: string[] } {
  const { workspace, llmdocPaths, updateAll, requireClean = false } = input;
  if (!workspace.meta) {
    throw new Error(`${workspace.metaDisplayPath} is missing`);
  }
  const git = readWorkspaceGitState(workspace);
  const advance = canAdvanceRevisions(git);
  if (!advance.ok) {
    throw new Error(advance.reason);
  }

  const surface = scanWorkspaceSurface(workspace);
  const targetPaths = updateAll ? workspace.documents.map((document) => document.llmdocPath) : uniquePaths(llmdocPaths);

  const dirtyMatchedFiles = new Set<string>();
  const blockedDocs: string[] = [];
  for (const docPath of targetPaths) {
    const document = workspace.documentsByLlmdocPath.get(docPath);
    if (!document) {
      continue;
    }
    const docDirty = [...surface.dirtyPaths].filter((filePath) => documentMatchesPath(document, filePath));
    if (docDirty.length > 0) {
      blockedDocs.push(docPath);
      for (const filePath of docDirty) {
        dirtyMatchedFiles.add(filePath);
      }
    }
  }

  if (requireClean && blockedDocs.length > 0) {
    throw new Error(
      updateAll
        ? `A full fingerprint cannot advance while mapped code for these documents is dirty: ${blockedDocs.join(", ")}`
        : `Cannot advance fingerprints while mapped code for these documents is dirty: ${blockedDocs.join(", ")}`
    );
  }

  return {
    git,
    surface,
    targetPaths,
    dirtyPaths: [...dirtyMatchedFiles].sort()
  };
}

/**
 * Advances content digests (`llmdoc.meta/v4`) for selected or all documents,
 * automatically upgrading legacy `llmdoc.meta/v3` ledgers losslessly.
 */
export function updateMetaDigests(input: {
  workspace: WorkspaceData;
  llmdocPaths: string[];
  updateAll: boolean;
  requireClean?: boolean;
}): {
  meta: MetaLedgerV4;
  surface: WorkspaceSurface;
  updatedPaths: string[];
  removedOrphans: string[];
  dirtyPaths: string[];
  changed: boolean;
} {
  const { workspace, updateAll } = input;
  const { git, surface, targetPaths, dirtyPaths } = assertDigestAdvancePreconditions(input);
  const existing = workspace.meta!;
  const wasV3 = existing.schema === "llmdoc.meta/v3";
  const nextMeta = migrateToV4Base(workspace, existing, git, surface);

  const removedOrphans: string[] = [];
  for (const docPath of Object.keys(nextMeta.documents)) {
    if (!workspace.documentsByLlmdocPath.has(docPath)) {
      delete nextMeta.documents[docPath];
      removedOrphans.push(docPath);
    }
  }
  removedOrphans.sort();

  const actuallyUpdated: string[] = [];
  for (const docPath of targetPaths) {
    const document = workspace.documentsByLlmdocPath.get(docPath);
    if (!document) {
      continue;
    }
    const { codeDigest } = computeDocumentCodeDigest(document, surface.files);
    const prev = nextMeta.documents[docPath];
    const entryChanged = !prev || prev.codeDigest !== codeDigest || wasV3;
    nextMeta.documents[docPath] = {
      codeDigest,
      hintRevision: git.headRevision
    };
    if (entryChanged) {
      actuallyUpdated.push(docPath);
    }
  }

  let baselineChanged = false;
  if (updateAll) {
    baselineChanged = wasV3 || nextMeta.baseline.surfaceDigest !== surface.surfaceDigest;
    if (baselineChanged) {
      nextMeta.baseline = {
        surfaceDigest: surface.surfaceDigest,
        hintRevision: git.headRevision,
        verifiedAt: new Date().toISOString()
      };
    }
  }

  const changed = wasV3 || removedOrphans.length > 0 || actuallyUpdated.length > 0 || baselineChanged;
  return {
    meta: nextMeta,
    surface,
    updatedPaths: targetPaths.slice().sort(),
    removedOrphans,
    dirtyPaths,
    changed
  };
}

export function persistMetaAndSnapshots(input: {
  workspace: WorkspaceData;
  meta: MetaLedgerV4;
  surface: WorkspaceSurface;
  updatedDocPaths: string[];
  advanceBaseline: boolean;
}): void {
  writeMeta(input.workspace.metaPath, input.meta);
  saveSurfaceSnapshots({
    workspace: input.workspace,
    surface: input.surface,
    updatedDocPaths: input.updatedDocPaths,
    advanceBaseline: input.advanceBaseline
  });
}

export function writeMeta(metaPath: string, meta: MetaLedger): void {
  ensureDirectory(metaPath);
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

export function isImplementationSurfacePath(rootDir: string, repoRelativePath: string, llmdocDir?: string): boolean {
  return createIgnoreEngine(rootDir, { llmdocDir }).isImplementationSurface(repoRelativePath);
}

function migrateToV4Base(
  workspace: WorkspaceData,
  existing: MetaLedger,
  git: GitState,
  surface: WorkspaceSurface
): MetaLedgerV4 {
  if (existing.schema === "llmdoc.meta/v4") {
    return structuredClone(existing);
  }

  // Losslessly convert legacy v3 entries using historical git tree blobs when reachable.
  const ignoreEngine = createIgnoreEngine(workspace.rootDir, { llmdocDir: workspace.llmdocDir });
  const treeCache = new Map<string, Map<string, string> | null>();
  const getTree = (rev: string): Map<string, string> | null => {
    if (treeCache.has(rev)) {
      return treeCache.get(rev)!;
    }
    const tree = git.available ? readGitTreeBlobHashes(workspace.rootDir, rev) : null;
    treeCache.set(rev, tree);
    return tree;
  };

  let baselineDigest: string | null = null;
  const baselineTree = getTree(existing.baseline.revision);
  if (baselineTree) {
    const surfaceEntries: Array<{ path: string; hash: string }> = [];
    for (const [relPath, hash] of baselineTree) {
      if (ignoreEngine.isImplementationSurface(relPath)) {
        surfaceEntries.push({ path: relPath, hash });
      }
    }
    baselineDigest = computeCodeDigest(surfaceEntries);
  }

  const nextDocs: MetaLedgerV4["documents"] = {};
  for (const [docPath, entry] of Object.entries(existing.documents)) {
    const doc = workspace.documentsByLlmdocPath.get(docPath);
    if (!doc || !entry.validatedRevision) {
      nextDocs[docPath] = { codeDigest: null, hintRevision: entry.validatedRevision };
      continue;
    }
    const tree = getTree(entry.validatedRevision);
    if (!tree) {
      nextDocs[docPath] = { codeDigest: null, hintRevision: entry.validatedRevision };
      continue;
    }
    const matched: Array<{ path: string; hash: string }> = [];
    for (const [relPath, hash] of tree) {
      if (ignoreEngine.isImplementationSurface(relPath) && documentMatchesPath(doc, relPath)) {
        matched.push({ path: relPath, hash });
      }
    }
    nextDocs[docPath] = {
      codeDigest: computeCodeDigest(matched),
      hintRevision: entry.validatedRevision
    };
  }

  // Fallback if surface is empty and baselineTree couldn't be resolved.
  void surface;

  return {
    schema: "llmdoc.meta/v4",
    baseline: {
      surfaceDigest: baselineDigest,
      hintRevision: existing.baseline.revision,
      verifiedAt: existing.baseline.verifiedAt
    },
    documents: nextDocs,
    convergence: structuredClone(existing.convergence)
  };
}

function applyScope(documents: ParsedDocument[], scope: ScopeFilter | undefined): ParsedDocument[] {
  if (!scope) {
    return documents.slice();
  }
  return documents.filter((document) => {
    if (document.topic && scope.topics.has(document.topic)) {
      return true;
    }
    return scope.documentPaths.has(document.llmdocPath);
  });
}

function documentMatchesPath(document: ParsedDocument, repoRelativePath: string): boolean {
  return (document.frontmatter.code?.paths ?? []).some((pattern) => matchesCodePathPattern(pattern, repoRelativePath));
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function buildReverseRequires(documents: ParsedDocument[]): Map<string, ParsedDocument[]> {
  const mapping = new Map<string, ParsedDocument[]>();
  for (const document of documents) {
    for (const requirement of document.frontmatter.relations?.requires ?? []) {
      const bucket = mapping.get(requirement) ?? [];
      bucket.push(document);
      mapping.set(requirement, bucket);
    }
  }
  return mapping;
}

function getChangedPathsForRevision(
  rootDir: string,
  revision: string,
  headRevision: string,
  cache: Map<string, string[]>
): string[] {
  const cached = cache.get(revision);
  if (cached) {
    return cached;
  }
  const paths = readChangedPathsSince(rootDir, revision, headRevision);
  cache.set(revision, paths);
  return paths;
}
