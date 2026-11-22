import fs from "node:fs";
import path from "node:path";

import type { WorkspaceResolutionOptions } from "../types.js";
import { CliError } from "./errors.js";

const CONFIG_FILE = "llmdoc.config.json";

export function resolveExplicitRoot(options?: WorkspaceResolutionOptions): string | null {
  const raw = options?.root?.trim() || process.env.LLMDOC_ROOT?.trim() || "";
  if (!raw) {
    return null;
  }
  const resolved = path.resolve(raw);
  if (!isDirectory(resolved)) {
    throw new CliError(`Specified project root does not exist or is not a directory: ${raw}`, 2);
  }
  return resolved;
}

export function resolveExplicitDocsDir(startDir: string, options?: WorkspaceResolutionOptions): string | null {
  const raw = options?.docsDir?.trim() || process.env.LLMDOC_DOCS_DIR?.trim() || "";
  if (!raw) {
    return null;
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(startDir, raw);
}

export function findProjectRoot(startDir: string, options?: WorkspaceResolutionOptions): string {
  const found = findProjectRootOrNull(startDir, options);
  if (found) {
    return found;
  }
  throw new CliError("No llmdoc/ directory or llmdoc.config.json was found. Run this command inside an llmdoc workspace.", 2);
}

/**
 * Project root discovery for `new` (allows initializing a workspace even without Git):
 *   --root / LLMDOC_ROOT > ancestor llmdoc.config.json > ancestor llmdoc/ > nearest .git root > cwd
 */
export function findProjectRootForNew(startDir: string, options?: WorkspaceResolutionOptions): string {
  const start = path.resolve(startDir);
  const explicit = resolveExplicitRoot(options);
  if (explicit) {
    return explicit;
  }
  const existingWorkspace = findProjectRootOrNull(start, options);
  if (existingWorkspace) {
    return existingWorkspace;
  }
  const gitRoot = findNearestGitRootOrNull(start);
  if (gitRoot) {
    return gitRoot;
  }
  return start;
}

/**
 * Project root discovery priority (never truncated by nested sub-repo `.git`):
 *   1. --root / LLMDOC_ROOT
 *   2. Walk up for `llmdoc.config.json` (crossing nested `.git`)
 *   3. Walk up for `llmdoc/` (crossing nested `.git`)
 *   4. When --docs-dir / LLMDOC_DOCS_DIR is explicitly provided: nearest `.git` root or startDir
 */
export function findProjectRootOrNull(startDir: string, options?: WorkspaceResolutionOptions): string | null {
  const start = path.resolve(startDir);
  const explicit = resolveExplicitRoot(options);
  if (explicit) {
    return explicit;
  }

  const configRoot = walkUpForFile(start, CONFIG_FILE);
  if (configRoot) {
    return configRoot;
  }

  const llmdocRoot = walkUpForLlmdocDir(start);
  if (llmdocRoot) {
    return llmdocRoot;
  }

  const explicitDocsDir = resolveExplicitDocsDir(start, options);
  if (explicitDocsDir) {
    return findNearestGitRootOrNull(start) ?? start;
  }

  return null;
}

export function findNearestGitRootOrNull(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function walkUpForFile(startDir: string, fileName: string): string | null {
  let current = startDir;
  while (true) {
    if (isFile(path.join(current, fileName))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function walkUpForLlmdocDir(startDir: string): string | null {
  let current = startDir;
  let crossedGitBoundary = false;
  while (true) {
    const candidate = path.join(current, "llmdoc");
    if (isValidLlmdocDirCandidate(candidate, startDir, crossedGitBoundary)) {
      return current;
    }
    if (fs.existsSync(path.join(current, ".git"))) {
      crossedGitBoundary = true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isValidLlmdocDirCandidate(candidateDir: string, startDir: string, crossedGitBoundary: boolean): boolean {
  if (!isDirectory(candidateDir)) {
    return false;
  }
  const insideCandidate = startDir === candidateDir || startDir.startsWith(`${candidateDir}${path.sep}`);
  if (!insideCandidate && !crossedGitBoundary) {
    return true;
  }
  // When walking above a nested `.git` boundary or when startDir is inside an ancestor named `llmdoc`,
  // require genuine llmdoc knowledge markers (meta.json or .mdx) and reject a Git repo merely named `llmdoc`.
  if (fs.existsSync(path.join(candidateDir, ".git"))) {
    return false;
  }
  if (fs.existsSync(path.join(candidateDir, "meta.json"))) {
    return true;
  }
  try {
    return fs.readdirSync(candidateDir).some((name) => name.endsWith(".mdx"));
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function normalizeRepoRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new CliError(`Invalid path: ${input}`);
  }
  const parts = normalized.split("/").filter((part) => part !== ".");
  if (parts.length === 0) {
    throw new CliError(`Invalid path: ${input}`);
  }
  if (parts.some((part) => part === ".." || part === "")) {
    throw new CliError(`Path must be a normalized repository-relative path: ${input}`);
  }
  return parts.join("/");
}

export function resolveInsideRoot(rootDir: string, repoRelativePath: string, options?: { allowMissing?: boolean }): string {
  const safeRelativePath = normalizeRepoRelativePath(repoRelativePath);
  const candidate = path.join(rootDir, safeRelativePath);
  const rootRealPath = fs.realpathSync(rootDir);
  const nearestExistingAncestor = findNearestExistingAncestor(candidate);
  const ancestorRealPath = fs.realpathSync(nearestExistingAncestor);

  if (!isWithinRoot(rootRealPath, ancestorRealPath)) {
    throw new CliError(`Path escapes the repository directly or through a symlink: ${repoRelativePath}`);
  }

  if (fs.existsSync(candidate)) {
    const candidateRealPath = fs.realpathSync(candidate);
    if (!isWithinRoot(rootRealPath, candidateRealPath)) {
      throw new CliError(`Path escapes the repository directly or through a symlink: ${repoRelativePath}`);
    }
    return candidateRealPath;
  }

  if (options?.allowMissing) {
    return candidate;
  }

  throw new CliError(`Path does not exist: ${repoRelativePath}`);
}

export function isWithinRoot(rootRealPath: string, candidateRealPath: string): boolean {
  return candidateRealPath === rootRealPath || candidateRealPath.startsWith(`${rootRealPath}${path.sep}`);
}

export function toPosixRelative(fromDir: string, toPath: string): string {
  return path.relative(fromDir, toPath).replaceAll(path.sep, "/");
}

export function ensureDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function repoPath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replaceAll(path.sep, "/");
}

function findNearestExistingAncestor(candidatePath: string): string {
  let current = path.resolve(path.dirname(candidatePath));
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}
