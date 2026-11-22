import path from "node:path";
import { spawnSync } from "node:child_process";

import { CliError } from "../lib/errors.js";
import { findProjectRoot, isWithinRoot, repoPath } from "../lib/fs.js";
import { isDirectGitRoot } from "../lib/git.js";
import { executeFinalize } from "./finalize.js";
import { loadWorkspace } from "../lib/workspace.js";
import type { WorkspaceResolutionOptions } from "../types.js";
import fs from "node:fs";

interface CommitOptions extends WorkspaceResolutionOptions {
  cwd: string;
  message?: string;
  all?: boolean;
  verified?: string[];
  requireClean?: boolean;
  noVerify?: boolean;
  json?: boolean;
}

/**
 * Optional Git wrapper around `llmdoc finalize`:
 * Because `llmdoc.meta/v4` tracks content digests instead of self-referential commit SHAs,
 * prose edits and `meta.json` land in ONE single Git commit — eliminating the second
 * `chore(llmdoc): refresh fingerprints` commit forever.
 */
export function runCommit(options: CommitOptions): unknown {
  const rootDir = findProjectRoot(options.cwd, options);
  if (!isDirectGitRoot(rootDir)) {
    throw new CliError(
      "commit requires a Git repository at the workspace root. In non-Git or multi-repo workspaces, use `llmdoc finalize` instead."
    );
  }

  const workspace = loadWorkspace(rootDir, options);
  const verifiedPaths = uniquePaths(
    (options.verified ?? []).map((value) => (value.startsWith("llmdoc/") ? value.slice("llmdoc/".length) : value))
  );
  if (options.all && verifiedPaths.length > 0) {
    throw new CliError("commit cannot use --all and --verified together.");
  }
  for (const docPath of verifiedPaths) {
    if (!workspace.documentsByLlmdocPath.has(docPath)) {
      throw new CliError(`Document does not exist: ${docPath}`);
    }
  }

  // Determine which tracked paths inside this Git root belong to the llmdoc write-set.
  const trackedDirs: string[] = [];
  const docsRel = getRepoRelativeIfInside(rootDir, workspace.llmdocDir);
  if (docsRel) {
    trackedDirs.push(docsRel);
  }
  const metaRel = workspace.metaLocation === "tracked" ? getRepoRelativeIfInside(rootDir, workspace.metaPath) : null;
  if (metaRel && (!docsRel || !metaRel.startsWith(`${docsRel}/`))) {
    trackedDirs.push(metaRel);
  }
  if (trackedDirs.length === 0) {
    throw new CliError(
      "Docs directory and ledger are both outside this Git repository; use `llmdoc finalize` instead of `llmdoc commit`."
    );
  }

  const porcelainBefore = runGit(rootDir, ["status", "--porcelain", "--", ...trackedDirs]);
  const changedDocPaths = docsRel
    ? porcelainBefore
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .map((filePath) => (filePath.includes(" -> ") ? filePath.split(" -> ").pop()! : filePath))
        .filter((filePath) => filePath.startsWith(`${docsRel}/`) && filePath.endsWith(".mdx"))
        .map((filePath) => filePath.slice(docsRel.length + 1))
        .filter((llmdocPath) => workspace.documentsByLlmdocPath.has(llmdocPath))
    : [];

  const targetPaths = options.all ? [] : uniquePaths([...changedDocPaths, ...verifiedPaths]);

  // Run the core Git-free finalize primitive (validates, updates content digests, writes meta.json).
  let finalized;
  try {
    finalized = executeFinalize({
      cwd: rootDir,
      root: options.root,
      docsDir: options.docsDir,
      all: options.all,
      verified: options.all ? undefined : targetPaths,
      requireClean: options.requireClean
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Finalize preflight failed:")) {
      throw new CliError(message.replace("Finalize preflight failed:", "Fingerprint preflight failed; no commit was created:"), 70);
    }
    throw error;
  }

  const porcelainAfter = runGit(rootDir, ["status", "--porcelain", "--", ...trackedDirs]);
  if (!porcelainAfter.trim()) {
    return options.json
      ? { status: "no_change", commits: [], updated: [] }
      : "no_change: llmdoc/ has no changes to commit";
  }

  const verifyFlags = options.noVerify ? ["--no-verify"] : [];
  const defaultMsg =
    changedDocPaths.length > 0 ? "docs(llmdoc): update knowledge" : "chore(llmdoc): refresh fingerprints";

  runGit(rootDir, ["add", "--", ...trackedDirs]);
  runGit(rootDir, ["commit", ...verifyFlags, "-m", options.message ?? defaultMsg, "--", ...trackedDirs]);
  const singleCommit = runGit(rootDir, ["rev-parse", "HEAD"]).trim();

  if (options.json) {
    return {
      status: "success",
      commits: [singleCommit],
      updated: finalized.updated,
      baselineAdvanced: Boolean(options.all),
      baselineDigest: finalized.baselineDigest,
      ...(finalized.dirtyPaths.length > 0 ? { dirtyPaths: finalized.dirtyPaths } : {})
    };
  }

  const lines = [
    `committed: ${singleCommit.slice(0, 7)} (docs + meta)`,
    `fingerprints: ${finalized.updated.length} document(s)${options.all ? ", baseline advanced" : ""}`
  ];
  if (finalized.dirtyPaths.length > 0) {
    lines.push(`note: finalized against uncommitted workspace changes (${finalized.dirtyPaths.length} file(s))`);
  }
  return lines.join("\n");
}

function getRepoRelativeIfInside(rootDir: string, targetPath: string): string | null {
  try {
    const rootReal = fs.realpathSync(rootDir);
    const targetReal = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
    if (!isWithinRoot(rootReal, targetReal)) {
      return null;
    }
    const rel = repoPath(rootReal, targetReal);
    return rel || null;
  } catch {
    return null;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function runGit(rootDir: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd: rootDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new CliError((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout;
}
