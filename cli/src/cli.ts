import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { findProjectRoot, findProjectRootOrNull } from "./lib/fs.js";
import { CliError } from "./lib/errors.js";
import { runTree } from "./commands/tree.js";
import { runIndex } from "./commands/index.js";
import { runShow } from "./commands/show.js";
import { runSearch } from "./commands/search.js";
import { runContext } from "./commands/context.js";
import { runValidate } from "./commands/validate.js";
import { runNew } from "./commands/new.js";
import { runMove } from "./commands/mv.js";
import { runStatus } from "./commands/status.js";
import { runDelta } from "./commands/delta.js";
import { runFingerprint } from "./commands/fingerprint.js";
import { runFinalize } from "./commands/finalize.js";
import { runHook } from "./commands/hook.js";
import { runPrune } from "./commands/prune.js";
import { parseAndValidateJsonString, stringifyValidatedOutput, type OutputSchemaName } from "./lib/output-schema.js";
import { packageRootFromImport } from "./lib/package-root.js";
import type { WorkspaceResolutionOptions } from "./types.js";

export interface RunCliResult {
  exitCode: number;
  stdout: string;
}

interface GlobalCliOptions extends WorkspaceResolutionOptions {
  json?: boolean;
  cursor?: string;
  budget?: number;
  limit?: number;
}

export async function runCli(argv: string[], cwd = process.cwd(), stdin = ""): Promise<RunCliResult> {
  if (argv.includes("--version") || argv.includes("-V")) {
    return {
      exitCode: 0,
      stdout: readPackageVersion()
    };
  }
  const program = new Command();
  const output: string[] = [];
  let exitCode = 0;
  let globalOptions: GlobalCliOptions;
  try {
    globalOptions = parseGlobalOptions(argv);
  } catch (error) {
    if (error instanceof CliError) {
      return {
        exitCode: error.exitCode,
        stdout: error.message
      };
    }
    throw error;
  }

  const resolutionOpts: WorkspaceResolutionOptions = {
    root: globalOptions.root,
    docsDir: globalOptions.docsDir
  };

  program
    .name("llmdoc")
    .description("Project knowledge CLI for LLMs: progressively retrieve llmdoc/ documents and maintain content-addressed validity ledgers")
    .version(readPackageVersion(), "--version", "output the CLI version")
    .helpOption("-h, --help", "display help")
    .helpCommand("help [command]", "display help for a command")
    .showHelpAfterError("(use --help to view usage)");
  program
    .option("--json", "emit schema-validated JSON")
    .option("--cursor <cursor>", "continue from a cursor returned by a truncated response")
    .option("--budget <tokens>", "truncate output at this token budget and return a cursor", parseInteger)
    .option("--limit <n>", "maximum number of items to return", parseInteger)
    .option("--root <dir>", "override project workspace root (or set LLMDOC_ROOT)")
    .option("--docs-dir <dir>", "override llmdoc knowledge directory (or set LLMDOC_DOCS_DIR)");
  program.addHelpText(
    "after",
    [
      "",
      "Quick reference by purpose:",
      "  Retrieval (read-only)  tree → index / search / context → show",
      "  State diagnostics      status · delta · validate",
      "  Structural mutation    new · adopt · mv · fingerprint · init-state · finalize · commit",
      "  Maintenance            prune · upgrade",
      "  Integration            hook · serve",
      "",
      "Common examples:",
      "  llmdoc tree --docs                        expand the global map to documents",
      "  llmdoc search \"retry policy\" --limit 5     search documents lexically",
      "  llmdoc context --files src/api/retry.ts   map source files to documents to read",
      "  llmdoc show api-client/retry-policy.mdx   read selected bodies",
      "  llmdoc finalize --all                     validate and refresh content digests (no Git required)",
      "  llmdoc commit -m \"docs: ...\"              finalize and create a single Git commit",
      "",
      "All retrieval commands support --json / --budget / --limit; use --cursor to continue truncated output."
    ].join("\n")
  );

  program
    .command("tree")
    .description("output the global llmdoc map (topics by default)")
    .option("--docs", "expand to document level")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      const result = runTree({ ...globalOptions, ...commandOptions, cwd: rootDir });
      output.push(writeOutput(commandOptions.docs ? "treeDocs" : "treeTopics", result, globalOptions.json));
    });

  program
    .command("index")
    .description("list document metadata without reading bodies")
    .option("--topic <topic>", "list documents only under this topic")
    .option("--kind <kind>", "filter by kind: architecture | guide | reference")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("index", runIndex({ ...globalOptions, ...commandOptions, cwd: rootDir }), globalOptions.json));
    });

  program
    .command("show")
    .description("read one or more document bodies")
    .argument("<path...>", "paths relative to llmdoc/, such as api-client/retry-policy.mdx")
    .action((paths) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("show", runShow({ ...globalOptions, cwd: rootDir, paths }), globalOptions.json));
    });

  program
    .command("search")
    .description("search llmdoc documents lexically (Chinese segmentation with CJK bigram fallback)")
    .argument("<query>", "search query")
    .option("--topic <topic>", "limit to a topic")
    .option("--kind <kind>", "filter by kind: architecture | guide | reference")
    .action((query, commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("search", runSearch({ ...globalOptions, ...commandOptions, cwd: rootDir, query }), globalOptions.json));
    });

  program
    .command("context")
    .description("map source files to documents to read, including the requires closure")
    .requiredOption("--files <files...>", "one or more source file paths")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(
        writeOutput(
          "context",
          runContext({
            ...globalOptions,
            cwd: rootDir,
            files: commandOptions.files
          }),
          globalOptions.json
        )
      );
    });

  program
    .command("validate")
    .description("validate llmdoc structure and references")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      const result = runValidate({ ...globalOptions, ...commandOptions, cwd: rootDir });
      exitCode = result.exitCode;
      output.push(writeOutput("validate", result.output, globalOptions.json));
    });

  program
    .command("status")
    .description("inspect baseline digest, Git hints, dirty, and growth state")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("status", runStatus({ ...globalOptions, ...commandOptions, cwd: rootDir }), globalOptions.json));
    });

  program
    .command("delta")
    .description("inspect document impacts from code changes and choose light or deep update mode")
    .option("--scope <scope...>", "limit comparison to selected topics or documents")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("delta", runDelta({ ...globalOptions, ...commandOptions, cwd: rootDir }), globalOptions.json));
    });

  program
    .command("fingerprint")
    .description("refresh document content digests (`llmdoc.meta/v4`) against current implementation files")
    .option("--update <path...>", "refresh only selected documents")
    .option("--all", "refresh every document and advance the baseline surface digest")
    .option("--require-clean", "refuse to advance if mapped files have uncommitted Git changes")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(
        writeOutput(
          "fingerprint",
          runFingerprint({
            ...globalOptions,
            cwd: rootDir,
            update: commandOptions.update,
            all: commandOptions.all,
            requireClean: commandOptions.requireClean
          }),
          globalOptions.json
        )
      );
    });

  program
    .command("finalize")
    .description("Git-free finalization: validate workspace, refresh content digests, and clean orphan ledger entries")
    .option("--all", "fingerprint every document and advance the baseline surface digest")
    .option("--verified <paths...>", "refresh digests for verified documents")
    .option("--update <paths...>", "alias for --verified")
    .option("--require-clean", "refuse to advance if mapped files have uncommitted Git changes")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(
        writeOutput(
          "finalize",
          runFinalize({
            ...globalOptions,
            cwd: rootDir,
            all: commandOptions.all,
            verified: commandOptions.verified,
            update: commandOptions.update,
            requireClean: commandOptions.requireClean
          }),
          globalOptions.json
        )
      );
    });

  program
    .command("init-state")
    .description("create the initial llmdoc.meta/v4 ledger with null codeDigest values (works with or without Git)")
    .addHelpText(
      "after",
      "\nNext: run `llmdoc validate`, then finish bootstrap with `llmdoc finalize --all` (or `llmdoc commit --all -m \"docs: bootstrap llmdoc\"` in Git repos)."
    )
    .action(async () => {
      const { runInitState } = await import("./commands/init-state.js");
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("initState", runInitState({ ...globalOptions, cwd: rootDir }), globalOptions.json));
    });

  program
    .command("commit")
    .description("Git wrapper: run finalize and land docs + meta.json in a single Git commit")
    .option("-m, --message <message>", "docs commit message")
    .option("--all", "fingerprint every document and advance the baseline")
    .option("--verified <paths...>", "refresh digests for reviewed documents whose bodies did not change")
    .option("--require-clean", "refuse to commit if mapped source code has uncommitted Git changes")
    .option("--no-verify", "pass --no-verify through to git commit")
    .action(async (commandOptions) => {
      const { runCommit } = await import("./commands/commit.js");
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(
        writeOutput(
          "commit",
          runCommit({
            ...globalOptions,
            cwd: rootDir,
            message: commandOptions.message,
            all: commandOptions.all,
            verified: commandOptions.verified,
            requireClean: commandOptions.requireClean,
            noVerify: commandOptions.verify === false
          }),
          globalOptions.json
        )
      );
    });

  program
    .command("new")
    .description("scaffold a document under llmdoc/ (works with or without Git)")
    .argument("<path>", "target path, such as api-client/retry-policy.mdx")
    .requiredOption("--kind <kind>", "document kind: architecture | guide | reference")
    .option("--description <description>", "one-line front matter description")
    .addHelpText(
      "after",
      "\nThe first document creates llmdoc/ automatically. Finish bootstrap with init-state → validate → finalize --all (or commit --all)."
    )
    .action((targetPath, commandOptions) => {
      output.push(
        writeOutput(
          "new",
          runNew({
            ...globalOptions,
            cwd,
            path: targetPath,
            kind: commandOptions.kind,
            description: commandOptions.description
          }),
          globalOptions.json
        )
      );
    });

  program
    .command("adopt")
    .description("register existing .mdx documents in meta.json without rewriting them")
    .argument("<path...>", "one or more existing paths under llmdoc/")
    .action(async (paths) => {
      const { runAdopt } = await import("./commands/adopt.js");
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("adopt", runAdopt({ ...globalOptions, cwd: rootDir, paths }), globalOptions.json));
    });

  program
    .command("mv")
    .description("move or rename a document or topic transactionally (no Git required) and rewrite internal references")
    .argument("<from>", "source path")
    .argument("<to>", "target path")
    .action((from, to) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("mv", runMove({ ...globalOptions, cwd: rootDir, from, to }), globalOptions.json));
    });

  program
    .command("prune")
    .description("output a read-only convergence report")
    .option("--report", "output the read-only report")
    .action((commandOptions) => {
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(writeOutput("prune", runPrune({ ...globalOptions, cwd: rootDir, report: commandOptions.report }), globalOptions.json));
    });

  program
    .command("upgrade")
    .description("inventory legacy/V2 to V3 migration needs")
    .action(async (commandOptions) => {
      const { runUpgrade } = await import("./commands/upgrade.js");
      const rootDir = findProjectRootOrNull(cwd, resolutionOpts) ?? cwd;
      output.push(writeOutput("upgrade", await runUpgrade({ ...globalOptions, ...commandOptions, cwd: rootDir }), globalOptions.json));
    });

  const hookCommand = program.command("hook").description("read-only, fail-open signals for editor and Agent hooks");
  hookCommand
    .command("session-start")
    .description("output SessionStart state and apply optional llmdoc.config.json startup config")
    .action(() => {
      const rootDir = findProjectRootOrNull(cwd, resolutionOpts) ?? cwd;
      output.push(runHook({ cwd: rootDir, docsDir: globalOptions.docsDir, mode: "session-start", stdin }));
    });
  hookCommand
    .command("stop")
    .description("output the Stop hook JSON reminder")
    .action(() => {
      const rootDir = findProjectRootOrNull(cwd, resolutionOpts) ?? cwd;
      output.push(
        parseAndValidateJsonString("hook", runHook({ cwd: rootDir, docsDir: globalOptions.docsDir, mode: "stop", stdin }))
      );
    });
  hookCommand
    .command("compact")
    .description("output the PreCompact hook JSON instruction")
    .action(() => {
      const rootDir = findProjectRootOrNull(cwd, resolutionOpts) ?? cwd;
      output.push(
        parseAndValidateJsonString("hook", runHook({ cwd: rootDir, docsDir: globalOptions.docsDir, mode: "compact", stdin }))
      );
    });

  program
    .command("serve")
    .description("start the local Web Viewer; press Ctrl-C to stop")
    .option("--port <port>", "listening port", parseInteger)
    .action(async (commandOptions) => {
      const { runServe } = await import("./commands/serve.js");
      const rootDir = findProjectRoot(cwd, resolutionOpts);
      output.push(await runServe({ cwd: rootDir, docsDir: globalOptions.docsDir, port: commandOptions.port }));
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CliError) {
      return {
        exitCode: error.exitCode,
        stdout: error.message
      };
    }
    throw error;
  }

  return {
    exitCode,
    stdout: output.join("\n")
  };
}

function stringifyOutput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function writeOutput(schemaName: OutputSchemaName, value: unknown, expectJson = false): string {
  if (expectJson) {
    return stringifyValidatedOutput(schemaName, value);
  }
  return stringifyOutput(value);
}

function parseInteger(input: string): number {
  const value = Number.parseInt(input, 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new CliError(`Invalid integer: ${input}`);
  }
  return value;
}

function readPackageVersion(): string {
  const packageRoot = packageRootFromImport(import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
  return packageJson.version;
}

function parseGlobalOptions(argv: string[]): GlobalCliOptions {
  const options: GlobalCliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
    } else if (token === "--cursor" && argv[index + 1]) {
      options.cursor = argv[index + 1];
      index += 1;
    } else if (token === "--budget" && argv[index + 1]) {
      options.budget = parseInteger(argv[index + 1]!);
      index += 1;
    } else if (token === "--limit" && argv[index + 1]) {
      options.limit = parseInteger(argv[index + 1]!);
      index += 1;
    } else if (token === "--root" && argv[index + 1]) {
      options.root = argv[index + 1];
      index += 1;
    } else if (token === "--docs-dir" && argv[index + 1]) {
      options.docsDir = argv[index + 1];
      index += 1;
    }
  }
  return options;
}
