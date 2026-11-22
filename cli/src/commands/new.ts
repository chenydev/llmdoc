import fs from "node:fs";
import path from "node:path";

import { parseDocTargetShape, assertDocKindMatchesShape, assertDocumentKind } from "../lib/doc-shape.js";
import { CliError } from "../lib/errors.js";
import { ensureDirectory, findProjectRootForNew, normalizeRepoRelativePath } from "../lib/fs.js";
import { packageRootFromImport } from "../lib/package-root.js";
import { writeMeta } from "../lib/state.js";
import { loadWorkspace, resolveDocPathInWorkspace, resolveWorkspaceLayout } from "../lib/workspace.js";
import { DocumentKind, WorkspaceResolutionOptions } from "../types.js";

interface NewOptions extends WorkspaceResolutionOptions {
  cwd: string;
  path: string;
  kind: DocumentKind;
  description?: string;
  json?: boolean;
}

export function runNew(options: NewOptions): unknown {
  const rootDir = findProjectRootForNew(options.cwd, options);
  const layout = resolveWorkspaceLayout(rootDir, { docsDir: options.docsDir, allowMissingDocsDir: true });
  const repoRelativePath = normalizeDocDestination(options.path);
  const kind = assertDocumentKind(options.kind);
  const shape = parseDocTargetShape(repoRelativePath);
  assertDocKindMatchesShape(shape);

  fs.mkdirSync(layout.llmdocDir, { recursive: true });
  const absolutePath = resolveDocPathInWorkspace(layout.llmdocDir, shape.llmdocPath, { allowMissing: true });
  if (fs.existsSync(absolutePath)) {
    throw new CliError(`Target already exists: ${repoRelativePath}`);
  }

  ensureDirectory(absolutePath);
  const template = readTemplate();
  const title = path.basename(repoRelativePath, ".mdx").replaceAll("-", " ");
  // description 经 JSON.stringify 得到合法的 YAML double-quoted scalar,防止引号/冒号/换行破坏 front matter;
  // replace 一律用函数形式,避免 $& 等替换模式展开。
  const content = template
    .replace("__DESCRIPTION__", () => JSON.stringify(options.description ?? "TODO: Add a document description."))
    .replace("__KIND__", () => kind)
    .replace("__TITLE__", () => title);

  const metaExists = fs.existsSync(layout.metaPath);
  fs.writeFileSync(absolutePath, content);
  syncMetaEntry(rootDir, shape.llmdocPath, options.docsDir);

  if (options.json) {
    return {
      created: repoRelativePath,
      next: metaExists ? null : "Run `llmdoc init-state` to create the ledger."
    };
  }
  return metaExists
    ? `created: ${repoRelativePath}`
    : `created: ${repoRelativePath}\nnext: Run \`llmdoc init-state\` to create the ledger.`;
}

function normalizeDocDestination(input: string): string {
  const repoRelativePath = normalizeRepoRelativePath(input.startsWith("llmdoc/") ? input : `llmdoc/${input}`);
  if (!repoRelativePath.startsWith("llmdoc/") || !repoRelativePath.endsWith(".mdx")) {
    throw new CliError("new can create only .mdx documents under llmdoc/.");
  }
  return repoRelativePath;
}

function readTemplate(): string {
  const packageRoot = packageRootFromImport(import.meta.url);
  return fs.readFileSync(path.join(packageRoot, "templates", "doc.mdx"), "utf8");
}

function syncMetaEntry(rootDir: string, llmdocPath: string, docsDir?: string): void {
  const workspace = loadWorkspace(rootDir, { docsDir });
  if (!workspace.meta) {
    return;
  }
  if (!workspace.meta.documents[llmdocPath]) {
    if (workspace.meta.schema === "llmdoc.meta/v4") {
      workspace.meta.documents[llmdocPath] = {
        codeDigest: null,
        hintRevision: null
      };
    } else {
      workspace.meta.documents[llmdocPath] = {
        validatedRevision: null
      };
    }
    writeMeta(workspace.metaPath, workspace.meta);
  }
}
