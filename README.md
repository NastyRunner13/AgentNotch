<p align="center">
  <img src="assets/icons/agent-notch.png" alt="AgentNotch" width="120" />
</p>

<h1 align="center">AgentNotch</h1>

<p align="center">
  <strong>The quiet status strip for multi-agent developers.</strong><br/>
  <sub>One notch. Every agent. No tab-switching.</sub>
</p>

<p align="center">
  <a href="https://github.com/NastyRunner13/AgentNotch/actions/workflows/ci.yml"><img src="https://github.com/NastyRunner13/AgentNotch/actions/workflows/ci.yml/badge.svg" alt="CI Status"></a>
  <a href="https://github.com/NastyRunner13/AgentNotch/releases"><img src="https://img.shields.io/github/v/release/NastyRunner13/AgentNotch?color=%234ADE80&label=release" alt="Latest Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/NastyRunner13/AgentNotch/releases"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8a8a8a" alt="Platform"></a>
  <img src="https://img.shields.io/badge/electron-41-47848f" alt="Electron">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933" alt="Node">
</p>

<p align="center">
  <a href="#-supported-agents">Agents</a> · 
  <a href="#-features">Features</a> · 
  <a href="#%EF%B8%8F-quick-start">Quick Start</a> · 
  <a href="#-architecture">Architecture</a> · 
  <a href="#-production-builds">Builds</a> · 
  <a href="#-keyboard-shortcuts">Shortcuts</a> · 
  <a href="#-contributing">Contributing</a>
</p>

---

AgentNotch is a **cross-platform system-tray app** that presents a Mac-style notch at the top of your primary display. It watches local session files and process presence for your AI coding agents, distills them into glanceable status states — **idle**, **working**, **attention**, **error**, **question** — and keeps the full panel strictly on-demand.

> **Design philosophy:** *Calm · Precise · Unobtrusive.* The notch never pops open on its own. Sound and desktop notifications are earned by real agent need. The panel expands only when you ask.

## 🤖 Supported Agents

AgentNotch watches **6 AI coding agents** out of the box — all local, all private, zero cloud.

| Agent | Source Monitored | Detects |
| :--- | :--- | :--- |
| <img src="assets/icons/claude-code.png" width="16"/> **Claude Code** | `~/.claude/projects/**/*.jsonl` | Tool execution · user-input prompts · task completion |
| <img src="assets/icons/codex.png" width="16"/> **Codex** | `~/.codex/sessions/**/*.jsonl` | Command runs · prompt updates · rate limits |
| <img src="assets/icons/cursor.png" width="16"/> **Cursor** | Process presence + local composer DB (`%APPDATA%/Cursor` / `~/Library/Application Support/Cursor`) + optional `~/.cursor/projects/*/agent-transcripts` | Agent sessions · task names · working / done · project folder |
| <img src="assets/icons/antigravity.png" width="16"/> **Antigravity** | `~/.gemini/antigravity-ide/brain/**/transcript.jsonl` | Planning phases · subagent execution · task status |
| <img src="assets/icons/grok-build.png" width="16"/> **Grok Build** | `~/.grok/sessions/**/updates.jsonl` | Active tool names · command params · weekly credits |
| <img src="assets/icons/opencode.png" width="16"/> **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite WAL, read-only) | Tool execution · step completion · model + token/cost |

> **Note:** OpenCode does not persist live permission requests to disk. Sessions report working/idle and activity only — approvals happen inside the OpenCode app.

## ✨ Features

### Ambient Notch UI
A thin status bar at the top center of your screen. It tucks itself into a slim **peek strip** 4 seconds after you stop interacting — even while agents run — and slides back when an agent finishes or needs you. Hover or click the peek strip to bring it back, hit **↑** to tuck instantly, or **📌** to pin it permanently.

### On-Demand Panel
Expands only when *you* ask: click the bar, the tray icon, the global hotkey, or a desktop notification. Agent events never pop it open or steal focus.

### Glanceable Counts
The collapsed bar carries the whole story at a glance:

| Strip State | Meaning |
| :--- | :--- |
| `● N running` | Agents actively working |
| `✓ N done` | Runs completed |
| Amber status line | An agent needs your attention |

### Claude Remote Approve
Allow or Deny Claude Code `PermissionRequest` prompts directly from the notch — no need to switch to the Claude terminal. Other agents focus their native app for approval.

<details>
<summary><strong>Setup instructions</strong></summary>

1. Open AgentNotch → **Settings**
2. Under **Claude remote approve**, click **Install hook**
3. Restart any open Claude Code sessions (hooks load at session start)
4. When Claude needs permission, the bar turns amber and a notification fires — click to open the panel, then press **Allow** (<kbd>Ctrl</kbd>+<kbd>Y</kbd>) or **Deny** (<kbd>Ctrl</kbd>+<kbd>N</kbd>)

**What install does:**
- Copies the bridge script to `~/.agent-notch/bin/claude-permission-bridge.js`
- Adds a `PermissionRequest` command hook in `~/.claude/settings.json` (existing hooks preserved)
- Pending requests and decisions live under `~/.agent-notch/permissions/`
- If the hook times out (~10 min) or AgentNotch is not running, Claude falls back to its normal dialog
</details>

### Live Session Cards
See the running model (`Grok 4.5`, `Gemini 1.5 Pro`, etc.), a live activity feed of recent commands and edited files, and current execution parameters — all on the session card.

### Analytics

The Analytics tab contains Usage, Performance, and Insights, with shared Today / 7D / 30D / 90D and agent filters.

- **Usage:** Token and cost trends, agent/model breakdowns, token mix, and estimated active time. Charts support pointer inspection and arrow keys, Home, End, and Escape. A table exposes their values.
- **Cost sources:** Reported, estimated, mixed, partial, or unavailable. Missing pricing never becomes zero spending. Daily average replaces cost per session, whose denominator could repeat across models and days.
- **Performance:** Observed working time, waiting-for-user time, attention episodes, completions, and median working time per fully observed episode. A completion means a return to idle, not a verified successful task.
- **Insights:** Local heuristic conversation patterns, including sample size and confidence.

Usage history remains in `~/.agent-notch/usage-stats.json`. Performance aggregates are stored separately in `~/.agent-notch/performance-stats.json` for 90 days, starting when collection begins. Sleep, restart, and observation gaps are excluded. Settings can pause collection or clear performance data. Prompts and transcript content are not copied into this file. Previous-period usage comparisons remain unavailable without complete coverage metadata.

The UI bundles IBM Plex Sans and JetBrains Mono locally. Stable session cards retain focus, answers, scroll, and explicit collapse choices during updates. Each visible running card has one blue activity sweep; hidden cards and reduced-motion mode stop the loops.

### Session Dispatch
Message any running agent session directly from the expanded notch — pick a live session and the prompt resumes that exact chat headlessly (no new windows), or start a new headless session for an agent in its most recent project directory.

### Session navigation
Expand a session to see its available action. **Open session** links to the exact local Codex chat and requires the Codex desktop app to handle `codex://` links. **Resume session** opens an idle Claude, Codex, Grok, or OpenCode conversation in a new terminal without sending a prompt. Idle Codex chats also offer **Resume in terminal**. WSL sessions keep their distribution; Claude and Codex keep their configured data roots.

Cursor, Antigravity, and active CLI sessions offer **Open app**. This focuses the app; it cannot select the original terminal pane or conversation. **Copy session ID** is available when tracking supplies a resumable native ID. Terminal resume requires the agent CLI on PATH and PowerShell on Windows, Terminal on macOS, or `x-terminal-emulator` on Linux.

### Tracking health
Open **Settings → Tracking health → Check setup** to retry enabled sources and refresh Claude hook status. Each source shows its data path, last check, last activity, and any read error. Missing data points you to the agent path settings. Read failures keep the last observed sessions visible with a warning.

Checks read local session data and do not send an agent prompt. To verify new activity is reaching the notch, use your agent and check its last activity time here. An idle agent does not count as disconnected.

### Conversation Insights
Local classification of your sessions from the prompt, the tools, and the duration. There is no model call. It shows what kind of work you ran, which agent did it, and how long it took.

### Settings & History
Per-agent watcher toggles, **Attention Control** (when to sound / notify for permission, question, needs-attention, and done), **Notch** placement (display, left/center/right, autohide delay, custom global hotkey), autostart, and locally-archived session history.

## ⚡️ Quick Start

> **Prerequisites:** [Node.js](https://nodejs.org/) ≥ 20

```bash
# Clone the repository
git clone https://github.com/NastyRunner13/AgentNotch.git
cd AgentNotch

# Install dependencies
npm install

# Launch in development mode
npm run dev
```

Run the test suite:
```bash
npm test
npm run test:renderer # Isolated Electron checks with mock data
npm run audit:prod
```

## 📦 Production Builds

Build distributable packages with [electron-builder](https://github.com/electron-userland/electron-builder):

| Command | Platform | Output |
| :--- | :--- | :--- |
| `npm run build:win` | Windows | NSIS installer (`.exe`) |
| `npm run build:mac` | macOS | DMG and zip, x64 and arm64 |
| `npm run build:linux` | Linux | AppImage (`.AppImage`) |

Pushing to `main` builds all three installers and stores them as workflow artifacts ([installer workflow](.github/workflows/installers.yml)). Pushing a `v*` tag builds them again and opens a **draft** GitHub release ([release workflow](.github/workflows/release.yml)). The draft stays unpublished until you publish it. The in-app updater ignores drafts.

An installed app checks GitHub for a newer release and installs it on quit. Settings, Preferences, "Check for updates" turns that off. The check downloads the public release manifest only.

Windows and macOS builds sign when these repository secrets are set, and stay unsigned when they are not. Unsigned Windows builds still show SmartScreen. Unsigned macOS builds still need the Gatekeeper bypass.

| Secret | Use |
| :--- | :--- |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Authenticode certificate (base64 `.pfx` and its password) |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Developer ID Application certificate (base64 `.p12` and its password) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarize the signed macOS build |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarize with an App Store Connect API key instead of an Apple ID |

A lone `CSC_LINK` still works for a local build of the current platform. When both certificates are present, Windows is signed with `WIN_CSC_LINK` and macOS with `MAC_CSC_LINK`.

## 🏗 Architecture

**Electron + Chokidar + Vanilla CSS/JS.** No frameworks, no bundlers — fast startup, low memory.

```
agent-notch/
├── src/
│   ├── main/                          # Electron main process
│   │   ├── index.js                   # Entry point, window management, IPC
│   │   ├── agent-manager.js           # Multi-agent lifecycle orchestration
│   │   ├── tray.js                    # OS tray icon, status colors, context menu
│   │   ├── logger.js                  # Quiet, file-based logging
│   │   ├── watchers/                  # Agent-specific file/process watchers
│   │   ├── usage/                     # Token/cost stats, limits, backfill
│   │   ├── permissions/               # Claude PermissionRequest hook + memory
│   │   ├── insights/                  # Conversation insights engine
│   │   ├── session/                   # History, attention, git, feed helpers
│   │   ├── settings/                  # Defaults + electron-store
│   │   ├── security/                  # IPC / path / dispatch / navigation
│   │   └── lib/                       # Shared helpers (paths, prompts, toasts)
│   ├── preload/
│   │   └── index.js                   # contextBridge secure IPC
│   └── renderer/                      # UI (Notch, Panel, Settings)
│       ├── index.html                 # Shell HTML
│       ├── app.js                     # Renderer coordinator & IPC handlers
│       ├── components/
│       │   ├── session-card.js        #   Live session cards
│       │   ├── usage-view.js          #   Usage analytics dashboard
│       │   ├── insights-view.js       #   Conversation insights panel
│       │   ├── history-view.js        #   Session history browser
│       │   └── settings-panel.js      #   Settings & watcher toggles
│       └── styles/
│           ├── main.css               #   Design tokens & layout
│           └── components.css         #   Component styles
├── test/                              # Node.js native test runner
│   ├── analyzers.test.js              #   Agent log parser tests
│   ├── usage-stats.test.js            #   UsageTracker bucket/cost tests
│   ├── usage-backfill.test.js         #   History backfill tests
│   ├── usage-view.test.js             #   Usage view rendering tests
│   ├── insights.test.js               #   Insights engine tests
│   ├── insights-view.test.js          #   Insights view tests
│   ├── dispatch.test.js               #   Session dispatch tests
│   ├── permission-bridge.test.js      #   Permission bridge FS tests
│   └── markdown-table.test.js         #   Markdown table rendering tests
└── .github/workflows/
    ├── ci.yml                         # CI: Linux, macOS, Windows × Node 20, 22
    └── release.yml                    # Release: electron-builder → GitHub Releases
```

### Tech Stack

| Layer | Technology | Why |
| :--- | :--- | :--- |
| Runtime | Electron 41 | Cross-platform desktop, system tray, frameless window |
| File watching | Chokidar 4 | Efficient FS events for JSONL tailing |
| Persistence | electron-store | Simple JSON config, no external DB |
| UI | Vanilla JS + CSS | Zero-dependency renderer, instant startup |
| Testing | Node.js native `--test` | No test framework dependency |
| CI/CD | GitHub Actions | Matrix builds across 3 OS × 2 Node versions |
| Packaging | electron-builder | NSIS, DMG, AppImage outputs |

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd> | Toggle notch panel (customizable in **Settings → Notch**) |
| <kbd>Ctrl</kbd>+<kbd>Y</kbd> | Allow Claude permission request |
| <kbd>Ctrl</kbd>+<kbd>N</kbd> | Deny Claude permission request |

## 🔒 Privacy & Security

AgentNotch is **local-first and private by design.**

- ✅ **Zero telemetry** — no cloud dashboards, no accounts, no analytics, no remote fonts
- ✅ **Update check is the release manifest only** — a packaged app with the setting left on asks GitHub if a newer release exists. Session text, paths, and usage stay on the machine
- ✅ **Read-only inspection** — agent logs are parsed directly, never modified
- ✅ **On-device only** — settings and history never leave your machine (`~/.agent-notch/`)
- ✅ **Hardened Electron** — sandboxed renderer, contextBridge-only IPC, folder-only `openPath`, argv-safe dispatch

For responsible security disclosures, see [SECURITY.md](SECURITY.md).

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, development guidelines, and conventional commit rules.

All community interactions are governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## 📋 Project Documentation

| Document | Purpose |
| :--- | :--- |
| [DESIGN.md](DESIGN.md) | Visual design system — colors, typography, components |
| [PRODUCT.md](PRODUCT.md) | Product philosophy, users, positioning, accessibility |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup & contribution guidelines |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [SECURITY.md](SECURITY.md) | Security policy & vulnerability reporting |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |

## 📄 License

[MIT](LICENSE) © AgentNotch Maintainers
