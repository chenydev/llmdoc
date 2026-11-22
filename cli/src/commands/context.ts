import { loadWorkspace, resolveCodePathInWorkspace } from "../lib/workspace.js";
import { matchesCodePathPattern } from "../lib/search.js";
import { CliError } from "../lib/errors.js";
import { OutputOptions, ParsedDocument, WorkspaceResolutionOptions } from "../types.js";
import { formatPaginationSummary } from "../lib/format.js";
import { paginate, paginationMetadata } from "../lib/pagination.js";
import { estimateTokens } from "../lib/markdown.js";

interface ContextOptions extends OutputOptions, WorkspaceResolutionOptions {
  cwd: string;
  files: string[];
}

export function runContext(options: ContextOptions): unknown {
  if (options.files.length === 0) {
    throw new CliError("context requires at least one --files input.");
  }

  const workspace = loadWorkspace(options.cwd, options);
  const normalizedFiles = options.files.map((file) => {
    // 允许尚不存在的路径:"我要新建/删除这个文件,该先读哪些文档"是合法问法;
    // resolveCodePathInWorkspace 仍负责拦截越界与 symlink 逃逸并支持多仓 codeRoots。
    const resolved = resolveCodePathInWorkspace(workspace, file, { allowMissing: true });
    return {
      normalized: resolved.normalized,
      absolutePath: resolved.absolutePath
    };
  });
  const documentsByFile = normalizedFiles.map((file) => ({
    file,
    documents: workspace.documents.filter((document) =>
      (document.frontmatter.code?.paths ?? []).some((pattern) => matchesCodePathPattern(pattern, file.normalized))
    )
  }));
  const impactedPaths = new Set(
    documentsByFile.flatMap(({ documents }) => documents.map((document) => document.llmdocPath))
  );
  const impacted = workspace.documents.filter((document) => impactedPaths.has(document.llmdocPath));
  const unmappedFiles = documentsByFile
    .filter(({ documents }) => documents.length === 0)
    .map(({ file }) => file.normalized);

  const prerequisites = collectRequires(workspace, impacted);
  const rows = [
    ...impacted.map((document) => ({ role: "impacted" as const, document })),
    ...prerequisites.map((document) => ({ role: "requires" as const, document }))
  ];
  const result = paginate({
    items: rows,
    estimate: (row) => estimateTokens(JSON.stringify({ role: row.role, ...toPayload(row.document) })),
    options
  });

  if (options.json) {
    return {
      impacted: result.items.filter((row) => row.role === "impacted").map((row) => toPayload(row.document)),
      prerequisites: result.items.filter((row) => row.role === "requires").map((row) => toPayload(row.document)),
      unmappedFiles,
      pagination: paginationMetadata(result)
    };
  }

  const lines: string[] = [`${impacted.length} documents impacted, ${prerequisites.length} recommended prerequisites:`, ""];
  for (const row of result.items) {
    const prefix = row.role === "requires" ? "  requires ->" : "  ";
    const document = row.document;
    lines.push(`${prefix} llmdoc/${document.llmdocPath}  [${document.frontmatter.kind}]`);
    lines.push(`    ${document.frontmatter.description}`);
  }
  lines.push("", `unmapped files: ${unmappedFiles.length}`);
  for (const file of unmappedFiles) {
    lines.push(`  unmapped -> ${file}`);
  }
  lines.push("", ...formatPaginationSummary(result));
  return lines.join("\n");
}

function collectRequires(workspace: ReturnType<typeof loadWorkspace>, impacted: ParsedDocument[]): ParsedDocument[] {
  const seen = new Set(impacted.map((document) => document.llmdocPath));
  const queue = [...impacted];
  const results: ParsedDocument[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const requirement of current.frontmatter.relations?.requires ?? []) {
      if (seen.has(requirement)) {
        continue;
      }
      const next = workspace.documentsByLlmdocPath.get(requirement);
      if (!next) {
        continue;
      }
      seen.add(requirement);
      results.push(next);
      queue.push(next);
    }
  }

  return results.sort((left, right) => left.llmdocPath.localeCompare(right.llmdocPath));
}

function toPayload(document: ParsedDocument): object {
  return {
    path: `llmdoc/${document.llmdocPath}`,
    kind: document.frontmatter.kind,
    description: document.frontmatter.description
  };
}
