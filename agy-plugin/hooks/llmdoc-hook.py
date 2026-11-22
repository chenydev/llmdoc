#!/usr/bin/env python3
"""Antigravity (agy) lifecycle hook bridge for llmdoc (content-addressed hybrid mode).

Events:
- SessionStart: Injects canonical `llmdoc hook session-start` output (delta
  summary, operating guidance, and optional `llmdoc.config.json` preload)
  into top-level sessions for Git and non-Git workspaces that have llmdoc.
- PostInvocation: Mirrors Claude Code's non-blocking `Stop` reminder at the end
  of a top-level user turn using `metadata.user_markdown` (zero model tokens,
  preserves Prompt Cache, deduplicated per conversation state).

Fail-open: any unexpected error or non-llmdoc workspace emits `{}` and exits 0.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BRAIN_DIR = Path.home() / ".gemini" / "antigravity-cli" / "brain"


def emit_json(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.exit(0)


def emit_empty() -> None:
    sys.stdout.write("{}\n")
    sys.exit(0)


def state_dir() -> Path:
    plugin_data = (os.environ.get("PLUGIN_DATA") or "").strip()
    if plugin_data:
        return Path(plugin_data) / "stop-reminders"
    return Path.home() / ".cache" / "agy-llmdoc-hook" / "stop-reminders"


def prune_old_state(directory: Path, max_age_sec: int = 7 * 86400) -> None:
    if not directory.is_dir():
        return
    cutoff = time.time() - max_age_sec
    try:
        for entry in directory.iterdir():
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink(missing_ok=True)
    except Exception:
        pass


def state_file_for(conversation_id: str) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", conversation_id)
    return state_dir() / f"{safe_id}.sha256"


def read_last_hash(conversation_id: str) -> str:
    if not conversation_id:
        return ""
    p = state_file_for(conversation_id)
    if p.is_file():
        try:
            return p.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def write_last_hash(conversation_id: str, digest: str) -> None:
    if not conversation_id:
        return
    d = state_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
        target = state_file_for(conversation_id)
        if not digest:
            target.unlink(missing_ok=True)
            return
        fd, tmp_name = tempfile.mkstemp(prefix=".tmp-", dir=str(d))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fp:
                fp.write(digest + "\n")
            os.replace(tmp_name, target)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
    except Exception:
        pass


def default_transcript_path(conversation_id: str) -> Path | None:
    if not conversation_id:
        return None
    return BRAIN_DIR / conversation_id / ".system_generated" / "logs" / "transcript.jsonl"


def inspect_transcript(transcript_path: Path | None) -> dict[str, bool]:
    info = {
        "exists": False,
        "has_user_explicit": False,
        "found_planner": False,
        "last_planner_had_tool_calls": False,
    }
    if transcript_path is None or not transcript_path.is_file():
        return info

    info["exists"] = True
    try:
        size = transcript_path.stat().st_size
        if size <= 0:
            return info

        for window in (262144, 2097152):
            offset = max(0, size - window)
            with transcript_path.open("rb") as fp:
                fp.seek(offset)
                chunk = fp.read()
            lines = chunk.splitlines()
            if offset > 0 and lines:
                lines = lines[1:]

            found_planner = False
            has_user_explicit = False
            last_had_tools = False

            for raw_line in reversed(lines):
                if not raw_line:
                    continue
                if b'"USER_EXPLICIT"' in raw_line:
                    has_user_explicit = True
                if not found_planner and b'"PLANNER_RESPONSE"' in raw_line:
                    try:
                        obj = json.loads(raw_line.decode("utf-8", errors="replace"))
                    except Exception:
                        continue
                    if obj.get("type") == "PLANNER_RESPONSE":
                        found_planner = True
                        tool_calls = obj.get("tool_calls")
                        last_had_tools = bool(isinstance(tool_calls, list) and len(tool_calls) > 0)
                if found_planner and has_user_explicit:
                    break

            info["found_planner"] = found_planner
            info["last_planner_had_tool_calls"] = last_had_tools
            info["has_user_explicit"] = has_user_explicit
            if (found_planner and has_user_explicit) or offset == 0:
                break

            # If USER_EXPLICIT is near step 0 beyond the tail window, check the head once.
            if not info["has_user_explicit"]:
                with transcript_path.open("rb") as fp:
                    head_chunk = fp.read(65536)
                if b'"USER_EXPLICIT"' in head_chunk:
                    info["has_user_explicit"] = True
                    if found_planner:
                        break
    except Exception:
        pass

    return info


def _is_valid_llmdoc_dir_candidate(candidate_dir: str, start_dir: str, crossed_git: bool) -> bool:
    if not os.path.isdir(candidate_dir):
        return False
    norm_cand = os.path.abspath(candidate_dir)
    norm_start = os.path.abspath(start_dir)
    inside = norm_start == norm_cand or norm_start.startswith(norm_cand + os.sep)
    if not inside and not crossed_git:
        return True
    # Guard against a sibling or parent repository merely named `llmdoc`.
    if os.path.exists(os.path.join(norm_cand, ".git")):
        return False
    if os.path.isfile(os.path.join(norm_cand, "meta.json")):
        return True
    try:
        return any(name.endswith(".mdx") for name in os.listdir(norm_cand))
    except OSError:
        return False


def _walk_up_for_file(start_dir: str, filename: str) -> str | None:
    current = os.path.abspath(start_dir)
    while True:
        if os.path.isfile(os.path.join(current, filename)):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _walk_up_for_llmdoc_dir(start_dir: str) -> str | None:
    current = os.path.abspath(start_dir)
    crossed_git = False
    while True:
        candidate = os.path.join(current, "llmdoc")
        if _is_valid_llmdoc_dir_candidate(candidate, start_dir, crossed_git):
            return current
        if os.path.exists(os.path.join(current, ".git")):
            crossed_git = True
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def resolve_llmdoc_root(payload: dict[str, Any]) -> str | None:
    """Match CLI root discovery priority (never truncated by nested sub-repo `.git`):
      1. LLMDOC_ROOT env var
      2. Walk up from candidate dirs for `llmdoc.config.json` (crossing nested `.git`)
      3. Walk up from candidate dirs for `llmdoc/` (crossing nested `.git`)
      4. When LLMDOC_DOCS_DIR is explicitly set and exists: first valid candidate dir
    """
    env_root = (os.environ.get("LLMDOC_ROOT") or "").strip()
    if env_root:
        resolved = os.path.abspath(env_root)
        if os.path.isdir(resolved):
            return resolved
        return None

    candidates: list[str] = []
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd.strip():
        candidates.append(cwd.strip())
    workspaces = payload.get("workspacePaths")
    if isinstance(workspaces, list):
        for ws in workspaces:
            if isinstance(ws, str) and ws.strip():
                candidates.append(ws.strip())
    # Only fall back to hook process cwd when the host payload omitted both cwd and workspacePaths
    # (under agy, the hook process runs inside the plugin directory, not the user's workspace).
    if not candidates:
        try:
            candidates.append(os.getcwd())
        except Exception:
            pass

    normalized_candidates: list[str] = []
    seen: set[str] = set()
    for raw_dir in candidates:
        norm = os.path.abspath(raw_dir)
        if norm in seen or not os.path.isdir(norm):
            continue
        seen.add(norm)
        normalized_candidates.append(norm)

    for norm in normalized_candidates:
        config_root = _walk_up_for_file(norm, "llmdoc.config.json")
        if config_root:
            return config_root
        llmdoc_root = _walk_up_for_llmdoc_dir(norm)
        if llmdoc_root:
            return llmdoc_root

    env_docs = (os.environ.get("LLMDOC_DOCS_DIR") or "").strip()
    if env_docs and os.path.isdir(os.path.abspath(env_docs)) and normalized_candidates:
        return normalized_candidates[0]

    return None


def _is_executable(path_str: str) -> bool:
    try:
        return bool(path_str) and os.path.isfile(path_str) and os.access(path_str, os.X_OK)
    except OSError:
        return False


def resolve_llmdoc_cmd() -> list[str] | None:
    """Zero-latency local CLI resolution for this fork (never falls back to upstream npm):
      1. LLMDOC_BIN env var
      2. Bundled plugin launcher `<plugin_root>/bin/llmdoc`
      3. `llmdoc` on PATH
      4. `~/.local/bin/llmdoc` and `~/.local/share/npm/bin/llmdoc`
    Returns None when unavailable so hooks fail-open cleanly.
    """
    env_bin = (os.environ.get("LLMDOC_BIN") or "").strip()
    if env_bin and _is_executable(env_bin):
        return [env_bin]

    plugin_root = (os.environ.get("PLUGIN_ROOT") or "").strip()
    script_plugin_root = str(Path(__file__).resolve().parent.parent)
    candidates: list[str] = []
    for base in (plugin_root, script_plugin_root):
        if base:
            bundled = os.path.join(base, "bin", "llmdoc")
            if bundled not in candidates:
                candidates.append(bundled)

    which_bin = shutil.which("llmdoc")
    if which_bin and which_bin not in candidates:
        candidates.append(which_bin)

    for local_bin in (
        os.path.expanduser("~/.local/bin/llmdoc"),
        os.path.expanduser("~/.local/share/npm/bin/llmdoc"),
    ):
        if local_bin not in candidates:
            candidates.append(local_bin)

    for candidate in candidates:
        if _is_executable(candidate):
            return [candidate]

    return None


def run_llmdoc_hook(root: str, subcommand: str, raw_stdin: str, timeout_sec: int) -> str:
    resolved = resolve_llmdoc_cmd()
    if not resolved:
        return ""
    cmd = [*resolved, "hook", subcommand]
    env = os.environ.copy()
    env["NO_COLOR"] = "1"
    env["CI"] = "1"
    return subprocess.check_output(
        cmd,
        cwd=root,
        input=raw_stdin,
        stderr=subprocess.DEVNULL,
        timeout=timeout_sec,
        text=True,
        env=env,
    ).strip()


def format_stop_markdown(msg: str) -> str:
    formatted = re.sub(r"(/llmdoc:[a-z-]+(?:\s+--reflection)?)", r"`\1`", msg)
    formatted = re.sub(r"(?<!`)\b(llmdoc delta)\b(?!`)", r"`\1`", formatted)
    return f"💡 {formatted}"


def handle_session_start(payload: dict[str, Any], raw_stdin: str) -> None:
    conv_id = str(payload.get("conversationId") or "").strip()
    t_path_raw = str(payload.get("transcriptPath") or "").strip()
    t_path = Path(t_path_raw) if t_path_raw else default_transcript_path(conv_id)
    last_user_input = str(payload.get("lastUserInput") or "").strip()

    # Skip subagent sessions (SessionStart injects context only into top-level sessions).
    if conv_id and not last_user_input:
        t_info = inspect_transcript(t_path)
        if not t_info["has_user_explicit"]:
            emit_empty()

    prune_old_state(state_dir())

    root = resolve_llmdoc_root(payload)
    if not root:
        emit_empty()

    out = run_llmdoc_hook(root, "session-start", raw_stdin, timeout_sec=9)
    if not out:
        emit_empty()

    emit_json(
        {
            "injectSteps": [
                {
                    "systemMessage": {
                        "systemMessage": out,
                    }
                }
            ]
        }
    )


def handle_post_invocation(payload: dict[str, Any], raw_stdin: str) -> None:
    conv_id = str(payload.get("conversationId") or "").strip()
    t_path_raw = str(payload.get("transcriptPath") or "").strip()
    t_path = Path(t_path_raw) if t_path_raw else default_transcript_path(conv_id)
    last_user_input = str(payload.get("lastUserInput") or "").strip()

    # Fast-exit when user explicitly invoked an llmdoc maintenance skill this turn.
    if re.match(r"^/llmdoc:(update|init|prune|upgrade)\b", last_user_input):
        write_last_hash(conv_id, "")
        emit_empty()

    # Fast-exit (<1ms) for subagent turns and mid-turn tool-call steps.
    t_info = inspect_transcript(t_path)
    if not t_info["has_user_explicit"] or not t_info["found_planner"] or t_info["last_planner_had_tool_calls"]:
        emit_empty()

    root = resolve_llmdoc_root(payload)
    if not root:
        emit_empty()

    out = run_llmdoc_hook(root, "stop", raw_stdin, timeout_sec=7)
    if not out:
        emit_empty()

    parsed = json.loads(out)
    if not isinstance(parsed, dict):
        emit_empty()

    sys_msg = str(parsed.get("systemMessage") or "").strip()
    if not sys_msg or sys_msg.startswith("llmdoc hook degraded:"):
        write_last_hash(conv_id, "")
        emit_empty()

    digest = hashlib.sha256(sys_msg.encode("utf-8")).hexdigest()
    if conv_id and read_last_hash(conv_id) == digest:
        emit_empty()
    write_last_hash(conv_id, digest)

    emit_json(
        {
            "injectSteps": [
                {
                    "systemMessage": {
                        "systemMessage": "",
                        "metadata": {
                            "user_markdown": format_stop_markdown(sys_msg),
                        },
                    }
                }
            ]
        }
    )


def main() -> None:
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    raw_stdin = sys.stdin.read()
    payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
    if not isinstance(payload, dict):
        emit_empty()

    if event == "SessionStart":
        handle_session_start(payload, raw_stdin)
    elif event == "PostInvocation":
        handle_post_invocation(payload, raw_stdin)
    else:
        emit_empty()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        emit_empty()
