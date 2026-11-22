import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ParsedDocument, ResolvedCodeRoot, WorkspaceData } from "../types.js";
import { CACHE_DIR, SURFACE_CACHE_FILE } from "./constants.js";
import { ensureDirectory } from "./fs.js";
import { isDirectGitRoot, readGitIndexBlobHashes, readGitWorkingTreeChanges } from "./git.js";
import { createIgnoreEngine, IgnoreEngine } from "./ignore.js";
import { matchesCodePathPattern } from "./search.js";

export interface StatCacheEntry {
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface SurfaceCacheFile {
  version: 1;
  statCache: Record<string, StatCacheEntry>;
  baselineSnapshot?: {
    surfaceDigest: string;
    capturedAt: string;
    files: Record<string, string>;
  };
  documentSnapshots?: Record<
    string,
    {
      codeDigest: string;
      files: Record<string, string>;
    }
  >;
}

export interface WorkspaceSurface {
  mode: "git-hybrid" | "filesystem";
  files: Map<string, string>;
  surfaceDigest: string;
  dirtyPaths: Set<string>;
  cache: SurfaceCacheFile;
}

/**
 * Git-compatible blob hash: sha1("blob " + byteLength + "\0" + content).
 * Produces the exact same 40-char SHA-1 hex as `git hash-object` / `git ls-files -s`.
 */
export function computeGitBlobHash(content: Buffer): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  return crypto.createHash("sha1").update(header).update(content).digest("hex");
}

export function computeFileBlobHash(absolutePath: string): string {
  return computeGitBlobHash(fs.readFileSync(absolutePath));
}

/**
 * Aggregates `(relPath, blobHash)` entries sorted by POSIX path into a compact SHA-256 digest.
 */
export function computeCodeDigest(files: ReadonlyArray<{ path: string; hash: string }> | ReadonlyMap<string, string>): string {
  const entries: Array<{ path: string; hash: string }> = Array.isArray(files)
    ? [...files]
    : [...(files as ReadonlyMap<string, string>).entries()].map(([filePath, hash]) => ({ path: filePath, hash }));
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hasher = crypto.createHash("sha256");
  hasher.update("llmdoc.code-digest/v1\n");
  for (const entry of entries) {
    hasher.update(`${entry.path}\0${entry.hash}\n`);
  }
  return `sha256:${hasher.digest("hex")}`;
}

export function computeDocumentCodeDigest(
  document: ParsedDocument,
  surfaceFiles: ReadonlyMap<string, string>
): { matchedFiles: Record<string, string>; codeDigest: string } {
  const patterns = document.frontmatter.code?.paths ?? [];
  const matchedFiles: Record<string, string> = {};
  if (patterns.length > 0) {
    const entries: Array<{ path: string; hash: string }> = [];
    for (const [relPath, hash] of surfaceFiles) {
      if (patterns.some((pattern) => matchesCodePathPattern(pattern, relPath))) {
        entries.push({ path: relPath, hash });
      }
    }
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (const entry of entries) {
      matchedFiles[entry.path] = entry.hash;
    }
    return {
      matchedFiles,
      codeDigest: computeCodeDigest(entries)
    };
  }
  return {
    matchedFiles,
    codeDigest: computeCodeDigest([])
  };
}

export function scanWorkspaceSurface(
  workspace: Pick<WorkspaceData, "rootDir" | "llmdocDir" | "codeRoots">,
  options?: { persistStatCache?: boolean; forceMode?: "auto" | "git-hybrid" | "filesystem" }
): WorkspaceSurface {
  const persistStatCache = options?.persistStatCache ?? true;
  const forceMode = options?.forceMode ?? "auto";
  const cachePath = getSurfaceCachePath(workspace.rootDir);
  const cache = loadSurfaceCache(cachePath);
  const nextStatCache: Record<string, StatCacheEntry> = {};

  const files = new Map<string, string>();
  const dirtyPaths = new Set<string>();
  let usedGitHybrid = false;

  const rootsToScan: ResolvedCodeRoot[] =
    workspace.codeRoots.length > 0
      ? workspace.codeRoots
      : [{ name: null, configuredPath: ".", absolutePath: workspace.rootDir }];

  for (const codeRoot of rootsToScan) {
    if (!fs.existsSync(codeRoot.absolutePath)) {
      continue;
    }
    const prefix = codeRoot.name ? `${codeRoot.name}/` : "";
    const ignoreEngine = createIgnoreEngine(codeRoot.absolutePath, {
      llmdocDir: workspace.llmdocDir
    });
    const rootIsDirectGit = forceMode !== "filesystem" && isDirectGitRoot(codeRoot.absolutePath);
    let scanned: { files: Map<string, string>; dirty: Set<string> } | null = null;

    if (rootIsDirectGit) {
      scanned = scanGitFastPath(codeRoot.absolutePath, prefix, ignoreEngine, cache.statCache, nextStatCache);
      if (scanned) {
        usedGitHybrid = true;
      }
    }

    if (!scanned) {
      scanned = scanFilesystemPath(codeRoot.absolutePath, prefix, ignoreEngine, cache.statCache, nextStatCache);
    }

    for (const [relPath, hash] of scanned.files) {
      files.set(relPath, hash);
    }
    for (const dirtyPath of scanned.dirty) {
      dirtyPaths.add(dirtyPath);
    }
  }

  const surfaceDigest = computeCodeDigest(files);
  const updatedCache: SurfaceCacheFile = {
    version: 1,
    statCache: nextStatCache,
    ...(cache.baselineSnapshot ? { baselineSnapshot: cache.baselineSnapshot } : {}),
    ...(cache.documentSnapshots ? { documentSnapshots: cache.documentSnapshots } : {})
  };

  if (persistStatCache) {
    writeSurfaceCache(cachePath, updatedCache);
  }

  return {
    mode: usedGitHybrid ? "git-hybrid" : "filesystem",
    files,
    surfaceDigest,
    dirtyPaths,
    cache: updatedCache
  };
}

export function saveSurfaceSnapshots(input: {
  workspace: WorkspaceData;
  surface: WorkspaceSurface;
  updatedDocPaths: string[];
  advanceBaseline: boolean;
}): void {
  const { workspace, surface, updatedDocPaths, advanceBaseline } = input;
  const cachePath = getSurfaceCachePath(workspace.rootDir);
  const existing = loadSurfaceCache(cachePath);
  const nextDocSnapshots: Record<string, { codeDigest: string; files: Record<string, string> }> = {
    ...(existing.documentSnapshots ?? {})
  };

  // Drop orphan snapshots for deleted documents.
  for (const docPath of Object.keys(nextDocSnapshots)) {
    if (!workspace.documentsByLlmdocPath.has(docPath)) {
      delete nextDocSnapshots[docPath];
    }
  }

  for (const docPath of updatedDocPaths) {
    const document = workspace.documentsByLlmdocPath.get(docPath);
    if (!document) {
      continue;
    }
    const { matchedFiles, codeDigest } = computeDocumentCodeDigest(document, surface.files);
    nextDocSnapshots[docPath] = { codeDigest, files: matchedFiles };
  }

  const nextCache: SurfaceCacheFile = {
    version: 1,
    statCache: surface.cache.statCache,
    baselineSnapshot: advanceBaseline
      ? {
          surfaceDigest: surface.surfaceDigest,
          capturedAt: new Date().toISOString(),
          files: Object.fromEntries([...surface.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
        }
      : existing.baselineSnapshot,
    documentSnapshots: nextDocSnapshots
  };

  writeSurfaceCache(cachePath, nextCache);
}

/**
 * Computes the list of files that were added, modified, or deleted between two
 * `relPath -> blobHash` snapshots.
 */
export function diffFileMaps(
  previous: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
  current: Readonly<Record<string, string>> | ReadonlyMap<string, string>
): string[] {
  const prevMap = previous instanceof Map ? previous : new Map(Object.entries(previous));
  const currMap = current instanceof Map ? current : new Map(Object.entries(current));
  const changed = new Set<string>();

  for (const [relPath, hash] of currMap) {
    if (prevMap.get(relPath) !== hash) {
      changed.add(relPath);
    }
  }
  for (const relPath of prevMap.keys()) {
    if (!currMap.has(relPath)) {
      changed.add(relPath);
    }
  }

  return [...changed].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function scanGitFastPath(
  scanRoot: string,
  prefix: string,
  ignoreEngine: IgnoreEngine,
  prevStatCache: Record<string, StatCacheEntry>,
  nextStatCache: Record<string, StatCacheEntry>
): { files: Map<string, string>; dirty: Set<string> } | null {
  const indexHashes = readGitIndexBlobHashes(scanRoot);
  if (!indexHashes) {
    return null;
  }
  const workingChanges = readGitWorkingTreeChanges(scanRoot);
  if (!workingChanges) {
    return null;
  }

  const files = new Map<string, string>();
  const dirty = new Set<string>();

  // 1. Seed with clean tracked files from Git index (zero disk reads!).
  for (const [localRel, hash] of indexHashes) {
    if (workingChanges.deleted.has(localRel) || workingChanges.changedOrUntracked.has(localRel)) {
      continue;
    }
    if (!ignoreEngine.isImplementationSurface(localRel)) {
      continue;
    }
    const fullRel = `${prefix}${localRel}`;
    files.set(fullRel, hash);
    // Preserve previous statCache entry if it existed.
    const existingStat = prevStatCache[fullRel];
    if (existingStat && existingStat.hash === hash) {
      nextStatCache[fullRel] = existingStat;
    }
  }

  // 2. Hash dirty / added / untracked files from disk via stat cache + Git blob hash.
  for (const localRel of workingChanges.changedOrUntracked) {
    if (!ignoreEngine.isImplementationSurface(localRel)) {
      continue;
    }
    const absolutePath = path.join(scanRoot, localRel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      continue;
    }
    const fullRel = `${prefix}${localRel}`;
    const hash = hashWithStatCache(absolutePath, fullRel, stat, prevStatCache, nextStatCache);
    files.set(fullRel, hash);
    dirty.add(fullRel);
  }

  // Deleted tracked files also count as dirty implementation paths if they belonged to surface.
  for (const localRel of workingChanges.deleted) {
    if (ignoreEngine.isImplementationSurface(localRel)) {
      dirty.add(`${prefix}${localRel}`);
    }
  }

  return { files, dirty };
}

function scanFilesystemPath(
  scanRoot: string,
  prefix: string,
  ignoreEngine: IgnoreEngine,
  prevStatCache: Record<string, StatCacheEntry>,
  nextStatCache: Record<string, StatCacheEntry>
): { files: Map<string, string>; dirty: Set<string> } {
  const files = new Map<string, string>();
  const dirty = new Set<string>();
  const stack: Array<{ absDir: string; relDir: string }> = [{ absDir: scanRoot, relDir: "" }];

  while (stack.length > 0) {
    const { absDir, relDir } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const localRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreEngine.shouldPruneDirectory(localRel)) {
          continue;
        }
        stack.push({ absDir: absPath, relDir: localRel });
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!ignoreEngine.isImplementationSurface(localRel)) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        continue;
      }
      const fullRel = `${prefix}${localRel}`;
      const hash = hashWithStatCache(absPath, fullRel, stat, prevStatCache, nextStatCache);
      files.set(fullRel, hash);
    }
  }

  return { files, dirty };
}

function hashWithStatCache(
  absolutePath: string,
  fullRel: string,
  stat: fs.Stats,
  prevStatCache: Record<string, StatCacheEntry>,
  nextStatCache: Record<string, StatCacheEntry>
): string {
  const cached = prevStatCache[fullRel];
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    nextStatCache[fullRel] = cached;
    return cached.hash;
  }
  const hash = computeFileBlobHash(absolutePath);
  nextStatCache[fullRel] = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash
  };
  return hash;
}

export function getSurfaceCachePath(rootDir: string): string {
  return path.join(rootDir, CACHE_DIR, SURFACE_CACHE_FILE);
}

function loadSurfaceCache(cachePath: string): SurfaceCacheFile {
  try {
    if (!fs.existsSync(cachePath)) {
      return { version: 1, statCache: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<SurfaceCacheFile>;
    if (parsed.version !== 1 || typeof parsed.statCache !== "object" || parsed.statCache === null) {
      return { version: 1, statCache: {} };
    }
    return {
      version: 1,
      statCache: parsed.statCache,
      baselineSnapshot: parsed.baselineSnapshot,
      documentSnapshots: parsed.documentSnapshots
    };
  } catch {
    return { version: 1, statCache: {} };
  }
}

function writeSurfaceCache(cachePath: string, cache: SurfaceCacheFile): void {
  try {
    ensureDirectory(cachePath);
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // Cache persistence is best-effort and fail-open (e.g. read-only workspace).
  }
}
