#!/usr/bin/env node
/**
 * Sync Codex surfaces (`.agents/skills/**` and `.codex/agents/*.toml`)
 * from canonical Claude authoring surfaces (`skills/**` and `agents/*.md`),
 * preserving Codex host-specific frontmatter/TOML fields.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const name of ["llmdoc", "init", "update", "prune", "upgrade"]) {
  const claudeFile = path.join(repoRoot, "skills", name, "SKILL.md");
  const codexFile = path.join(repoRoot, ".agents", "skills", name, "SKILL.md");
  const claudeRaw = fs.readFileSync(claudeFile, "utf8");
  const codexRaw = fs.readFileSync(codexFile, "utf8");

  const claudeMatch = claudeRaw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  const codexMatch = codexRaw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)[\s\S]*$/);
  if (!claudeMatch || !codexMatch) {
    throw new Error(`Unable to parse frontmatter for skill ${name}`);
  }
  const nextCodex = `${codexMatch[1]}${claudeMatch[1]}`;
  fs.writeFileSync(codexFile, nextCodex);
}

for (const rel of ["llmdoc/references/knowledge-topology.md", "llmdoc/references/startup-config.md"]) {
  fs.copyFileSync(path.join(repoRoot, "skills", rel), path.join(repoRoot, ".agents", "skills", rel));
}

for (const name of ["investigator", "reflector", "recorder"]) {
  const claudeFile = path.join(repoRoot, "agents", `${name}.md`);
  const codexFile = path.join(repoRoot, ".codex", "agents", `${name}.toml`);
  const claudeRaw = fs.readFileSync(claudeFile, "utf8");
  const codexRaw = fs.readFileSync(codexFile, "utf8");

  const bodyMatch = claudeRaw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  const tomlMatch = codexRaw.match(/^([\s\S]*?developer_instructions = """\r?\n)[\s\S]*?("""\r?\nmodel\s*=[\s\S]*)$/);
  if (!bodyMatch || !tomlMatch) {
    throw new Error(`Unable to sync agent ${name}`);
  }
  const body = bodyMatch[1].replace(/\r\n/g, "\n").trim();
  const nextToml = `${tomlMatch[1]}\n${body}\n${tomlMatch[2]}`;
  fs.writeFileSync(codexFile, nextToml);
}

console.log("synced Codex skills and agents from canonical sources");
