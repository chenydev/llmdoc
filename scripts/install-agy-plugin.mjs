#!/usr/bin/env node
/**
 * Build the fork CLI + native Antigravity (`agy`) plugin and sync it into
 * `~/.gemini/config/plugins/llmdoc` (or a custom `--target <dir>`).
 * Optionally also links `~/.local/bin/llmdoc` (`--link-bin` or `--bin-dir <dir>`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildAgyPlugin } from "./build-agy-plugin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

let targetDir = path.join(os.homedir(), ".gemini", "config", "plugins", "llmdoc");
let binDir = null;
let skipBuild = false;

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--target" && args[i + 1]) {
    targetDir = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--bin-dir" && args[i + 1]) {
    binDir = path.resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === "--link-bin") {
    binDir = path.join(os.homedir(), ".local", "bin");
  } else if (args[i] === "--skip-build") {
    skipBuild = true;
  }
}

if (!skipBuild) {
  const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const cliEntry = path.join(repoRoot, "cli", "dist", "bin", "llmdoc.js");
if (!fs.existsSync(cliEntry)) {
  console.error(`CLI build artifact not found: ${cliEntry}`);
  process.exit(1);
}

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdoc-agy-install-"));
try {
  buildAgyPlugin({ outDir: stagingDir, cliEntry });

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const backupDir = `${targetDir}.bak-${Date.now()}`;
  const hadExisting = fs.existsSync(targetDir);
  if (hadExisting) {
    fs.renameSync(targetDir, backupDir);
  }
  try {
    fs.cpSync(stagingDir, targetDir, { recursive: true });
    // Ensure executables retain +x bits after copy.
    for (const rel of ["hooks/llmdoc-hook.py", "bin/llmdoc"]) {
      const full = path.join(targetDir, rel);
      if (fs.existsSync(full)) {
        fs.chmodSync(full, 0o755);
      }
    }
    if (hadExisting) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hadExisting && fs.existsSync(backupDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  }

  console.log(`installed agy plugin -> ${targetDir}`);
  console.log(`bundled CLI launcher -> ${path.join(targetDir, "bin", "llmdoc")} -> ${cliEntry}`);

  if (binDir) {
    fs.mkdirSync(binDir, { recursive: true });
    const binLink = path.join(binDir, "llmdoc");
    fs.rmSync(binLink, { force: true });
    fs.symlinkSync(cliEntry, binLink);
    console.log(`linked CLI binary -> ${binLink} -> ${cliEntry}`);
  }
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
