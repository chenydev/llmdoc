#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const limits = new Map([
  ["skills/llmdoc/SKILL.md", 1_600],
  ["skills/init/SKILL.md", 2_000],
  ["skills/update/SKILL.md", 2_000],
  ["skills/prune/SKILL.md", 2_000],
  ["skills/upgrade/SKILL.md", 2_000]
]);

const failures = [];

for (const [relativePath, limit] of limits) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  const estimated = estimateTokens(content);
  if (estimated > limit) {
    failures.push(`${relativePath}: ~${estimated} tokens exceeds ${limit}`);
  } else {
    process.stdout.write(`${relativePath}: ~${estimated}/${limit} tokens\n`);
  }
}

const hookCases = [
  { mode: "stop", limit: 300, stdin: "{}", json: true },
  { mode: "compact", limit: 300, stdin: "{}", json: true }
];

for (const hookCase of hookCases) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "cli/dist/bin/llmdoc.js"), "hook", hookCase.mode],
    { cwd: root, encoding: "utf8", input: hookCase.stdin }
  );
  if (result.status !== 0) {
    failures.push(`hook ${hookCase.mode}: exited ${result.status}: ${result.stderr.trim()}`);
    continue;
  }
  const output = result.stdout.trim();
  const estimated = estimateTokens(output);
  if (hookCase.json) {
    try {
      JSON.parse(output);
    } catch {
      failures.push(`hook ${hookCase.mode}: output is not valid JSON`);
    }
  }
  if (estimated > hookCase.limit) {
    failures.push(`hook ${hookCase.mode}: ~${estimated} tokens exceeds ${hookCase.limit}`);
  } else {
    process.stdout.write(`hook ${hookCase.mode}: ~${estimated}/${hookCase.limit} tokens\n`);
  }
}

// Execute the actual plugin hook commands with local node_modules/.bin on PATH
// so they test the built fork CLI directly without touching npm.
const hookConfig = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8"));
const localBinDir = path.join(root, "node_modules", ".bin");
const hookEnv = {
  ...process.env,
  PATH: `${localBinDir}${path.delimiter}${process.env.PATH ?? ""}`
};
const launcherCases = [
  { event: "SessionStart", stdin: JSON.stringify({ source: "startup" }), json: false },
  { event: "Stop", stdin: "{}", json: true },
  { event: "PreCompact", stdin: "{}", json: true }
];

for (const launcherCase of launcherCases) {
  const configured = hookConfig.hooks?.[launcherCase.event]?.flatMap((group) => group.hooks ?? []) ?? [];
  if (configured.length !== 1 || typeof configured[0]?.command !== "string") {
    failures.push(`hook launcher ${launcherCase.event}: expected exactly one command`);
    continue;
  }
  const result = spawnSync(configured[0].command, {
    cwd: root,
    encoding: "utf8",
    input: launcherCase.stdin,
    shell: true,
    env: hookEnv,
    timeout: 120_000
  });
  if (result.error) {
    failures.push(`hook launcher ${launcherCase.event}: ${result.error.message}`);
    continue;
  }
  if (result.status !== 0) {
    failures.push(
      `hook launcher ${launcherCase.event}: exited ${result.status}: ${(result.stderr ?? "").trim()}`
    );
    continue;
  }
  const output = result.stdout.trim();
  if (launcherCase.json) {
    try {
      JSON.parse(output);
    } catch {
      failures.push(`hook launcher ${launcherCase.event}: output is not valid JSON`);
      continue;
    }
  }
  process.stdout.write(`hook launcher ${launcherCase.event}: ok\n`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

function estimateTokens(text) {
  let count = 0;
  for (const segment of text.match(/[\p{Script=Han}]|[A-Za-z0-9_]+|[^\s]/gu) ?? []) {
    count += /[\p{Script=Han}]/u.test(segment) ? 1 : Math.max(1, Math.ceil(segment.length / 4));
  }
  return count;
}
