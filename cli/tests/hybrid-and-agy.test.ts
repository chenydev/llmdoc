import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

import { runCli } from "../src/cli.js";
import { startViewerServer } from "../src/commands/serve.js";
import { computeGitBlobHash, scanWorkspaceSurface } from "../src/lib/surface.js";
import { loadWorkspace } from "../src/lib/workspace.js";
import { commitAll, createFixture, readMeta, writeRepoFile } from "./helpers.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BUILT_CLI_BIN = path.join(REPO_ROOT, "cli", "dist", "bin", "llmdoc.js");
const AGY_HOOK_SCRIPT = path.join(REPO_ROOT, "agy-plugin", "hooks", "llmdoc-hook.py");

describe("hybrid content-digest architecture and agy plugin", () => {
  test("full non-Git lifecycle: new -> init-state -> delta -> validate -> fingerprint -> finalize -> mv -> serve", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-nongit-full-"));
    writeRepoFile(dir, "src/core/engine.ts", "export const version = 1;\n");
    writeRepoFile(dir, "src/core/helper.ts", "export const helper = true;\n");
    writeRepoFile(dir, "flake.lock", '{"nodes":{}}\n');
    writeRepoFile(dir, ".gitignore", "build/\n*.log\n");
    writeRepoFile(dir, "build/output.js", "console.log('ignored');\n");
    writeRepoFile(dir, "debug.log", "ignored log\n");

    // 1. new
    const newArch = await runCli(
      ["new", "architecture.mdx", "--kind", "architecture", "--description", "Core engine architecture."],
      dir
    );
    expect(newArch.exitCode).toBe(0);
    const newDoc = await runCli(
      ["new", "core/engine.mdx", "--kind", "reference", "--description", "Engine contract."],
      dir
    );
    expect(newDoc.exitCode).toBe(0);

    // Attach code.paths and an internal link so mv exercises rewriting without Git.
    writeRepoFile(
      dir,
      "llmdoc/architecture.mdx",
      `---\ndescription: Core engine architecture.\nkind: architecture\ncode:\n  paths:\n    - src/core/engine.ts\n---\n\n# Architecture\n\nSee [Engine](./core/engine.mdx).\n`
    );
    writeRepoFile(
      dir,
      "llmdoc/core/engine.mdx",
      `---\ndescription: Engine contract.\nkind: reference\ncode:\n  paths:\n    - src/core/engine.ts\n---\n\n# Engine\n`
    );

    // 2. init-state
    const init = await runCli(["--json", "init-state"], dir);
    expect(init.exitCode).toBe(0);
    const initPayload = JSON.parse(init.stdout) as { schema: string; baselineDigest: string; baselineRevision: string | null };
    expect(initPayload.schema).toBe("llmdoc.meta/v4");
    expect(initPayload.baselineDigest).toMatch(/^sha256:/);
    expect(initPayload.baselineRevision).toBeNull();

    // 3. validate passes in non-Git dir
    const val = await runCli(["validate"], dir);
    expect(val.exitCode).toBe(0);

    // 4. delta reports unverified docs before finalize
    const deltaBefore = await runCli(["--json", "delta"], dir);
    expect(deltaBefore.exitCode).toBe(0);
    const deltaBeforeJson = JSON.parse(deltaBefore.stdout) as {
      trackingMode: string;
      degradedReason: string | null;
      impacted: Array<{ path: string }>;
    };
    expect(deltaBeforeJson.trackingMode).toBe("filesystem");
    expect(deltaBeforeJson.degradedReason).toBeNull();
    expect(deltaBeforeJson.impacted).toHaveLength(2);

    // 5. finalize --all stamps v4 content digests without Git
    const fin = await runCli(["--json", "finalize", "--all"], dir);
    expect(fin.exitCode).toBe(0);
    const finJson = JSON.parse(fin.stdout) as { status: string; updated: string[]; baselineDigest: string };
    expect(finJson.status).toBe("success");
    expect(finJson.updated).toEqual(["architecture.mdx", "core/engine.mdx"]);

    // 6. delta & status are now completely clean; ignored files (build/, *.log, flake.lock) never show as unmapped
    const deltaClean = await runCli(["--json", "delta"], dir);
    const deltaCleanJson = JSON.parse(deltaClean.stdout) as {
      suggestedMode: string;
      impacted: unknown[];
      unmapped: { committed: string[]; dirty: string[] };
    };
    expect(deltaCleanJson.suggestedMode).toBe("light");
    expect(deltaCleanJson.impacted).toHaveLength(0);
    expect(deltaCleanJson.unmapped.committed).toEqual([]);
    expect(deltaCleanJson.unmapped.dirty).toEqual([]);

    // 7. Modify mapped file & add unmapped file -> delta accurately detects both without Git!
    writeRepoFile(dir, "src/core/engine.ts", "export const version = 2;\n");
    writeRepoFile(dir, "src/core/new-unmapped.ts", "export const fresh = 1;\n");
    writeRepoFile(dir, "build/another.js", "still ignored\n");
    const deltaAfterEdit = await runCli(["--json", "delta"], dir);
    const deltaAfterEditJson = JSON.parse(deltaAfterEdit.stdout) as {
      impacted: Array<{ path: string; changedPaths: string[] }>;
      unmapped: { committed: string[]; dirty: string[] };
    };
    expect(deltaAfterEditJson.impacted.map((i) => i.path)).toEqual(["llmdoc/architecture.mdx", "llmdoc/core/engine.mdx"]);
    expect(deltaAfterEditJson.impacted[0]!.changedPaths).toEqual(["src/core/engine.ts"]);
    expect(deltaAfterEditJson.unmapped.committed).toContain("src/core/new-unmapped.ts");
    expect(deltaAfterEditJson.unmapped.committed).not.toContain("build/another.js");
    expect(deltaAfterEditJson.unmapped.committed).not.toContain("flake.lock");

    // 8. fingerprint partial doc in non-Git dir
    const fp = await runCli(["--json", "fingerprint", "--update", "core/engine.mdx"], dir);
    expect(fp.exitCode).toBe(0);
    const deltaPartial = await runCli(["--json", "delta"], dir);
    const deltaPartialJson = JSON.parse(deltaPartial.stdout) as { impacted: Array<{ path: string }> };
    expect(deltaPartialJson.impacted.map((i) => i.path)).toEqual(["llmdoc/architecture.mdx"]);

    // 9. mv works transactionally without Git and rewrites links + ledger
    const moved = await runCli(["--json", "mv", "core/engine.mdx", "core/runtime.mdx"], dir);
    expect(moved.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, "llmdoc", "core", "runtime.mdx"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "llmdoc", "core", "engine.mdx"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "llmdoc", "architecture.mdx"), "utf8")).toContain("core/runtime.mdx");
    expect(readMeta(dir).documents["core/runtime.mdx"]).toBeTruthy();
    expect(readMeta(dir).documents["core/engine.mdx"]).toBeUndefined();
    expect(fs.existsSync(path.join(dir, ".llmdoc-tmp", "txn"))).toBe(false);

    // 10. commit fails gracefully with helpful guidance in non-Git dir
    const badCommit = await runCli(["commit", "--all"], dir);
    expect(badCommit.exitCode).toBe(1);
    expect(badCommit.stdout).toContain("finalize");

    // 11. serve works in non-Git dir
    const server = await startViewerServer(dir, 0);
    try {
      const stateRes = await fetch(`${server.url}/api/state`);
      expect(stateRes.status).toBe(200);
      const state = (await stateRes.json()) as { baseline: { trackingMode: string; degradedReason: string | null } };
      expect(state.baseline.trackingMode).toBe("filesystem");
      expect(state.baseline.degradedReason).toBeNull();
    } finally {
      await server.close();
    }
  });

  test("Git hybrid fast path and pure filesystem path produce byte-for-byte identical blob hashes and surfaceDigest", () => {
    const rootDir = createFixture();
    writeRepoFile(rootDir, ".gitignore", "ignored-dir/\n*.tmp\n");
    writeRepoFile(rootDir, "ignored-dir/skip.ts", "export const skip = true;\n");
    writeRepoFile(rootDir, "temp.tmp", "ignored\n");
    writeRepoFile(rootDir, "flake.lock", '{"version":7}\n');
    writeRepoFile(rootDir, "src/中文目录/模块.ts", "export const 名称 = '测试';\n");
    writeRepoFile(rootDir, "src/empty.ts", "");
    commitAll(rootDir, "add test files");

    // Also add dirty modified + untracked files to verify hybrid path handles both identically.
    writeRepoFile(rootDir, "src/api/retry.ts", "export function isRetryable() { return 'dirty'; }\n");
    writeRepoFile(rootDir, "src/untracked.ts", "export const u = 42;\n");

    const workspace = loadWorkspace(rootDir);
    const gitHybrid = scanWorkspaceSurface(workspace, { forceMode: "git-hybrid", persistStatCache: false });
    const pureFs = scanWorkspaceSurface(workspace, { forceMode: "filesystem", persistStatCache: false });

    expect(gitHybrid.mode).toBe("git-hybrid");
    expect(pureFs.mode).toBe("filesystem");
    expect(gitHybrid.surfaceDigest).toBe(pureFs.surfaceDigest);
    expect([...gitHybrid.files.entries()].sort()).toEqual([...pureFs.files.entries()].sort());

    // Verify computed hash matches actual `git hash-object` output.
    const gitHash = spawnSync("git", ["hash-object", "src/api/retry.ts"], {
      cwd: rootDir,
      encoding: "utf8"
    }).stdout.trim();
    expect(gitHybrid.files.get("src/api/retry.ts")).toBe(gitHash);
    expect(computeGitBlobHash(fs.readFileSync(path.join(rootDir, "src/api/retry.ts")))).toBe(gitHash);
    expect(gitHybrid.files.has("flake.lock")).toBe(false);
    expect(gitHybrid.files.has("ignored-dir/skip.ts")).toBe(false);
    expect(gitHybrid.files.has("temp.tmp")).toBe(false);
  });

  test("v4 content digests produce zero false positives after git amend/squash/rebase or missing hintRevision", async () => {
    const rootDir = createFixture();
    const fin = await runCli(["--json", "commit", "--all", "-m", "docs: upgrade to v4"], rootDir);
    expect(fin.exitCode).toBe(0);
    const finPayload = JSON.parse(fin.stdout) as { commits: string[] };
    expect(finPayload.commits).toHaveLength(1);

    // Simulate a history rewrite (amend + orphan history / vanished hintRevision).
    spawnSync("git", ["commit", "--amend", "-m", "docs: amended history rewrite"], { cwd: rootDir, encoding: "utf8" });
    const metaPath = path.join(rootDir, "llmdoc", "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
      baseline: { hintRevision: string | null };
      documents: Record<string, { codeDigest: string; hintRevision: string | null }>;
    };
    // Overwrite hintRevision with vanished/rebased SHA and null — must NEVER fail validate or cause false impacts.
    meta.baseline.hintRevision = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    for (const entry of Object.values(meta.documents)) {
      entry.hintRevision = null;
    }
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    // Also wipe local cache to simulate fresh clone after rebase!
    fs.rmSync(path.join(rootDir, ".llmdoc-tmp"), { recursive: true, force: true });

    const validated = await runCli(["--json", "validate"], rootDir);
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ ok: true, errors: [], warnings: [] });

    const delta = await runCli(["--json", "delta"], rootDir);
    expect(delta.exitCode).toBe(0);
    const deltaJson = JSON.parse(delta.stdout) as {
      suggestedMode: string;
      degradedReason: string | null;
      impacted: unknown[];
      needsReview: unknown[];
      unmapped: { committed: string[]; dirty: string[] };
    };
    expect(deltaJson.suggestedMode).toBe("light");
    expect(deltaJson.degradedReason).toBeNull();
    expect(deltaJson.impacted).toEqual([]);
    expect(deltaJson.needsReview).toEqual([]);
    expect(deltaJson.unmapped).toEqual({ committed: [], dirty: [] });

    const status = await runCli(["--json", "status"], rootDir);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      degradedReason: null,
      documents: { total: 4, impacted: 0, needsReview: 0, dirty: 0 }
    });
  });

  test("multi-repo federated workspace crosses nested .git boundaries and supports codeRoots", async () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-federated-"));
    const repoA = path.join(wsRoot, "repo-a");
    const repoB = path.join(wsRoot, "repo-b");
    fs.mkdirSync(path.join(repoA, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoB, "src"), { recursive: true });
    // Initialize nested Git repos inside the federated workspace.
    for (const repo of [repoA, repoB]) {
      spawnSync("git", ["init", "--quiet"], { cwd: repo, encoding: "utf8" });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, encoding: "utf8" });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: repo, encoding: "utf8" });
    }
    writeRepoFile(repoA, "src/auth.ts", "export const auth = true;\n");
    writeRepoFile(repoB, "src/billing.ts", "export const billing = true;\n");
    commitAll(repoA, "init repo-a");
    commitAll(repoB, "init repo-b");

    writeRepoFile(
      wsRoot,
      "llmdoc.config.json",
      `${JSON.stringify(
        {
          schema: "llmdoc.config/v1",
          codeRoots: [
            { name: "auth-svc", path: "./repo-a" },
            { name: "billing-svc", path: "./repo-b" }
          ]
        },
        null,
        2
      )}\n`
    );
    writeRepoFile(
      wsRoot,
      "llmdoc/architecture.mdx",
      `---\ndescription: Federated workspace architecture.\nkind: architecture\ncode:\n  paths:\n    - auth-svc/src/auth.ts\n    - billing-svc/src/billing.ts\n---\n\n# Federated\n\nSee <CodeRef path="auth-svc/src/auth.ts" />.\n`
    );

    // Run commands from DEEP INSIDE nested Git sub-repo `repo-a/src` — must cross `repo-a/.git` to find `wsRoot`!
    const init = await runCli(["--json", "init-state"], path.join(repoA, "src"));
    expect(init.exitCode).toBe(0);
    const val = await runCli(["validate"], path.join(repoA, "src"));
    expect(val.exitCode).toBe(0);
    const fin = await runCli(["--json", "finalize", "--all"], path.join(repoB, "src"));
    expect(fin.exitCode).toBe(0);

    const ctx = await runCli(["--json", "context", "--files", "billing-svc/src/billing.ts"], path.join(repoA, "src"));
    expect(ctx.exitCode).toBe(0);
    expect(JSON.parse(ctx.stdout).impacted.map((d: { path: string }) => d.path)).toEqual(["llmdoc/architecture.mdx"]);

    // Modify file in repo-b -> delta invoked from repo-a detects impact!
    writeRepoFile(repoB, "src/billing.ts", "export const billing = 'v2';\n");
    const delta = await runCli(["--json", "delta"], path.join(repoA, "src"));
    expect(delta.exitCode).toBe(0);
    const deltaJson = JSON.parse(delta.stdout) as { impacted: Array<{ path: string; changedPaths: string[] }> };
    expect(deltaJson.impacted).toHaveLength(1);
    expect(deltaJson.impacted[0]!.changedPaths).toEqual(["billing-svc/src/billing.ts"]);
  });

  test("state.location: 'local' keeps llmdoc/ free of meta.json (project and user XDG paths)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-local-state-"));
    writeRepoFile(dir, "src/app.ts", "export const app = 1;\n");
    writeRepoFile(
      dir,
      "llmdoc.config.json",
      `${JSON.stringify({ schema: "llmdoc.config/v1", state: { location: "local" } }, null, 2)}\n`
    );
    writeRepoFile(
      dir,
      "llmdoc/architecture.mdx",
      `---\ndescription: Local state doc.\nkind: architecture\ncode:\n  paths:\n    - src/app.ts\n---\n\n# App\n`
    );

    const init = await runCli(["--json", "init-state"], dir);
    expect(init.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, "llmdoc", "meta.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".llmdoc-tmp", "meta.json"))).toBe(true);

    expect((await runCli(["validate"], dir)).exitCode).toBe(0);
    expect((await runCli(["finalize", "--all"], dir)).exitCode).toBe(0);

    const status = await runCli(["--json", "status"], dir);
    expect(JSON.parse(status.stdout)).toMatchObject({ metaLocation: "local", documents: { impacted: 0 } });

    // Also verify `localPath: "user"` with custom XDG_STATE_HOME
    const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-xdg-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = xdgDir;
    try {
      writeRepoFile(
        dir,
        "llmdoc.config.json",
        `${JSON.stringify({ schema: "llmdoc.config/v1", state: { location: "local", localPath: "user" } }, null, 2)}\n`
      );
      const userInit = await runCli(["--json", "init-state"], dir);
      expect(userInit.exitCode).toBe(0);
      const userInitJson = JSON.parse(userInit.stdout) as { metaPath: string };
      expect(userInitJson.metaPath.startsWith(xdgDir)).toBe(true);
      expect(fs.existsSync(userInitJson.metaPath)).toBe(true);
      expect((await runCli(["finalize", "--all"], dir)).exitCode).toBe(0);
      expect((await runCli(["validate"], dir)).exitCode).toBe(0);
    } finally {
      if (prevXdg === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = prevXdg;
      }
    }
  });

  test("external docsDir (--docs-dir / config.docsDir) splits docsRoot and codeRoot sandboxes", async () => {
    const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-ext-code-"));
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-ext-docs-"));
    writeRepoFile(codeDir, "src/index.ts", "export const ok = true;\n");

    const created = await runCli(
      ["--docs-dir", docsDir, "new", "architecture.mdx", "--kind", "architecture", "--description", "External KB."],
      codeDir
    );
    expect(created.exitCode).toBe(0);
    expect(fs.existsSync(path.join(docsDir, "architecture.mdx"))).toBe(true);
    expect(fs.existsSync(path.join(codeDir, "llmdoc"))).toBe(false);

    fs.writeFileSync(
      path.join(docsDir, "architecture.mdx"),
      `---\ndescription: External KB.\nkind: architecture\ncode:\n  paths:\n    - src/index.ts\n---\n\n# External KB\n\nSee <CodeRef path="src/index.ts" />.\n`
    );

    expect((await runCli(["--docs-dir", docsDir, "init-state"], codeDir)).exitCode).toBe(0);
    expect((await runCli(["--docs-dir", docsDir, "validate"], codeDir)).exitCode).toBe(0);
    expect((await runCli(["--docs-dir", docsDir, "finalize", "--all"], codeDir)).exitCode).toBe(0);

    const cleanDelta = await runCli(["--docs-dir", docsDir, "--json", "delta"], codeDir);
    expect(JSON.parse(cleanDelta.stdout).impacted).toEqual([]);

    writeRepoFile(codeDir, "src/index.ts", "export const ok = false;\n");
    const dirtyDelta = await runCli(["--docs-dir", docsDir, "--json", "delta"], codeDir);
    expect(JSON.parse(dirtyDelta.stdout).impacted).toHaveLength(1);
  });

  test("agy hook bridge (SessionStart & PostInvocation) works in Git, non-Git, and federated workspaces", async () => {
    // 1. Non-Git workspace
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-agy-nongit-"));
    writeRepoFile(nonGitDir, "src/main.ts", "export const x = 1;\n");
    writeRepoFile(
      nonGitDir,
      "llmdoc/architecture.mdx",
      `---\ndescription: Non-Git architecture.\nkind: architecture\ncode:\n  paths:\n    - src/main.ts\n---\n\n# Main\n`
    );
    expect((await runCli(["init-state"], nonGitDir)).exitCode).toBe(0);
    expect((await runCli(["finalize", "--all"], nonGitDir)).exitCode).toBe(0);

    const hookEnv = {
      ...process.env,
      LLMDOC_BIN: BUILT_CLI_BIN,
      PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-agy-data-"))
    };

    const startRes = spawnSync(
      "python3",
      [AGY_HOOK_SCRIPT, "SessionStart"],
      {
        input: JSON.stringify({ cwd: nonGitDir, workspacePaths: [nonGitDir], lastUserInput: "hello" }),
        encoding: "utf8",
        env: hookEnv
      }
    );
    expect(startRes.status).toBe(0);
    const startJson = JSON.parse(startRes.stdout) as { injectSteps?: Array<{ systemMessage?: { systemMessage?: string } }> };
    expect(startJson.injectSteps?.[0]?.systemMessage?.systemMessage).toContain("documents have no actionable impacts");

    // 2. Modify code in non-Git dir -> PostInvocation emits user_markdown stop reminder!
    writeRepoFile(nonGitDir, "src/main.ts", "export const x = 2;\n");
    const transcriptPath = path.join(os.tmpdir(), `llmdoc-transcript-${Date.now()}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ source: "USER_EXPLICIT", type: "USER_INPUT", content: "edit main.ts" }),
        JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "Done.", tool_calls: [] })
      ].join("\n") + "\n"
    );
    const postRes = spawnSync(
      "python3",
      [AGY_HOOK_SCRIPT, "PostInvocation"],
      {
        input: JSON.stringify({
          conversationId: "conv-nongit-1",
          cwd: nonGitDir,
          workspacePaths: [nonGitDir],
          transcriptPath,
          lastUserInput: "edit main.ts"
        }),
        encoding: "utf8",
        env: hookEnv
      }
    );
    expect(postRes.status).toBe(0);
    const postJson = JSON.parse(postRes.stdout) as {
      injectSteps?: Array<{ systemMessage?: { systemMessage?: string; metadata?: { user_markdown?: string } } }>;
    };
    expect(postJson.injectSteps?.[0]?.systemMessage?.systemMessage).toBe("");
    expect(postJson.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown).toContain("/llmdoc:update");

    // 3. Federated nested Git sub-repo -> SessionStart crosses sub-repo `.git` to find parent `llmdoc.config.json`!
    const fedDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-agy-fed-"));
    const subRepo = path.join(fedDir, "sub-repo");
    fs.mkdirSync(path.join(subRepo, ".git"), { recursive: true });
    writeRepoFile(fedDir, "llmdoc.config.json", `${JSON.stringify({ schema: "llmdoc.config/v1" }, null, 2)}\n`);
    writeRepoFile(
      fedDir,
      "llmdoc/architecture.mdx",
      `---\ndescription: Federated doc.\nkind: architecture\n---\n\n# Fed\n`
    );
    expect((await runCli(["init-state"], fedDir)).exitCode).toBe(0);
    expect((await runCli(["finalize", "--all"], fedDir)).exitCode).toBe(0);

    const fedStart = spawnSync(
      "python3",
      [AGY_HOOK_SCRIPT, "SessionStart"],
      {
        input: JSON.stringify({ cwd: subRepo, workspacePaths: [subRepo], lastUserInput: "check" }),
        encoding: "utf8",
        env: hookEnv
      }
    );
    expect(fedStart.status).toBe(0);
    const fedStartJson = JSON.parse(fedStart.stdout) as { injectSteps?: Array<{ systemMessage?: { systemMessage?: string } }> };
    expect(fedStartJson.injectSteps?.[0]?.systemMessage?.systemMessage).toContain("llmdoc cold start");

    // 4. Bare directory without llmdoc -> silent `{}`
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-agy-bare-"));
    const bareStart = spawnSync(
      "python3",
      [AGY_HOOK_SCRIPT, "SessionStart"],
      {
        input: JSON.stringify({ cwd: bareDir, workspacePaths: [bareDir], lastUserInput: "hi" }),
        encoding: "utf8",
        env: hookEnv
      }
    );
    expect(bareStart.status).toBe(0);
    expect(JSON.parse(bareStart.stdout)).toEqual({});

    // 5. Verify install-agy-plugin.mjs builds a complete native agy plugin with bundled bin/llmdoc
    const installedPluginDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-agy-install-")), "llmdoc");
    const installRes = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "install-agy-plugin.mjs"), "--skip-build", "--target", installedPluginDir],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(installRes.status).toBe(0);
    expect(fs.existsSync(path.join(installedPluginDir, "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(installedPluginDir, "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(installedPluginDir, "hooks", "llmdoc-hook.py"))).toBe(true);
    expect(fs.existsSync(path.join(installedPluginDir, "bin", "llmdoc"))).toBe(true);
    expect(fs.existsSync(path.join(installedPluginDir, "agents", "recorder.md"))).toBe(true);
    expect(fs.existsSync(path.join(installedPluginDir, "skills", "llmdoc", "SKILL.md"))).toBe(true);

    // Run the installed plugin's hook WITHOUT LLMDOC_BIN — must automatically pick bundled `<plugin>/bin/llmdoc`!
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, PLUGIN_ROOT: installedPluginDir };
    delete cleanEnv.LLMDOC_BIN;
    const bundledStart = spawnSync(
      "python3",
      [path.join(installedPluginDir, "hooks", "llmdoc-hook.py"), "SessionStart"],
      {
        cwd: installedPluginDir,
        input: JSON.stringify({ cwd: nonGitDir, workspacePaths: [nonGitDir], lastUserInput: "hi" }),
        encoding: "utf8",
        env: cleanEnv
      }
    );
    expect(bundledStart.status).toBe(0);
    const bundledJson = JSON.parse(bundledStart.stdout) as { injectSteps?: Array<{ systemMessage?: { systemMessage?: string } }> };
    expect(bundledJson.injectSteps?.[0]?.systemMessage?.systemMessage).toContain("llmdoc cold start");
  });
});
