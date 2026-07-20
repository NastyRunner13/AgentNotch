<p align="center">
  <strong>AgentNotch</strong>
</p>

<p align="center">
  <em>The quiet status strip for multi-agent developers.</em>
</p>

<p align="center">
  <a href="#supported-agents">Agents</a> ·
  <a href="#features">Features</a> ·
  <a href="#getting-started">Get Started</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="DESIGN.md">Design System</a>
</p>

---

AgentNotch is a cross-platform system-tray application that surfaces a Mac-style notch at the top of your primary display. It watches local session files and process presence for your AI coding agents, distills them into glanceable status states — **idle**, **working**, **attention**, **error**, **question** — and expands only when something actually needs a human.

One strip. Every agent. No tab-switching.

## Supported Agents

| Agent | Source | What it detects |
| :--- | :--- | :--- |
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | Tool execution, user-input prompts, task completion |
| **Codex** | `~/.codex/sessions/**/*.jsonl` | Command runs, prompt updates, rate limits |
| **Cursor** | Process presence (`Cursor.exe` / `Cursor`) | Running / active state |
| **Antigravity** | `~/.gemini/antigravity-ide/brain/**/transcript.jsonl` | Planning phases, subagent execution, task status |
| **Grok Build** | `~/.grok/sessions/**/updates.jsonl` | Active tool names, command parameters, weekly credits |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite WAL, read-only) | Tool execution, step completion, model + token/cost usage |

> **Note:** OpenCode does not persist live permission requests to disk. Sessions report working/idle and activity only — approvals happen inside the OpenCode app.

## Features

**Ambient Notch UI** — A thin status bar at the top center of your screen. Visible while any agent is working or needs attention; autohides when everything is idle.

**Auto-Expand on Attention** — The notch expands automatically whenever an agent requests permission, asks a question, or completes a turn. You never miss a blocker.

**Claude Remote Approve** — Allow or Deny Claude Code permission requests directly from the notch via a `PermissionRequest` hook. Other agents focus their native app for approval.

**Live Session Cards** — Hover or click to see the running model (`Grok 4.5`, `Gemini 1.5 Pro`, etc.), a live activity feed of recent commands and edited files, and current execution parameters.

**Usage Limits** — Real-time, local-only metric strips for resource usage (Grok weekly credits, Codex usage %) displayed inline.

**CLI Task Dispatch** — Submit tasks to agent CLIs directly from the expanded notch input field.

**Settings & History** — Per-agent watcher toggles, notification sounds, desktop banners, autostart, and locally-archived session history under `~/.agent-notch/history.json`.

## Claude Remote Approve Setup

1. Open AgentNotch → **Settings**.
2. Under **Claude remote approve**, click **Install hook**.
3. Restart any open Claude Code sessions (hooks load at session start).
4. When Claude needs permission, the notch expands — press **Allow** (`Ctrl+Y`) or **Deny** (`Ctrl+N`).

<details>
<summary>What install does</summary>

- Copies the bridge script to `~/.agent-notch/bin/claude-permission-bridge.js`
- Adds a `PermissionRequest` command hook in `~/.claude/settings.json` (existing hooks are preserved)
- Pending requests and decisions live under `~/.agent-notch/permissions/`
- If the hook times out (~10 min) or AgentNotch is not running, Claude falls back to its normal permission dialog.

</details>

## Getting Started

> Requires [Node.js](https://nodejs.org/) ≥ 20.

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run the parser test suite
npm test
```

## Production Builds

Build target packages with [electron-builder](https://github.com/electron-userland/electron-builder):

```bash
npm run build:win     # Windows → NSIS installer (.exe)
npm run build:mac     # macOS   → Disk image (.dmg)
npm run build:linux   # Linux   → AppImage (.AppImage)
```

## Architecture

Electron + Chokidar + Vanilla CSS/JS. No frameworks, no bundlers — fast startup, low memory.

```
src/
├── main/                   # Main process
│   ├── index.js            # Electron entry point
│   ├── tray.js             # OS tray status colors & context menu
│   ├── store.js            # Settings & session state persistence
│   ├── logger.js           # Quiet, file-based logging
│   ├── permission-bridge.js # Claude PermissionRequest hook + decision files
│   ├── usage-limits.js     # Local resource tracker
│   └── watchers/           # Agent-specific file watchers
│       ├── base-watcher.js          # Abstract watcher base class
│       ├── claude-watcher.js        # Claude Code session parser
│       ├── codex-watcher.js         # Codex log parser
│       ├── cursor-watcher.js        # Cursor process tracker
│       ├── antigravity-watcher.js   # Antigravity transcript parser
│       ├── grok-watcher.js          # Grok session updates tailer
│       ├── opencode-watcher.js      # OpenCode SQLite (WAL) reader
│       └── session-utils.js         # JSONL stream helpers
├── preload/
│   └── index.js            # contextBridge secure IPC
└── renderer/               # UI (Notch, Expanded Panel, Settings)
    ├── index.html
    ├── app.js              # Renderer coordination & IPC handler
    ├── components/         # Session cards, history, settings
    └── styles/             # Near-black CSS theme

test/
├── analyzers.test.js              # Agent log parser unit tests
└── permission-bridge.test.js      # Permission bridge filesystem tests
```

## Design

Dark, dense, interrupt-only. Near-black tonal stack (`#0a0a0a` → `#1c1c1c`), status color earned by real agent state, Inter + JetBrains Mono typography. Full specification in [DESIGN.md](DESIGN.md).

## Privacy

AgentNotch is **local-first and private by design**.

- No cloud dashboards, no accounts, no telemetry.
- Session logs are parsed directly in the watcher thread.
- Settings and history never leave your machine (`~/.agent-notch/`).

## License

[MIT](LICENSE)
