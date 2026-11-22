import fs from "node:fs";
import path from "node:path";

import { LLMDOC_CONFIG_FILENAME } from "./config.js";

export const BUILT_IN_IGNORED_DIRS = new Set([".git", ".llmdoc-tmp", "node_modules"]);

export const NON_IMPLEMENTATION_BASENAMES = new Set([
  ".gitignore",
  ".gitattributes",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "pdm.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "flake.lock",
  "Podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "packages.lock.json",
  "gradle.lockfile"
]);

interface CompiledRule {
  negate: boolean;
  dirOnly: boolean;
  basePrefix: string; // "" for root, or "a/b/"
  anchored: boolean;
  regex: RegExp;
}

/**
 * Pure-JS unified ignore engine combining:
 *   1. Built-in exclusions (.git, .llmdoc-tmp, node_modules, llmdoc dir inside root, llmdoc.config.json, lockfiles)
 *   2. Hierarchical `.gitignore` rules (works with or without `.git/`)
 *   3. Root `.llmdocignore` rules
 */
export class IgnoreEngine {
  private readonly rootDir: string;
  private readonly llmdocRelPrefix: string | null;
  private readonly llmdocignoreRules: CompiledRule[];
  private readonly gitignoreCache = new Map<string, CompiledRule[]>();

  constructor(rootDir: string, options?: { llmdocDir?: string }) {
    this.rootDir = path.resolve(rootDir);
    this.llmdocRelPrefix = computeRelativePrefixInsideRoot(this.rootDir, options?.llmdocDir);
    this.llmdocignoreRules = loadIgnoreFileRules(path.join(this.rootDir, ".llmdocignore"), "");
  }

  /**
   * Returns true if the given POSIX root-relative path is ignored by built-in dir rules,
   * hierarchical `.gitignore`, or `.llmdocignore`.
   */
  isIgnored(relPath: string, isDirectory = false): boolean {
    const normalized = normalizeRel(relPath);
    if (!normalized) {
      return false;
    }

    const segments = normalized.split("/");
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      if (BUILT_IN_IGNORED_DIRS.has(seg)) {
        return true;
      }
    }

    // Evaluate hierarchical .gitignore rules from root down to parent directory.
    let ignored = false;
    const ancestorDirs = collectAncestorDirs(normalized);
    for (const dirRel of ancestorDirs) {
      const rules = this.getGitignoreRules(dirRel);
      for (const rule of rules) {
        if (matchesRule(rule, normalized, isDirectory)) {
          ignored = !rule.negate;
        }
      }
    }

    // Evaluate .llmdocignore at root (overrides .gitignore).
    for (const rule of this.llmdocignoreRules) {
      if (matchesRule(rule, normalized, isDirectory)) {
        ignored = !rule.negate;
      }
    }

    return ignored;
  }

  /**
   * Returns true if a directory can be pruned completely during FS traversal.
   * Built-in excluded dirs and llmdocDir inside root are always pruned;
   * ignored directories are pruned when no negation rule can re-include children.
   */
  shouldPruneDirectory(relDir: string): boolean {
    const normalized = normalizeRel(relDir);
    if (!normalized) {
      return false;
    }
    const base = normalized.split("/").pop() ?? normalized;
    if (BUILT_IN_IGNORED_DIRS.has(base)) {
      return true;
    }
    if (this.llmdocRelPrefix && (normalized === this.llmdocRelPrefix.slice(0, -1) || normalized.startsWith(this.llmdocRelPrefix))) {
      return true;
    }
    return this.isIgnored(normalized, true);
  }

  /**
   * Returns true if `relPath` belongs to the implementation surface
   * (eligible for codeDigest, unmapped detection, and delta impact).
   */
  isImplementationSurface(relPath: string): boolean {
    const normalized = normalizeRel(relPath);
    if (!normalized) {
      return false;
    }
    if (normalized === LLMDOC_CONFIG_FILENAME) {
      return false;
    }
    if (this.llmdocRelPrefix && normalized.startsWith(this.llmdocRelPrefix)) {
      return false;
    }
    if (normalized.startsWith("llmdoc/") && !this.llmdocRelPrefix) {
      // Fallback when llmdocDir was not explicitly passed.
      return false;
    }
    if (normalized.startsWith(".llmdoc-tmp/") || normalized.startsWith(".git/")) {
      return false;
    }
    const basename = normalized.split("/").pop() ?? normalized;
    if (NON_IMPLEMENTATION_BASENAMES.has(basename)) {
      return false;
    }
    return !this.isIgnored(normalized, false);
  }

  private getGitignoreRules(dirRel: string): CompiledRule[] {
    const cached = this.gitignoreCache.get(dirRel);
    if (cached !== undefined) {
      return cached;
    }
    const ignoreFile = dirRel ? path.join(this.rootDir, dirRel, ".gitignore") : path.join(this.rootDir, ".gitignore");
    const basePrefix = dirRel ? `${dirRel}/` : "";
    const rules = loadIgnoreFileRules(ignoreFile, basePrefix);
    this.gitignoreCache.set(dirRel, rules);
    return rules;
  }
}

export function createIgnoreEngine(rootDir: string, options?: { llmdocDir?: string }): IgnoreEngine {
  return new IgnoreEngine(rootDir, options);
}

function computeRelativePrefixInsideRoot(rootDir: string, llmdocDir?: string): string | null {
  if (!llmdocDir) {
    return "llmdoc/";
  }
  let resolvedRoot = path.resolve(rootDir);
  let resolvedDocs = path.resolve(llmdocDir);
  try {
    resolvedRoot = fs.realpathSync(resolvedRoot);
    if (fs.existsSync(resolvedDocs)) {
      resolvedDocs = fs.realpathSync(resolvedDocs);
    }
  } catch {
    // keep path.resolve fallback
  }
  const rel = path.relative(resolvedRoot, resolvedDocs).replaceAll(path.sep, "/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return `${rel.replace(/\/+$/, "")}/`;
}

function collectAncestorDirs(relPath: string): string[] {
  const parts = relPath.split("/");
  const dirs: string[] = [""];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
    dirs.push(acc);
  }
  return dirs;
}

function loadIgnoreFileRules(filePath: string, basePrefix: string): CompiledRule[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return parseIgnoreRules(content, basePrefix);
}

export function parseIgnoreRules(content: string, basePrefix = ""): CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const rule = compileIgnoreLine(rawLine, basePrefix);
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

function compileIgnoreLine(rawLine: string, basePrefix: string): CompiledRule | null {
  // Strip unescaped trailing spaces
  let line = rawLine.replace(/(?<!\\)[ \t]+$/, "");
  if (!line || line.startsWith("#")) {
    return null;
  }

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
    line = line.slice(1);
  }

  if (line.startsWith("./")) {
    line = line.slice(2);
  }

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.replace(/\/+$/, "");
  }

  if (!line) {
    return null;
  }

  let anchored = false;
  if (line.startsWith("/")) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes("/")) {
    anchored = true;
  }

  if (!line) {
    return null;
  }

  const regexSource = globToRegexSource(line);
  const pattern = anchored ? `^${regexSource}$` : `(?:^|/)${regexSource}$`;
  return {
    negate,
    dirOnly,
    basePrefix,
    anchored,
    regex: new RegExp(pattern)
  };
}

function matchesRule(rule: CompiledRule, relPath: string, isDirectory: boolean): boolean {
  if (rule.basePrefix && !relPath.startsWith(rule.basePrefix)) {
    return false;
  }
  const localPath = rule.basePrefix ? relPath.slice(rule.basePrefix.length) : relPath;
  if (!localPath) {
    return false;
  }

  if (rule.dirOnly) {
    // For a directory itself, test localPath directly.
    if (isDirectory && rule.regex.test(localPath)) {
      return true;
    }
    // For a file (or nested path), test every parent directory prefix inside basePrefix.
    const parts = localPath.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      if (rule.regex.test(prefix)) {
        return true;
      }
    }
    return false;
  }

  if (rule.regex.test(localPath)) {
    return true;
  }
  // If a non-negated pattern matches an ancestor directory (e.g. `dist` matches `dist/a.js`),
  // that ancestor directory and its descendants are ignored.
  const parts = localPath.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
    if (rule.regex.test(prefix)) {
      return true;
    }
  }
  return false;
}

function globToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) {
        out += escapeRegex(next);
        i += 2;
      } else {
        out += "\\\\";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // Handle `**/`, `/**`, or standalone `**`
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const closeIndex = findBracketClose(pattern, i + 1);
      if (closeIndex !== -1) {
        let content = pattern.slice(i + 1, closeIndex);
        if (content.startsWith("!")) {
          content = `^${content.slice(1)}`;
        }
        out += `[${content}]`;
        i = closeIndex + 1;
        continue;
      }
    }
    out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

function findBracketClose(pattern: string, start: number): number {
  let i = start;
  if (pattern[i] === "!" || pattern[i] === "^") {
    i += 1;
  }
  if (pattern[i] === "]") {
    i += 1;
  }
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] === "]") {
      return i;
    }
    i += 1;
  }
  return -1;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRel(input: string): string {
  let normalized = input.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}
