export type DocumentKind = "architecture" | "guide" | "reference";

export interface DocumentFrontmatter {
  description: string;
  kind: DocumentKind;
  relations?: {
    requires?: string[];
    related?: string[];
  };
  code?: {
    paths?: string[];
  };
}

export interface CodeRef {
  path: string;
  symbol?: string;
}

export interface ParsedDocument {
  absolutePath: string;
  repoPath: string;
  llmdocPath: string;
  topic: string | null;
  basename: string;
  frontmatter: DocumentFrontmatter;
  body: string;
  raw: string;
  title: string | null;
  links: string[];
  codeRefs: CodeRef[];
  estimatedTokens: number;
  lineCount: number;
}

export interface MetaLedgerV3 {
  schema: "llmdoc.meta/v3";
  baseline: {
    revision: string;
    verifiedAt: string;
  };
  documents: Record<string, { validatedRevision: string | null }>;
  convergence: {
    capturedAt: string;
    source: "init" | "prune";
    documentCount: number;
    totalEstimatedTokens: number;
  };
}

export interface MetaLedgerV4 {
  schema: "llmdoc.meta/v4";
  baseline: {
    surfaceDigest: string | null;
    hintRevision?: string | null;
    verifiedAt: string;
  };
  documents: Record<
    string,
    {
      codeDigest: string | null;
      hintRevision?: string | null;
    }
  >;
  convergence: {
    capturedAt: string;
    source: "init" | "prune";
    documentCount: number;
    totalEstimatedTokens: number;
  };
}

export type MetaLedger = MetaLedgerV4 | MetaLedgerV3;

export type CodeRootConfigEntry =
  | string
  | {
      name: string;
      path: string;
    };

export interface ResolvedCodeRoot {
  /** Named prefix in code.paths (null when using the default workspace root). */
  name: string | null;
  /** Raw configured path (relative to rootDir or absolute). */
  configuredPath: string;
  /** Resolved canonical directory path on disk. */
  absolutePath: string;
}

export interface LlmdocConfig {
  $schema?: string;
  schema: "llmdoc.config/v1";
  docsDir?: string;
  codeRoots?: CodeRootConfigEntry[];
  state?: {
    location?: "tracked" | "local";
    localPath?: string;
  };
  startup?: {
    remindSkill?: boolean;
    preload?: string[];
  };
}

export interface LoadedLlmdocConfig {
  exists: boolean;
  config: LlmdocConfig | null;
  preloadPaths: string[];
  issues: ValidationIssue[];
}

export interface WorkspaceResolutionOptions {
  root?: string;
  docsDir?: string;
}

export interface WorkspaceData {
  rootDir: string;
  llmdocDir: string;
  docsDirExternal: boolean;
  codeRoots: ResolvedCodeRoot[];
  metaPath: string;
  metaLocation: "tracked" | "local";
  metaDisplayPath: string;
  documents: ParsedDocument[];
  documentsByLlmdocPath: Map<string, ParsedDocument>;
  topics: Map<string, ParsedDocument[]>;
  rootSingletons: ParsedDocument[];
  meta: MetaLedger | null;
  llmdocConfig: LoadedLlmdocConfig;
  preloadIssues: ValidationIssue[];
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface PaginationResult<T> {
  items: T[];
  totalItems: number;
  returnedItems: number;
  totalEstimatedTokens: number;
  returnedEstimatedTokens: number;
  nextCursor: string | null;
}

export interface OutputOptions {
  json?: boolean;
  cursor?: string;
  budget?: number;
  limit?: number;
}

export interface GitState {
  available: boolean;
  headRevision: string | null;
  detached: boolean;
  inProgressOperation: "merge" | "rebase" | "cherry-pick" | null;
  baselineBehindHead: number | null;
  committedChangedPaths: string[];
  stagedPaths: string[];
  unstagedPaths: string[];
  untrackedPaths: string[];
  degradedReason: string | null;
}

export interface DocumentImpact {
  document: ParsedDocument;
  changedPaths: string[];
  changedCommittedPaths: string[];
  dirtyPaths: string[];
  needsReviewBecauseOf: string[];
}
