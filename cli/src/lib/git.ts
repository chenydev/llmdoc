import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GitState } from "../types.js";

export function isDirectGitRoot(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(path.join(resolved, ".git"))) {
    return false;
  }
  const top = runGitSafe(resolved, ["rev-parse", "--show-toplevel"]);
  if (!top) {
    return false;
  }
  try {
    return fs.realpathSync(top) === fs.realpathSync(resolved);
  } catch {
    return path.resolve(top) === resolved;
  }
}

export function gitCommitExists(rootDir: string, revision: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
    cwd: rootDir,
    encoding: "utf8"
  });
  return result.status === 0;
}

export function isUnbornHead(rootDir: string): boolean {
  if (!isGitRepository(rootDir) || runGitSafe(rootDir, ["rev-parse", "--verify", "HEAD"]) !== null) {
    return false;
  }
  return runGitSafe(rootDir, ["symbolic-ref", "--quiet", "HEAD"]) !== null;
}

// shallow clone(CI 常态)里历史 commit 不可达,revision 校验需要据此降级而不是误报陈旧。
export function isShallowRepository(rootDir: string): boolean {
  return runGitSafe(rootDir, ["rev-parse", "--is-shallow-repository"]) === "true";
}

export function isGitRepository(rootDir: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * Reads optional Git state for a workspace root.
 * When `legacyStrict` is false (v4 content-digest mode), non-Git directories,
 * unborn branches, and missing/rebased hint revisions are NOT degraded errors.
 */
export function readGitState(
  rootDir: string,
  baselineRevision: string | null,
  options?: { legacyStrict?: boolean }
): GitState {
  const legacyStrict = options?.legacyStrict ?? false;
  if (!isDirectGitRoot(rootDir) && !isGitRepository(rootDir)) {
    return {
      available: false,
      headRevision: null,
      detached: false,
      inProgressOperation: null,
      baselineBehindHead: null,
      committedChangedPaths: [],
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      degradedReason: legacyStrict
        ? "The current directory is not a Git repository; state diagnostics are unavailable."
        : null
    };
  }

  // Only treat rootDir as a Git-backed workspace when rootDir itself is a direct Git root;
  // federated multi-repo directories (rootDir has no .git, subdirs have .git) use pure FS mode.
  if (!isDirectGitRoot(rootDir)) {
    return {
      available: false,
      headRevision: null,
      detached: false,
      inProgressOperation: null,
      baselineBehindHead: null,
      committedChangedPaths: [],
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: [],
      degradedReason: null
    };
  }

  const headRevision = runGitSafe(rootDir, ["rev-parse", "--verify", "HEAD"]);
  const detached = headRevision !== null && runGitSafe(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) === null;
  const inProgressOperation = detectInProgressOperation(rootDir);
  const stagedPaths = headRevision
    ? readPathList(rootDir, ["diff", "--name-only", "--no-renames", "--cached"])
    : readPathList(rootDir, ["ls-files", "--cached"]);
  const unstagedPaths = readPathList(rootDir, ["diff", "--name-only", "--no-renames"]);
  const untrackedPaths = readPathList(rootDir, ["ls-files", "--others", "--exclude-standard"]);
  const committedChangedPaths =
    baselineRevision && headRevision && gitCommitExists(rootDir, baselineRevision)
      ? readPathList(rootDir, ["diff", "--name-only", "--no-renames", `${baselineRevision}..${headRevision}`])
      : [];
  const baselineBehindHead =
    baselineRevision && headRevision && gitCommitExists(rootDir, baselineRevision)
      ? readBehindCount(rootDir, baselineRevision, headRevision)
      : null;

  let degradedReason: string | null = null;
  if (legacyStrict) {
    if (!headRevision) {
      degradedReason = isUnbornHead(rootDir) ? "HEAD has no commit (the current branch is unborn)." : "Unable to resolve the HEAD commit.";
    } else if (baselineRevision && !gitCommitExists(rootDir, baselineRevision)) {
      degradedReason = `baseline.revision does not exist in current Git history: ${baselineRevision}`;
    }
  }

  return {
    available: true,
    headRevision,
    detached,
    inProgressOperation,
    baselineBehindHead,
    committedChangedPaths,
    stagedPaths,
    unstagedPaths,
    untrackedPaths,
    degradedReason
  };
}

/**
 * Reads tracked file blob hashes from the Git index with zero file content reads.
 * Returns null if git fails.
 */
export function readGitIndexBlobHashes(rootDir: string): Map<string, string> | null {
  const result = spawnSync("git", ["-c", "core.quotePath=false", "ls-files", "-s", "-z"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    return null;
  }
  const hashes = new Map<string, string>();
  const entries = result.stdout.split("\0");
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const tabIdx = entry.indexOf("\t");
    if (tabIdx === -1) {
      continue;
    }
    const meta = entry.slice(0, tabIdx).trim().split(/\s+/);
    const filePath = entry.slice(tabIdx + 1);
    const mode = meta[0];
    const hash = meta[1];
    // Regular files only (100644 or 100755); skip symlinks (120000) and submodules (160000).
    if ((mode === "100644" || mode === "100755") && hash && filePath) {
      hashes.set(filePath, hash);
    }
  }
  return hashes;
}

/**
 * Reads Git working-tree status via `-z` NUL-delimited porcelain v1 output.
 * Distinguishes deleted paths from modified/added/untracked paths so the hybrid
 * surface engine only hashes dirty/untracked files on disk.
 */
export function readGitWorkingTreeChanges(rootDir: string): {
  changedOrUntracked: Set<string>;
  deleted: Set<string>;
} | null {
  const result = spawnSync("git", ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    return null;
  }
  const changedOrUntracked = new Set<string>();
  const deleted = new Set<string>();
  const tokens = result.stdout.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.length < 4) {
      continue;
    }
    const x = token[0]!;
    const y = token[1]!;
    const filePath = token.slice(3);

    // Rename or copy in porcelain -z consumes a second NUL-delimited path (the old path).
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const oldPath = tokens[i + 1];
      i += 1;
      if (oldPath) {
        deleted.add(oldPath);
      }
      if (filePath) {
        changedOrUntracked.add(filePath);
      }
      continue;
    }

    if (y === "D" || (x === "D" && y === " ")) {
      deleted.add(filePath);
    } else if (filePath) {
      changedOrUntracked.add(filePath);
    }
  }
  return { changedOrUntracked, deleted };
}

/**
 * Reads blob hashes for every regular file in a historical Git commit tree.
 * Used for lossless v3 -> v4 migration and cold-start file-level diff breakdown.
 */
export function readGitTreeBlobHashes(rootDir: string, revision: string): Map<string, string> | null {
  if (!gitCommitExists(rootDir, revision)) {
    return null;
  }
  const result = spawnSync("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", revision], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    return null;
  }
  const hashes = new Map<string, string>();
  for (const entry of result.stdout.split("\0")) {
    if (!entry) {
      continue;
    }
    const tabIdx = entry.indexOf("\t");
    if (tabIdx === -1) {
      continue;
    }
    const meta = entry.slice(0, tabIdx).trim().split(/\s+/);
    const filePath = entry.slice(tabIdx + 1);
    const mode = meta[0];
    const type = meta[1];
    const hash = meta[2];
    if (type === "blob" && (mode === "100644" || mode === "100755") && hash && filePath) {
      hashes.set(filePath, hash);
    }
  }
  return hashes;
}

export function readChangedPathsSince(rootDir: string, revision: string, headRevision: string): string[] {
  if (!gitCommitExists(rootDir, revision)) {
    return [];
  }
  return readPathList(rootDir, ["diff", "--name-only", "--no-renames", `${revision}..${headRevision}`]);
}

// 逐 commit 列出 baseline..HEAD 中每个提交触碰的路径,供"有效源码落后"计数:
// \x01 前缀作 commit 分隔哨兵,避免 40 位 hex 路径名的歧义;merge commit 默认不列文件,视为无自身变更。
export function readCommitsWithChangedPathsSince(
  rootDir: string,
  revision: string,
  headRevision: string
): Array<{ revision: string; paths: string[] }> | null {
  if (!gitCommitExists(rootDir, revision)) {
    return null;
  }
  const output = runGitSafe(rootDir, ["log", "--format=%x01%H", "--name-only", "--no-renames", `${revision}..${headRevision}`]);
  if (output === null) {
    return null;
  }
  const commits: Array<{ revision: string; paths: string[] }> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("\u0001")) {
      commits.push({ revision: trimmed.slice(1), paths: [] });
    } else if (commits.length > 0) {
      commits[commits.length - 1]!.paths.push(trimmed);
    }
  }
  return commits;
}

export function canAdvanceRevisions(gitState: GitState): { ok: true } | { ok: false; reason: string } {
  if (gitState.available && gitState.inProgressOperation) {
    return { ok: false, reason: `${gitState.inProgressOperation} is in progress; revisions cannot advance.` };
  }
  return { ok: true };
}

function runGitSafe(rootDir: string, args: string[]): string | null {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function readPathList(rootDir: string, args: string[]): string[] {
  const output = runGitSafe(rootDir, args);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readBehindCount(rootDir: string, baselineRevision: string, headRevision: string): number | null {
  const output = runGitSafe(rootDir, ["rev-list", "--count", `${baselineRevision}..${headRevision}`]);
  if (!output) {
    return null;
  }
  const count = Number.parseInt(output, 10);
  return Number.isNaN(count) ? null : count;
}

function detectInProgressOperation(rootDir: string): "merge" | "rebase" | "cherry-pick" | null {
  const gitDir = runGitSafe(rootDir, ["rev-parse", "--git-dir"]);
  if (!gitDir) {
    return null;
  }
  const resolvedGitDir = path.resolve(rootDir, gitDir);
  if (fs.existsSync(path.join(resolvedGitDir, "rebase-merge")) || fs.existsSync(path.join(resolvedGitDir, "rebase-apply"))) {
    return "rebase";
  }
  if (fs.existsSync(path.join(resolvedGitDir, "MERGE_HEAD"))) {
    return "merge";
  }
  if (fs.existsSync(path.join(resolvedGitDir, "CHERRY_PICK_HEAD"))) {
    return "cherry-pick";
  }
  return null;
}
