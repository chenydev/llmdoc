import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

import {
  DocumentFrontmatter,
  LlmdocConfig,
  MetaLedger,
  ParsedDocument,
  ResolvedCodeRoot,
  ValidationIssue,
  WorkspaceData,
  WorkspaceResolutionOptions
} from "../types.js";
import { DOC_LINE_WARNING_LIMIT } from "./constants.js";
import { CliError } from "./errors.js";
import {
  estimateTokens,
  extractCodeRefs,
  extractLinks,
  extractTitle,
  resolveDocLink,
  stripMarkdownLiterals,
  validateCodeRefTags
} from "./markdown.js";
import { assertDocKindMatchesShape, parseDocTargetShape } from "./doc-shape.js";
import { isWithinRoot, normalizeRepoRelativePath, repoPath, resolveExplicitDocsDir, resolveInsideRoot } from "./fs.js";
import { gitCommitExists, isGitRepository, isShallowRepository } from "./git.js";
import { createIgnoreEngine, IgnoreEngine } from "./ignore.js";
import { matchesCodePathPattern } from "./search.js";
import { validateDocFrontmatter, validateMeta } from "./schema.js";
import { LLMDOC_CONFIG_FILENAME, loadLlmdocConfig } from "./config.js";

export interface ResolvedWorkspaceLayout {
  rootDir: string;
  llmdocDir: string;
  docsDirExternal: boolean;
  codeRoots: ResolvedCodeRoot[];
  metaPath: string;
  metaLocation: "tracked" | "local";
  metaDisplayPath: string;
  configIssues: ValidationIssue[];
}

export function resolveWorkspaceLayout(
  rootDir: string,
  options?: Pick<WorkspaceResolutionOptions, "docsDir"> & { allowMissingDocsDir?: boolean }
): ResolvedWorkspaceLayout {
  const resolvedRoot = path.resolve(rootDir);
  const earlyConfig = loadLlmdocConfig(resolvedRoot);
  const config = earlyConfig.config;
  const configIssues: ValidationIssue[] = [];

  const explicitDocsDir = resolveExplicitDocsDir(resolvedRoot, options);
  const configuredDocsDir = config?.docsDir?.trim() || null;

  let llmdocDir: string;
  let docsDirExternal = false;

  if (explicitDocsDir) {
    llmdocDir = explicitDocsDir;
    docsDirExternal = !isPathInsideDir(resolvedRoot, llmdocDir);
  } else if (configuredDocsDir) {
    llmdocDir = path.isAbsolute(configuredDocsDir)
      ? path.resolve(configuredDocsDir)
      : path.resolve(resolvedRoot, configuredDocsDir);
    docsDirExternal = !isPathInsideDir(resolvedRoot, llmdocDir);
  } else {
    const defaultDocsDir = path.join(resolvedRoot, "llmdoc");
    if (fs.existsSync(defaultDocsDir)) {
      resolveInsideRoot(resolvedRoot, "llmdoc");
    }
    llmdocDir = defaultDocsDir;
    docsDirExternal = false;
  }

  if (!options?.allowMissingDocsDir && (!fs.existsSync(llmdocDir) || !fs.statSync(llmdocDir).isDirectory())) {
    throw new CliError(`The workspace does not contain a docs directory at ${llmdocDir}.`, 2);
  }

  const codeRoots = resolveCodeRoots(resolvedRoot, config, configIssues);
  const { metaPath, metaLocation, metaDisplayPath } = resolveMetaPath(resolvedRoot, llmdocDir, config);

  return {
    rootDir: resolvedRoot,
    llmdocDir,
    docsDirExternal,
    codeRoots,
    metaPath,
    metaLocation,
    metaDisplayPath,
    configIssues
  };
}

export function loadWorkspace(rootDir: string, options?: Pick<WorkspaceResolutionOptions, "docsDir">): WorkspaceData {
  const layout = resolveWorkspaceLayout(rootDir, options);
  const preloadIssues: ValidationIssue[] = [...layout.configIssues];

  const documents = scanDocuments(layout.llmdocDir, preloadIssues);
  const documentsByLlmdocPath = new Map(documents.map((document) => [document.llmdocPath, document]));
  const topics = new Map<string, ParsedDocument[]>();
  const rootSingletons: ParsedDocument[] = [];

  for (const document of documents) {
    if (document.topic) {
      const bucket = topics.get(document.topic) ?? [];
      bucket.push(document);
      topics.set(document.topic, bucket);
    } else {
      rootSingletons.push(document);
    }
  }

  for (const docs of topics.values()) {
    docs.sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath));
  }
  rootSingletons.sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath));

  const meta = loadMeta(layout.metaPath, layout.metaDisplayPath, preloadIssues);
  const llmdocConfig = loadLlmdocConfig(layout.rootDir, documentsByLlmdocPath);

  return {
    rootDir: layout.rootDir,
    llmdocDir: layout.llmdocDir,
    docsDirExternal: layout.docsDirExternal,
    codeRoots: layout.codeRoots,
    metaPath: layout.metaPath,
    metaLocation: layout.metaLocation,
    metaDisplayPath: layout.metaDisplayPath,
    documents,
    documentsByLlmdocPath,
    topics,
    rootSingletons,
    meta,
    llmdocConfig,
    preloadIssues
  };
}

export function resolveDocPathInWorkspace(
  llmdocDir: string,
  llmdocRelativePath: string,
  options?: { allowMissing?: boolean }
): string {
  const cleanRel = llmdocRelativePath.startsWith("llmdoc/")
    ? llmdocRelativePath.slice("llmdoc/".length)
    : llmdocRelativePath;
  return resolveInsideRoot(llmdocDir, cleanRel, options);
}

export function resolveCodePathInWorkspace(
  workspace: Pick<WorkspaceData, "rootDir" | "codeRoots">,
  input: string,
  options?: { allowMissing?: boolean }
): { absolutePath: string; normalized: string; codeRoot: ResolvedCodeRoot } {
  const normalized = normalizeRepoRelativePath(input);
  const namedRoots = workspace.codeRoots
    .filter((root): root is ResolvedCodeRoot & { name: string } => Boolean(root.name))
    .sort((left, right) => right.name.length - left.name.length);

  for (const root of namedRoots) {
    if (normalized === root.name) {
      const absolutePath = fs.existsSync(root.absolutePath) ? fs.realpathSync(root.absolutePath) : root.absolutePath;
      return { absolutePath, normalized, codeRoot: root };
    }
    if (normalized.startsWith(`${root.name}/`)) {
      const innerPath = normalized.slice(root.name.length + 1);
      const absolutePath = resolveInsideRoot(root.absolutePath, innerPath, options);
      return { absolutePath, normalized, codeRoot: root };
    }
  }

  const defaultRoot: ResolvedCodeRoot = workspace.codeRoots.find((root) => root.name === null) ?? {
    name: null,
    configuredPath: ".",
    absolutePath: workspace.rootDir
  };
  const absolutePath = resolveInsideRoot(defaultRoot.absolutePath, normalized, options);
  return { absolutePath, normalized, codeRoot: defaultRoot };
}

function resolveCodeRoots(rootDir: string, config: LlmdocConfig | null, issues: ValidationIssue[]): ResolvedCodeRoot[] {
  const configured = config?.codeRoots;
  if (!configured || configured.length === 0) {
    return [{ name: null, configuredPath: ".", absolutePath: rootDir }];
  }

  const resolvedRoots: ResolvedCodeRoot[] = [];
  const seenNames = new Set<string>();
  const rootRealPath = safeRealpath(rootDir);

  for (const entry of configured) {
    const rawPath = typeof entry === "string" ? entry : entry.path;
    const absolutePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rootDir, rawPath);
    let name: string;
    if (typeof entry === "string") {
      const rel = path.relative(rootRealPath, safeRealpath(absolutePath)).replaceAll(path.sep, "/");
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        name = rel.replace(/\/+$/, "");
      } else {
        name = path.basename(absolutePath);
      }
    } else {
      name = entry.name;
    }

    if (seenNames.has(name)) {
      issues.push({
        severity: "error",
        code: "config.codeRoots.duplicate",
        path: LLMDOC_CONFIG_FILENAME,
        message: `Duplicate codeRoots name: ${name}`
      });
      continue;
    }
    seenNames.add(name);

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
      issues.push({
        severity: "error",
        code: "config.codeRoots.missing",
        path: LLMDOC_CONFIG_FILENAME,
        message: `Configured codeRoot does not exist or is not a directory: ${rawPath}`
      });
      continue;
    }

    resolvedRoots.push({
      name,
      configuredPath: rawPath,
      absolutePath: safeRealpath(absolutePath)
    });
  }

  return resolvedRoots;
}

function resolveMetaPath(
  rootDir: string,
  llmdocDir: string,
  config: LlmdocConfig | null
): { metaPath: string; metaLocation: "tracked" | "local"; metaDisplayPath: string } {
  const location = config?.state?.location ?? "tracked";
  if (location === "local") {
    const localPref = config?.state?.localPath?.trim() || "project";
    let metaPath: string;
    if (localPref === "user") {
      const stateBase = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
      const workspaceId = crypto
        .createHash("sha256")
        .update(`${safeRealpath(rootDir)}\0${safeRealpath(llmdocDir)}`)
        .digest("hex")
        .slice(0, 16);
      metaPath = path.join(stateBase, "llmdoc", workspaceId, "meta.json");
    } else if (localPref === "project") {
      metaPath = path.join(rootDir, ".llmdoc-tmp", "meta.json");
    } else {
      metaPath = path.isAbsolute(localPref) ? path.resolve(localPref) : path.resolve(rootDir, localPref);
    }
    const metaDisplayPath = isPathInsideDir(rootDir, metaPath) ? repoPath(rootDir, metaPath) : metaPath;
    return { metaPath, metaLocation: "local", metaDisplayPath };
  }

  const metaPath = path.join(llmdocDir, "meta.json");
  const metaDisplayPath = isPathInsideDir(rootDir, metaPath) ? repoPath(rootDir, metaPath) : metaPath;
  return { metaPath, metaLocation: "tracked", metaDisplayPath };
}

function scanDocuments(llmdocDir: string, preloadIssues: ValidationIssue[]): ParsedDocument[] {
  const results: ParsedDocument[] = [];
  const docsRealPath = fs.realpathSync(llmdocDir);

  walk(llmdocDir, (absolutePath) => {
    const llmdocRelativePath = repoPath(llmdocDir, absolutePath);
    const displayRepoPath = `llmdoc/${llmdocRelativePath}`;

    let resolvedAbs: string;
    try {
      resolvedAbs = fs.realpathSync(absolutePath);
    } catch {
      return;
    }
    if (!isWithinRoot(docsRealPath, resolvedAbs)) {
      preloadIssues.push({
        severity: "error",
        code: "file.symlink.escape",
        path: displayRepoPath,
        message: `Path escapes the docs directory through a symlink: ${displayRepoPath}`
      });
      return;
    }

    if (!absolutePath.endsWith(".mdx")) {
      if (absolutePath !== path.join(llmdocDir, "meta.json")) {
        preloadIssues.push({
          severity: "error",
          code: "file.extension.invalid",
          path: displayRepoPath,
          message: "llmdoc/ allows only .mdx documents and one root-level meta.json file."
        });
      }
      return;
    }

    const raw = fs.readFileSync(absolutePath, "utf8");
    let parsed;
    try {
      parsed = matter(raw);
    } catch (error) {
      preloadIssues.push({
        severity: "error",
        code: "frontmatter.parse",
        path: displayRepoPath,
        message: `Front matter parse failed: ${(error as Error).message}`
      });
      return;
    }
    const frontmatter = parsed.data as DocumentFrontmatter;
    const segments = llmdocRelativePath.split("/");

    results.push({
      absolutePath,
      repoPath: displayRepoPath,
      llmdocPath: llmdocRelativePath,
      topic: segments.length > 1 ? segments[0] ?? null : null,
      basename: path.basename(absolutePath),
      frontmatter,
      body: parsed.content.trim(),
      raw,
      title: extractTitle(parsed.content),
      links: extractLinks(parsed.content),
      codeRefs: extractCodeRefs(parsed.content),
      estimatedTokens: estimateTokens(parsed.content),
      lineCount: raw.split(/\r?\n/).length
    });
  });

  results.sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath));
  return results;
}

function walk(currentDir: string, visitor: (absolutePath: string) => void): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, visitor);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolutePath, visitor);
      } else if (stat.isFile()) {
        visitor(absolutePath);
      }
    }
  }
}

function loadMeta(metaPath: string, metaDisplayPath: string, preloadIssues: ValidationIssue[]): MetaLedger | null {
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  let raw: MetaLedger;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, "utf8")) as MetaLedger;
  } catch (error) {
    preloadIssues.push({
      severity: "error",
      code: "meta.parse",
      path: metaDisplayPath,
      message: `meta.json parse failed: ${(error as Error).message}`
    });
    return null;
  }
  const errors = validateMeta(raw);
  if (errors.length > 0) {
    for (const error of errors) {
      preloadIssues.push({
        severity: "error",
        code: "meta.invalid",
        path: metaDisplayPath,
        message: `Invalid meta.json: ${error}`
      });
    }
    return null;
  }
  return raw;
}

export function validateWorkspace(workspace: WorkspaceData): ValidationIssue[] {
  const issues: ValidationIssue[] = [...workspace.preloadIssues];
  issues.push(...workspace.llmdocConfig.issues);
  const seenDocPaths = new Set<string>();
  const ignoreEngines = new Map<string, IgnoreEngine>();
  const getIgnoreEngine = (codeRoot: ResolvedCodeRoot): IgnoreEngine => {
    const existing = ignoreEngines.get(codeRoot.absolutePath);
    if (existing) {
      return existing;
    }
    const created = createIgnoreEngine(codeRoot.absolutePath, { llmdocDir: workspace.llmdocDir });
    ignoreEngines.set(codeRoot.absolutePath, created);
    return created;
  };

  if (!workspace.meta) {
    issues.push({
      severity: "error",
      code: "meta.missing",
      path: workspace.metaDisplayPath,
      message: `${workspace.metaDisplayPath} is missing. Run \`llmdoc init-state\` to create the ledger.`
    });
  }

  for (const document of workspace.documents) {
    seenDocPaths.add(document.llmdocPath);
    const frontmatterErrors = validateDocFrontmatter(document.frontmatter);
    for (const error of frontmatterErrors) {
      issues.push({
        severity: "error",
        code: "frontmatter.invalid",
        path: document.repoPath,
        message: `Invalid front matter: ${error}`
      });
    }

    try {
      const shape = parseDocTargetShape(document.repoPath);
      assertDocKindMatchesShape(shape);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "doc.shape.invalid",
        path: document.repoPath,
        message: (error as Error).message
      });
    }

    const depth = document.llmdocPath.split("/").length;
    if (depth > 2) {
      issues.push({
        severity: "error",
        code: "hierarchy.nested",
        path: document.repoPath,
        message: "A topic cannot contain nested subdirectories."
      });
    }

    const mdxBodyErrors = validateMdxBody(document.body);
    for (const message of mdxBodyErrors) {
      issues.push({
        severity: "error",
        code: "mdx.syntax.forbidden",
        path: document.repoPath,
        message
      });
    }

    if (/\[\[[^\]\n]+\]\]/.test(stripMarkdownLiterals(document.body))) {
      issues.push({
        severity: "warning",
        code: "link.wikilink",
        path: document.repoPath,
        message: "The body contains [[wikilink]] syntax, which llmdoc does not parse. Use a standard relative Markdown link."
      });
    }

    for (const relationPath of document.frontmatter.relations?.requires ?? []) {
      const normalizedRelation = validateLlmdocRelativePath(relationPath);
      if (!normalizedRelation.ok) {
        issues.push({
          severity: "error",
          code: "relations.requires.invalid-path",
          path: document.repoPath,
          message: normalizedRelation.message
        });
      } else if (!workspace.documentsByLlmdocPath.has(normalizedRelation.value)) {
        issues.push({
          severity: "error",
          code: "relations.requires.missing",
          path: document.repoPath,
          message: `requires points to a missing document: ${relationPath}`
        });
      }
    }

    for (const relationPath of document.frontmatter.relations?.related ?? []) {
      const normalizedRelation = validateLlmdocRelativePath(relationPath);
      if (!normalizedRelation.ok) {
        issues.push({
          severity: "error",
          code: "relations.related.invalid-path",
          path: document.repoPath,
          message: normalizedRelation.message
        });
      } else if (!workspace.documentsByLlmdocPath.has(normalizedRelation.value)) {
        issues.push({
          severity: "error",
          code: "relations.related.missing",
          path: document.repoPath,
          message: `related points to a missing document: ${relationPath}`
        });
      }
    }

    for (const linkTarget of document.links) {
      const resolved = resolveDocLink(document.llmdocPath, linkTarget);
      const normalizedLink = validateLlmdocRelativePath(resolved);
      if (!normalizedLink.ok) {
        issues.push({
          severity: "error",
          code: "link.invalid-path",
          path: document.repoPath,
          message: `Invalid body link: ${linkTarget} (${normalizedLink.message})`
        });
      } else if (!workspace.documentsByLlmdocPath.has(normalizedLink.value)) {
        issues.push({
          severity: "error",
          code: "link.missing",
          path: document.repoPath,
          message: `Body link points to a missing document: ${linkTarget}`
        });
      }
    }

    for (const codeRef of document.codeRefs) {
      const normalized = validateCodeRefPath(workspace, codeRef.path);
      if (!normalized.ok) {
        issues.push({
          severity: "error",
          code: "coderef.path.invalid",
          path: document.repoPath,
          message: normalized.message
        });
      } else if (!fs.existsSync(normalized.absolutePath)) {
        issues.push({
          severity: "error",
          code: "coderef.path.missing",
          path: document.repoPath,
          message: `CodeRef path does not exist: ${codeRef.path}`
        });
      }
    }

    for (const codePath of document.frontmatter.code?.paths ?? []) {
      const normalized = validateCodePathPattern(workspace, codePath);
      if (!normalized.ok) {
        issues.push({
          severity: "error",
          code: "code.paths.invalid",
          path: document.repoPath,
          message: normalized.message
        });
      } else if (!normalized.isGlob && !fs.existsSync(normalized.absolutePath)) {
        issues.push({
          severity: "error",
          code: "code.paths.missing",
          path: document.repoPath,
          message: `code.paths points to a missing path: ${codePath}`
        });
      } else if (
        normalized.isGlob &&
        !globMatchesExistingFile(normalized.codeRoot, normalized.absolutePath, normalized.normalized, getIgnoreEngine(normalized.codeRoot))
      ) {
        issues.push({
          severity: "error",
          code: "code.paths.unmatched",
          path: document.repoPath,
          message: `code.paths glob matches no existing files: ${codePath}`
        });
      }
    }

    if (document.lineCount > DOC_LINE_WARNING_LIMIT) {
      issues.push({
        severity: "warning",
        code: "size.line-warning",
        path: document.repoPath,
        message: `The document has ${document.lineCount} lines, exceeding the recommended limit of ${DOC_LINE_WARNING_LIMIT}.`
      });
    }
  }

  for (const [topic, docs] of workspace.topics) {
    if (docs.length === 0) {
      issues.push({
        severity: "warning",
        code: "topic.empty",
        path: `llmdoc/${topic}`,
        message: "The topic directory is empty."
      });
    }
  }

  if (workspace.meta) {
    const metaPaths = Object.keys(workspace.meta.documents).sort();
    const docPaths = [...seenDocPaths].sort();

    for (const docPath of docPaths) {
      if (!(docPath in workspace.meta.documents)) {
        issues.push({
          severity: "error",
          code: "meta.entry.missing",
          path: `llmdoc/${docPath}`,
          message: "meta.json is missing the corresponding documents entry. Use `llmdoc adopt <path>` to register it without rewriting the document."
        });
      }
    }

    for (const metaDocPath of metaPaths) {
      if (!seenDocPaths.has(metaDocPath)) {
        issues.push({
          severity: "error",
          code: "meta.entry.orphaned",
          path: `llmdoc/${metaDocPath}`,
          message: "meta.json contains an orphan documents entry."
        });
      }
    }

    // Legacy v3 ledger compatibility: only check Git revisions for v3 ledgers.
    // v4 ledgers use content digests as first-class state; hintRevision is optional and NEVER errors.
    if (workspace.meta.schema === "llmdoc.meta/v3") {
      const hasGit = isGitRepository(workspace.rootDir);
      const shallow = hasGit ? isShallowRepository(workspace.rootDir) : false;
      const revisionSeverity = !hasGit || shallow ? ("warning" as const) : ("error" as const);
      const hint = !hasGit
        ? " (non-Git workspace; run `llmdoc finalize --all` to upgrade meta.json to llmdoc.meta/v4)"
        : shallow
          ? " (shallow clone; use fetch-depth: 0 or git fetch --unshallow for complete validation)"
          : "";
      if (!hasGit || !gitCommitExists(workspace.rootDir, workspace.meta.baseline.revision)) {
        issues.push({
          severity: revisionSeverity,
          code: "meta.baseline.revision.missing",
          path: workspace.metaDisplayPath,
          message: `baseline.revision does not exist in current Git history: ${workspace.meta.baseline.revision}${hint}`
        });
      }
      for (const metaDocPath of metaPaths) {
        const revision = workspace.meta.documents[metaDocPath]?.validatedRevision;
        if (revision && (!hasGit || !gitCommitExists(workspace.rootDir, revision))) {
          issues.push({
            severity: revisionSeverity,
            code: "meta.document.revision.missing",
            path: `llmdoc/${metaDocPath}`,
            message: `validatedRevision does not exist in current Git history: ${revision}${hint}`
          });
        }
      }
    }
  }

  return issues;
}

function isGlob(input: string): boolean {
  return /[*?[\]{}]/.test(input);
}

function validateMdxBody(body: string): string[] {
  const cleanBody = stripMarkdownLiterals(body);
  const issues: string[] = [];
  if (/^\s*import\s+/m.test(cleanBody) || /^\s*export\s+/m.test(cleanBody)) {
    issues.push("Only plain Markdown and self-closing CodeRef tags are allowed; import/export is forbidden.");
  }
  if (/<(?!CodeRef\b)[A-Za-z][^>]*>/m.test(cleanBody) || /<\/[A-Za-z][^>]*>/m.test(cleanBody)) {
    issues.push("Only self-closing <CodeRef ... /> components are allowed; arbitrary JSX tags are forbidden.");
  }
  if (/\{[^}\n]+\}/m.test(cleanBody)) {
    issues.push("MDX/JS expressions are forbidden in document bodies.");
  }
  issues.push(...validateCodeRefTags(body));
  return [...new Set(issues)];
}

function validateLlmdocRelativePath(input: string): { ok: true; value: string } | { ok: false; message: string } {
  try {
    const normalized = normalizeRepoRelativePath(input);
    if (!normalized.endsWith(".mdx")) {
      return { ok: false, message: `Path must point to an .mdx document: ${input}` };
    }
    if (normalized.startsWith("llmdoc/")) {
      return { ok: false, message: `Path must be relative to llmdoc/, not the repository root: ${input}` };
    }
    return { ok: true, value: normalized };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function validateCodeRefPath(
  workspace: WorkspaceData,
  input: string
): { ok: true; absolutePath: string; normalized: string } | { ok: false; message: string } {
  try {
    const resolved = resolveCodePathInWorkspace(workspace, input);
    return { ok: true, absolutePath: resolved.absolutePath, normalized: resolved.normalized };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function validateCodePathPattern(
  workspace: WorkspaceData,
  input: string
): { ok: true; absolutePath: string; normalized: string; isGlob: boolean; codeRoot: ResolvedCodeRoot } | { ok: false; message: string } {
  try {
    const normalized = normalizeRepoRelativePath(input);
    const glob = isGlob(normalized);
    if (!glob) {
      const resolved = resolveCodePathInWorkspace(workspace, normalized);
      return {
        ok: true,
        absolutePath: resolved.absolutePath,
        normalized: resolved.normalized,
        isGlob: false,
        codeRoot: resolved.codeRoot
      };
    }

    const staticPrefixSegments: string[] = [];
    for (const segment of normalized.split("/")) {
      if (isGlob(segment)) {
        break;
      }
      staticPrefixSegments.push(segment);
    }
    const staticPrefix = staticPrefixSegments.join("/");
    if (!staticPrefix) {
      const defaultRoot = workspace.codeRoots.find((root) => root.name === null) ?? {
        name: null,
        configuredPath: ".",
        absolutePath: workspace.rootDir
      };
      return {
        ok: true,
        absolutePath: defaultRoot.absolutePath,
        normalized,
        isGlob: true,
        codeRoot: defaultRoot
      };
    }
    const resolved = resolveCodePathInWorkspace(workspace, staticPrefix);
    return {
      ok: true,
      absolutePath: resolved.absolutePath,
      normalized,
      isGlob: true,
      codeRoot: resolved.codeRoot
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function globMatchesExistingFile(
  codeRoot: ResolvedCodeRoot,
  staticPrefixPath: string,
  pattern: string,
  ignoreEngine: IgnoreEngine
): boolean {
  const prefix = codeRoot.name ? `${codeRoot.name}/` : "";
  const pending = [staticPrefixPath];

  while (pending.length > 0) {
    const currentPath = pending.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(currentPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    const localRel = repoPath(codeRoot.absolutePath, currentPath);
    if (stat.isFile()) {
      if (localRel && ignoreEngine.isIgnored(localRel, false)) {
        continue;
      }
      const fullRel = `${prefix}${localRel}`;
      if (matchesCodePathPattern(pattern, fullRel)) {
        return true;
      }
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const childPath = path.join(currentPath, entry.name);
      const childLocalRel = localRel ? `${localRel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && ignoreEngine.shouldPruneDirectory(childLocalRel)) {
        continue;
      }
      pending.push(childPath);
    }
  }

  return false;
}

function isPathInsideDir(parentDir: string, candidatePath: string): boolean {
  const parentReal = safeRealpath(parentDir);
  const candidateReal = safeRealpath(candidatePath);
  return isWithinRoot(parentReal, candidateReal);
}

function safeRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}
