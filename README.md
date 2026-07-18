# AgentNotch

> **Calm · Precise · Unobtrusive** — The ambient multi-agent status strip for solo AI-assisted developers.

AgentNotch is a cross-platform system tray application that displays a Mac-style top notch UI for real-time status updates of local AI coding agents. It watches local session files and process presence, surfaces status states (idle, working, attention, error, question) in a glanceable strip, and expands automatically when an agent requires your input.

---

## Supported Agents

| Agent | Watched Path / Source | State Detections |
| :--- | :--- | :--- |
| **Claude Code** | `~/.claude/projects/**` (session `.jsonl`) | Tool execution, user input prompt, task completion |
| **Codex** | `~/.codex/sessions/**` (session `.jsonl`) | Command runs, prompt updates, rate limits |
| **Cursor** | Process presence (`Cursor.exe` / `Cursor`) | Running / active state |
| **Antigravity** | `~/.gemini/antigravity-ide/brain/**/transcript.jsonl` | Planning phases, subagent execution, task status |
| **Grok Build** | `~/.grok/sessions/**/updates.jsonl` | Active tool names, command parameters, weekly credits |

---

## Key Features

- 🟢 **Ambient Notch UI:** A thin status notch at the top center of your primary screen. It remains visible while any agent is working or requires attention, and autohides when all agents are idle.
- ⚡ **Auto-Expand on Attention:** Automatically expands the notch whenever an agent requests permission, asks a question, or completes a turn, so you never miss a blocker.
- ✅ **Claude remote approve:** Allow / Deny from the notch for Claude Code via a `PermissionRequest` hook (install once in Settings). Other agents still focus the app so you can approve there.
- 🎛️ **Live Session Cards:** Hover or click to expand cards showing the active running model (e.g. `Grok 4.5`, `Gemini 1.5 Pro`), a live activity feed of recent commands/files edited, and active execution parameters.
- 📊 **Usage Limits:** Displays real-time, local-only metric strips for resource usage (such as Grok weekly credits or Codex usage %) directly in the top bar.
- 📥 **CLI Task Dispatch:** Submit tasks directly to agent CLIs from the expanded notch input field.
- ⚙️ **Local Settings & History:** Manage per-agent watchers, notification sounds, desktop banners, and autostart settings. Session history is archived locally under `~/.agent-notch/history.json`.

---

## Claude remote approve setup

1. Open AgentNotch → **Settings**.
2. Under **Claude remote approve**, click **Install hook**.
3. Restart any open Claude Code sessions (hooks load at session start).
4. When Claude needs permission, the notch expands — press **Allow** (`Ctrl+Y`) or **Deny** (`Ctrl+N`). Claude continues without switching windows.

What install does:

- Copies the bridge script to `~/.agent-notch/bin/claude-permission-bridge.js`
- Adds a `PermissionRequest` command hook in `~/.claude/settings.json` (other hooks are preserved)
- Pending requests and decisions live under `~/.agent-notch/permissions/`

If the hook times out (~10 minutes) or AgentNotch is not running, Claude falls back to its normal permission dialog.

---

## Visual Design System

AgentNotch is designed with a dark, premium, and focused aesthetic to prevent notification fatigue and look beautiful. Detailed visual specifications are located in [DESIGN.md](file:///c:/Users/princ/OneDrive/Desktop/AI%20Agents/agent-notch/DESIGN.md).

- **Colors:** Restrained, near-black tonal stack (`#0a0a0a` to `#1c1c1c`) to stay out of the way. Vibrant colors are reserved strictly for semantic states (Working: Blue, Attention: Amber, Idle: Green, Question: Cyan).
- **Typography:** Modern sans-serif (Inter) for controls and UI, and monospaced (JetBrains Mono) for code snippets, running models, and terminal output paths.
- **Motion:** Micro-animations (breathing pulse when working, alert bounce when attention is needed). Honors `prefers-reduced-motion` settings.

---

## Technical Stack & Architecture

AgentNotch is built with **Electron**, **Chokidar** (high-performance file system watcher), and **Vanilla CSS/JS** for visual speed and a lightweight memory footprint.

```
agent-notch/
├── .agents/               # Customization hooks
├── assets/                # Application icons and assets
├── test/                  # Test suite (Node.js test runner)
│   └── analyzers.test.js  # Agent log parser unit tests
└── src/
    ├── main/              # Main process (Tray, Window, Agent Manager)
    │   ├── watchers/      # Agent-specific file watchers and log tailers
    │   │   ├── base-watcher.js        # Base abstract watcher class
    │   │   ├── antigravity-watcher.js # Antigravity logs parser
    │   │   ├── claude-watcher.js      # Claude Code session parser
    │   │   ├── codex-watcher.js       # Codex log parser
    │   │   ├── cursor-watcher.js      # Cursor process tracker
    │   │   ├── grok-watcher.js        # Grok session updates tailer
    │   │   └── session-utils.js       # JSONL stream helpers
    │   ├── index.js             # Main Electron entrance point
    │   ├── logger.js            # Quiet, file-based logging utility
    │   ├── permission-bridge.js # Claude PermissionRequest hook + decision files
    │   ├── store.js             # Settings and session state persistence
    │   ├── tray.js              # OS tray status colors & context menu
    │   └── usage-limits.js      # Local resource tracker
    ├── preload/           # contextBridge secure IPC bridge
    │   └── index.js
    └── renderer/          # User Interface (Notch, Expanded Panel, Settings)
        ├── index.html     # Frame markup
        ├── app.js         # Renderer coordination & IPC handler
        ├── components/    # UI elements (Header, History, SessionCards, Settings)
        └── styles/        # Near-black CSS theme (main.css, components.css)
```

---

## Installation & Setup

Ensure you have [Node.js](https://nodejs.org/) (version 18 or higher) installed.

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Run in development mode:**
   ```bash
   npm run dev
   ```

3. **Run the parser test suite:**
   ```bash
   npm test
   ```

---

## Production Builds

Build target packages using [electron-builder](https://github.com/electron-userland/electron-builder):

| Target OS | Command | Output |
| :--- | :--- | :--- |
| Windows | `npm run build:win` | NSIS Installer (`.exe`) |
| macOS | `npm run build:mac` | Disk Image (`.dmg`) |
| Linux | `npm run build:linux` | AppImage (`.AppImage`) |

---

## Local Privacy Commitments

AgentNotch is **local-first and private by design**:
- No cloud dashboards, no accounts, and no remote telemetry.
- It parses local session logs directly in the watcher thread.
- Settings and historical metrics never leave your machine (`~/.agent-notch/`).

---

## License

This project is licensed under the [MIT License](LICENSE).
