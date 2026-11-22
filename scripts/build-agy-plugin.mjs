#!/usr/bin/env node
/**
 * Build the native Antigravity (`agy`) plugin bundle from canonical repo sources
 * (root `skills/`, root `agents/`, and `agy-plugin/` host files) with zero prose drift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AGY_AGENT_CONFIG = {
  investigator: {
    tools: ["read_file", "edit_file", "write_file", "run_command", "manage_task", "search_web"]
  },
  recorder: {
    tools: ["read_file", "edit_file", "write_file", "run_command", "manage_task"]
  },
  reflector: {
    tools: ["read_file", "edit_file", "write_file", "run_command", "manage_task"]
  }
};

export function buildAgyPlugin(options = {}) {
  const outDir = path.resolve(options.outDir ?? path.join(repoRoot, "dist", "agy-plugin"));
  const cliEntry = options.cliEntry ? path.resolve(options.cliEntry) : null;

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Copy agy-specific root files (plugin.json, hooks.json, hooks/, assets/).
  const agySource = path.join(repoRoot, "agy-plugin");
  copyDir(agySource, outDir);

  // Ensure hook script is executable.
  const hookScript = path.join(outDir, "hooks", "llmdoc-hook.py");
  if (fs.existsSync(hookScript)) {
    fs.chmodSync(hookScript, 0o755);
  }

  // 2. Copy canonical skills/ and rewrite CLI invocation hints for agy native CLI usage.
  const skillsDest = path.join(outDir, "skills");
  copySkillsForAgy(path.join(repoRoot, "skills"), skillsDest);

  // 3. Build native agy agents/ from canonical agents/*.md with agy frontmatter.
  const agentsDest = path.join(outDir, "agents");
  fs.mkdirSync(agentsDest, { recursive: true });
  for (const [name, config] of Object.entries(AGY_AGENT_CONFIG)) {
    const srcPath = path.join(repoRoot, "agents", `${name}.md`);
    const raw = fs.readFileSync(srcPath, "utf8");
    const parsed = matter(raw);
    const description = String(parsed.data.description ?? "");
    const body = adaptBodyForAgy(parsed.content.trim());
    const frontmatter = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      "subagent: true",
      "mainAgent: false",
      `tools: [${config.tools.join(", ")}]`,
      "---"
    ].join("\n");
    fs.writeFileSync(path.join(agentsDest, `${name}.md`), `${frontmatter}\n\n${body}\n`);
  }

  // 4. Optional local CLI launcher `<plugin>/bin/llmdoc` pointing to built fork CLI.
  if (cliEntry) {
    const binDir = path.join(outDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const launcherPath = path.join(binDir, "llmdoc");
    const launcher = `#!/usr/bin/env bash\nexec node ${JSON.stringify(cliEntry)} "$@"\n`;
    fs.writeFileSync(launcherPath, launcher, { mode: 0o755 });
    fs.chmodSync(launcherPath, 0o755);
  }

  // 5. Copy README files if present.
  for (const doc of ["README.md", "README.zh-CN.md"]) {
    const src = path.join(repoRoot, doc);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, doc));
    }
  }

  return outDir;
}

function copySkillsForAgy(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copySkillsForAgy(srcPath, destPath);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".md")) {
        const raw = fs.readFileSync(srcPath, "utf8");
        fs.writeFileSync(destPath, adaptSkillFileForAgy(raw, entry.name === "SKILL.md"));
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function adaptSkillFileForAgy(raw, isSkillMd) {
  if (!isSkillMd) {
    return adaptBodyForAgy(raw);
  }
  const parsed = matter(raw);
  const data = { ...parsed.data };
  // Claude-only allowed-tools header is omitted in agy skills.
  delete data["allowed-tools"];
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      fmLines.push(`${key}: ${JSON.stringify(value)}`);
    } else if (typeof value === "boolean") {
      fmLines.push(`${key}: ${value}`);
    }
  }
  fmLines.push("---");
  return `${fmLines.join("\n")}\n\n${adaptBodyForAgy(parsed.content.trim())}\n`;
}

function adaptBodyForAgy(text) {
  return text;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let outDir;
  let cliEntry;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) {
      outDir = args[i + 1];
      i += 1;
    } else if (args[i] === "--cli-entry" && args[i + 1]) {
      cliEntry = args[i + 1];
      i += 1;
    }
  }
  const built = buildAgyPlugin({ outDir, cliEntry });
  console.log(`built agy plugin: ${built}`);
}
