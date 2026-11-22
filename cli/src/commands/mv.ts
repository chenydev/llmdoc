import fs from "node:fs";
import path from "node:path";

import { isDirectTopicDirectory, parseDocTargetShape, validateMoveTargetShape } from "../lib/doc-shape.js";
import { CliError } from "../lib/errors.js";
import { findProjectRoot, normalizeRepoRelativePath } from "../lib/fs.js";
import { MoveMapping, updateDocumentForMove, writeFileIfChanged } from "../lib/rewrite.js";
import { LocalTransaction } from "../lib/txn.js";
import { loadWorkspace, resolveDocPathInWorkspace } from "../lib/workspace.js";
import { LLMDOC_CONFIG_FILENAME, rewriteStartupPreloadForMove } from "../lib/config.js";
import { writeMeta } from "../lib/state.js";
import { MetaLedger, ParsedDocument, WorkspaceResolutionOptions } from "../types.js";

interface MoveOptions extends WorkspaceResolutionOptions {
  cwd: string;
  from: string;
  to: string;
  json?: boolean;
}

export function runMove(options: MoveOptions): unknown {
  const rootDir = findProjectRoot(options.cwd, options);
  const beforeWorkspace = loadWorkspace(rootDir, options);

  const fromRepoPath = normalizeRepoRelativePath(options.from.startsWith("llmdoc/") ? options.from : `llmdoc/${options.from}`);
  const toRepoPath = normalizeRepoRelativePath(options.to.startsWith("llmdoc/") ? options.to : `llmdoc/${options.to}`);
  const fromAbsolutePath = resolveDocPathInWorkspace(beforeWorkspace.llmdocDir, fromRepoPath);

  if (!fromRepoPath.startsWith("llmdoc/") || !toRepoPath.startsWith("llmdoc/")) {
    throw new CliError("mv supports moves only within llmdoc/.");
  }
  if (fromRepoPath === "llmdoc/meta.json" || toRepoPath === "llmdoc/meta.json") {
    throw new CliError("mv cannot move meta.json.");
  }

  const fromStats = fs.statSync(fromAbsolutePath);
  if (fromStats.isDirectory()) {
    if (!isDirectTopicDirectory(fromRepoPath) || !isDirectTopicDirectory(toRepoPath)) {
      throw new CliError("Topic renames must use llmdoc/<topic> -> llmdoc/<topic>.");
    }
  } else {
    if (!fromRepoPath.endsWith(".mdx") || !toRepoPath.endsWith(".mdx")) {
      throw new CliError("mv can move only .mdx documents.");
    }
    const fromDocument = beforeWorkspace.documents.find((document) => document.repoPath === fromRepoPath);
    if (!fromDocument) {
      throw new CliError("mv can move only indexed llmdoc documents.");
    }
    const targetShape = parseDocTargetShape(toRepoPath);
    validateMoveTargetShape(targetShape);
  }

  const toAbsolutePath = resolveDocPathInWorkspace(beforeWorkspace.llmdocDir, toRepoPath, { allowMissing: true });
  if (fs.existsSync(toAbsolutePath)) {
    throw new CliError(`Target already exists: ${toRepoPath}`);
  }

  const mapping = buildMoveMapping(beforeWorkspace.documents, beforeWorkspace.llmdocDir, fromAbsolutePath, toAbsolutePath);
  const configRewrite = beforeWorkspace.llmdocConfig.config
    ? rewriteStartupPreloadForMove(beforeWorkspace.llmdocConfig.config, mapping)
    : { config: null, changed: false };
  const configPath = path.join(rootDir, LLMDOC_CONFIG_FILENAME);

  const movedAfterPaths = new Map<string, string>();
  for (const item of mapping) {
    movedAfterPaths.set(item.oldLlmdocPath, path.join(beforeWorkspace.llmdocDir, item.newLlmdocPath));
  }

  const touchedDocs = beforeWorkspace.documents.filter((document) => documentTouchesMove(document, mapping));
  const rewrittenDisplayPaths = new Set<string>();
  for (const document of touchedDocs) {
    const movedTarget = mapping.find((item) => item.oldLlmdocPath === document.llmdocPath);
    rewrittenDisplayPaths.add(`llmdoc/${movedTarget ? movedTarget.newLlmdocPath : document.llmdocPath}`);
  }
  for (const item of mapping) {
    rewrittenDisplayPaths.add(`llmdoc/${item.newLlmdocPath}`);
  }

  // Git-free local filesystem transaction with `.llmdoc-tmp/txn/<id>/` backup & rollback.
  const txn = new LocalTransaction(rootDir);
  try {
    // 1. Back up all files that will be modified before touching the workspace.
    for (const document of touchedDocs) {
      txn.backupFile(document.absolutePath);
    }
    if (beforeWorkspace.meta) {
      txn.backupFile(beforeWorkspace.metaPath);
    }
    if (configRewrite.changed) {
      txn.backupFile(configPath);
    }

    // 2. Move the file or topic directory directly via fs.renameSync (auto-creating target parent dir).
    txn.movePath(fromAbsolutePath, toAbsolutePath);

    // 3. Rewrite internal document links and relations.
    for (const document of touchedDocs) {
      const nextAbsolute = movedAfterPaths.get(document.llmdocPath) ?? document.absolutePath;
      const nextContent = updateDocumentForMove(document, mapping);
      writeFileIfChanged(nextAbsolute, nextContent);
    }

    // 4. Rewrite ledger keys and optional startup preload config.
    if (beforeWorkspace.meta) {
      const nextMeta = rewriteMeta(beforeWorkspace.meta, mapping);
      writeMeta(beforeWorkspace.metaPath, nextMeta);
    }
    if (configRewrite.changed && configRewrite.config) {
      fs.writeFileSync(configPath, `${JSON.stringify(configRewrite.config, null, 2)}\n`);
    }

    txn.commit();
  } catch (error) {
    const rolledBack = txn.rollback();
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      rolledBack
        ? `Reference rewriting failed during mv; llmdoc/ was rolled back to its previous state: ${reason}`
        : `Reference rewriting failed during mv and automatic rollback did not complete. Inspect ${txn.txnDir} and recover manually: ${reason}`
    );
  }

  if (options.json) {
    return {
      moved: {
        from: fromRepoPath,
        to: toRepoPath
      },
      rewrittenConfig: configRewrite.changed,
      rewrittenDocuments: [...rewrittenDisplayPaths].sort()
    };
  }
  return `moved: ${fromRepoPath} -> ${toRepoPath}${configRewrite.changed ? "; updated llmdoc.config.json startup preload" : ""}`;
}

function buildMoveMapping(
  documents: ParsedDocument[],
  llmdocDir: string,
  fromAbsolutePath: string,
  toAbsolutePath: string
): MoveMapping[] {
  const mapping: MoveMapping[] = [];
  const llmdocDirBases = [...new Set([llmdocDir, fs.realpathSync(llmdocDir)])];
  const toLlmdocPath = (absolutePath: string): string => {
    for (const base of llmdocDirBases) {
      const relative = path.relative(base, absolutePath);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.replaceAll(path.sep, "/");
      }
    }
    throw new CliError(`Unable to derive an llmdoc-relative path from: ${absolutePath}`);
  };
  const fromPathIsDirectory = fs.statSync(fromAbsolutePath).isDirectory();

  if (fromPathIsDirectory) {
    const fromBase = fromAbsolutePath;
    for (const document of documents) {
      if (document.absolutePath === fromBase || document.absolutePath.startsWith(`${fromBase}${path.sep}`)) {
        const suffix = path.relative(fromBase, document.absolutePath);
        const nextAbsolute = path.join(toAbsolutePath, suffix);
        mapping.push({
          oldLlmdocPath: toLlmdocPath(document.absolutePath),
          newLlmdocPath: toLlmdocPath(nextAbsolute)
        });
      }
    }
  } else {
    mapping.push({
      oldLlmdocPath: toLlmdocPath(fromAbsolutePath),
      newLlmdocPath: toLlmdocPath(toAbsolutePath)
    });
  }

  return mapping.sort((left, right) => right.oldLlmdocPath.length - left.oldLlmdocPath.length);
}

function documentTouchesMove(document: ParsedDocument, mapping: MoveMapping[]): boolean {
  if (mapping.some((item) => document.llmdocPath === item.oldLlmdocPath)) {
    return true;
  }

  const relationTargets = [
    ...(document.frontmatter.relations?.requires ?? []),
    ...(document.frontmatter.relations?.related ?? [])
  ];
  if (relationTargets.some((target) => mapping.some((item) => target === item.oldLlmdocPath || target.startsWith(`${item.oldLlmdocPath}/`)))) {
    return true;
  }

  return document.links.some((target) => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(document.llmdocPath), target));
    return mapping.some((item) => resolved === item.oldLlmdocPath || resolved.startsWith(`${item.oldLlmdocPath}/`));
  });
}

function rewriteMeta(meta: MetaLedger, mapping: MoveMapping[]): MetaLedger {
  if (meta.schema === "llmdoc.meta/v4") {
    const nextDocuments: typeof meta.documents = {};
    for (const [docPath, value] of Object.entries(meta.documents)) {
      nextDocuments[rewritePath(docPath, mapping)] = value;
    }
    return {
      ...meta,
      documents: nextDocuments
    };
  }
  const nextDocuments: typeof meta.documents = {};
  for (const [docPath, value] of Object.entries(meta.documents)) {
    nextDocuments[rewritePath(docPath, mapping)] = value;
  }
  return {
    ...meta,
    documents: nextDocuments
  };
}

function rewritePath(input: string, mapping: MoveMapping[]): string {
  for (const item of mapping) {
    if (input === item.oldLlmdocPath) {
      return item.newLlmdocPath;
    }
    if (input.startsWith(`${item.oldLlmdocPath}/`)) {
      return `${item.newLlmdocPath}${input.slice(item.oldLlmdocPath.length)}`;
    }
  }
  return input;
}
