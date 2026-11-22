import fs from "node:fs";

import { assertDocKindMatchesShape, parseDocTargetShape } from "../lib/doc-shape.js";
import { CliError } from "../lib/errors.js";
import { findProjectRoot, normalizeRepoRelativePath } from "../lib/fs.js";
import { writeMeta } from "../lib/state.js";
import { loadWorkspace, resolveDocPathInWorkspace, validateWorkspace } from "../lib/workspace.js";
import type { WorkspaceResolutionOptions } from "../types.js";

interface AdoptOptions extends WorkspaceResolutionOptions {
  cwd: string;
  paths: string[];
  json?: boolean;
}

// 无损登记已存在的合法 .mdx 到 meta.json:只新增未验证条目,
// 不重写正文;已登记路径幂等 no-op。有效摘要由后续 finalize/fingerprint 验证后写入。
export function runAdopt(options: AdoptOptions): unknown {
  const rootDir = findProjectRoot(options.cwd, options);
  const workspace = loadWorkspace(rootDir, options);
  if (!workspace.meta) {
    throw new CliError(`${workspace.metaDisplayPath} is missing; run \`llmdoc init-state\` first.`);
  }

  const llmdocPaths = options.paths.map((input) => {
    const repoRelativePath = normalizeRepoRelativePath(input.startsWith("llmdoc/") ? input : `llmdoc/${input}`);
    if (!repoRelativePath.startsWith("llmdoc/") || !repoRelativePath.endsWith(".mdx")) {
      throw new CliError(`adopt can register only .mdx documents under llmdoc/: ${input}`);
    }
    const shape = parseDocTargetShape(repoRelativePath);
    assertDocKindMatchesShape(shape);
    const absolutePath = resolveDocPathInWorkspace(workspace.llmdocDir, shape.llmdocPath, { allowMissing: true });
    if (!fs.existsSync(absolutePath)) {
      throw new CliError(`Target does not exist; adopt registers existing documents only (use llmdoc new to create one): ${repoRelativePath}`);
    }
    if (!workspace.documentsByLlmdocPath.has(shape.llmdocPath)) {
      throw new CliError(`The workspace did not recognize the document (its front matter may be invalid): ${repoRelativePath}`);
    }
    return shape.llmdocPath;
  });

  // 目标文档自身必须通过结构校验;meta.entry.missing 正是 adopt 要修复的问题,予以豁免。
  const targetRepoPaths = new Set(llmdocPaths.map((llmdocPath) => `llmdoc/${llmdocPath}`));
  const blockingIssues = validateWorkspace(workspace).filter(
    (issue) => issue.severity === "error" && issue.path !== undefined && targetRepoPaths.has(issue.path) && issue.code !== "meta.entry.missing"
  );
  if (blockingIssues.length > 0) {
    throw new CliError(
      `Target documents failed validation; refusing to register them:\n${blockingIssues.map((issue) => `  ${issue.code} (${issue.path}) ${issue.message}`).join("\n")}`
    );
  }

  const adopted: string[] = [];
  const alreadyRegistered: string[] = [];
  for (const llmdocPath of llmdocPaths) {
    if (workspace.meta.documents[llmdocPath]) {
      alreadyRegistered.push(llmdocPath);
    } else {
      if (workspace.meta.schema === "llmdoc.meta/v4") {
        workspace.meta.documents[llmdocPath] = { codeDigest: null, hintRevision: null };
      } else {
        workspace.meta.documents[llmdocPath] = { validatedRevision: null };
      }
      adopted.push(llmdocPath);
    }
  }
  if (adopted.length > 0) {
    writeMeta(workspace.metaPath, workspace.meta);
  }

  if (options.json) {
    return {
      adopted: adopted.slice().sort(),
      alreadyRegistered: alreadyRegistered.slice().sort()
    };
  }
  const lines = [`adopted: ${adopted.length} document(s)${adopted.length > 0 ? ` — ${adopted.join(", ")}` : ""}`];
  if (alreadyRegistered.length > 0) {
    lines.push(`already registered (no-op): ${alreadyRegistered.join(", ")}`);
  }
  if (adopted.length > 0) {
    lines.push("codeDigest was registered as null; after validation, use finalize/fingerprint/commit to record a valid digest.");
  }
  return lines.join("\n");
}
