# Changelog

All notable changes to **AgentNotch** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **History resume**: Search history by task / project / agent; pin important entries (never trimmed); Continue (headless resume or new session in project cwd) and Jump for archived sessions. Archive snapshots keep `resumeId` for Codex resume.
- **Usage limits glance**: Limits header on the Usage tab for all agents with local rate/credit data; critical limit chip on the collapsed notch (attention always wins); soft one-shot toast/desktop notify on crit crossing (never auto-opens the panel). Settings: show critical limit on notch, notify when critical.
- **Attention Control**: Per-event interrupt matrix (permission / question / needs-attention / done) for desktop notifications and sound, gated by master Sound and Notifications toggles. Defaults match 1.0 behavior (attention loud; done notify without sound).
- **Notch placement**: Choose display, left/center/right alignment, and autohide delay (2s / 4s / 8s / 15s).
- **Custom global hotkey**: Capture a new accelerator in Settings; Reset restores the platform default. Conflicts fall back gracefully with a toast.
- Shared `settings-defaults` + pure `attention-policy` module with unit tests (policy never auto-opens the panel).

---

## [1.0.0] - 2026-07-28

### Added
- **Ambient Notch UI**: Mac-style status bar at the top of the primary display with auto-tuck peek strip, manual pin control, autohide timing, and keyboard toggle (`Ctrl+Shift+A` / `⌘⇧A`).
- **Multi-Agent Watchers**: Real-time log & process watchers for 6 AI coding agents:
  - **Claude Code**: JSONL transcript parser for tool execution, user prompts, and completion states.
  - **Codex**: Rollout JSONL log analyzer for commands, prompts, and rate limits.
  - **Cursor**: Active process presence detection.
  - **Antigravity**: Transcript JSONL analyzer for planning phases and subagent tasks.
  - **Grok Build**: Log parser for active tools, command arguments, and weekly credit limits.
  - **OpenCode**: Read-only SQLite WAL database analyzer for tools, steps, and token spend.
- **Claude Remote Permission Approval**: Native `PermissionRequest` hook integration allowing users to approve (`Ctrl+Y`) or deny (`Ctrl+N`) Claude Code permission prompts directly from the notch interface.
- **Usage Analytics Dashboard**:
  - Historical log backfilling across Claude, Codex, Grok, and OpenCode.
  - Aggregated metrics across Today, 7D, 30D, and 90D timeframes.
  - Daily stacked burn chart (Tokens / Cost per agent).
  - Spending trajectory forecasting and token mix breakdown with cache-read percentages.
  - Derived statistics (cost per session, average session length, model cost share).
- **Session Dispatch**:
  - Direct message dispatch to running agent sessions without stealing focus or opening external windows.
  - Headless session launcher for agents in target project directories.
- **Local Settings & Archival**:
  - Watcher toggles, desktop banner notifications, and custom alert sounds.
  - Local session history archival (`~/.agent-notch/history.json`).
  - Persistent daily usage store (`~/.agent-notch/usage-stats.json`).
- **Developer & CI Infrastructure**:
  - Native Node.js test suite with 146 unit tests.
  - GitHub Actions CI workflow for Linux, macOS, and Windows on Node.js 20 & 22.
  - GitHub Actions automated release pipeline for `.exe`, `.dmg`, and `.AppImage` installers via `electron-builder`.
  - Open-source documentation suite (`CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, Issue & PR templates).
