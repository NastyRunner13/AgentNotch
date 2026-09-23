# Security Policy

## Privacy & Security Philosophy

**AgentNotch** is engineered as a **100% local-first** desktop status application.

- **Zero External Telemetry**: AgentNotch does not transmit telemetry, analytics, session contents, prompt text, or token counts to any cloud servers or third parties. The renderer does not load fonts, scripts, or analytics from the network. A packaged app with update checks left on requests the public GitHub release manifest and the installer. That request carries no session text, paths, prompts, or usage. Settings can turn the check off.
- **Local File Inspection**: AgentNotch reads agent log files and SQLite WAL databases directly from your local user directory (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.grok/`, `~/.local/share/opencode/`). Log inspection is read-only.
- **Claude Remote Approval**: The optional Claude permission bridge writes pending permission state and responses strictly to local disk IPC directories (`~/.agent-notch/permissions/`).

## Hardening (what ships)

| Control | Behavior |
| :--- | :--- |
| Electron renderer | `contextIsolation`, no Node integration, Chromium sandbox, `webSecurity` |
| Navigation | Foreign `will-navigate` / `will-redirect` / `window.open` / `<webview>` are denied |
| Permissions | Renderer cannot obtain camera, mic, geolocation, or downloads |
| IPC | Invokes must come from the notch window; session / history / agent ids are validated |
| Open folder | `shell.openPath` only accepts existing directories — never files (`.exe`, `.lnk`, `.cmd`) |
| Dispatch | Prompt is a single argv element. Windows `.cmd` shims resolve to `node` + the JS entry so user text does not cross `cmd.exe`. WSL uses `wsl.exe --` argv, not a shell string |
| Settings | Unknown keys rejected; poll interval, hotkey, WSL distro, and custom roots are sanitized |
| Content-Security-Policy | `default-src 'none'` plus local script/style/font/img only |
| Packaged app | Electron fuses disable `ELECTRON_RUN_AS_NODE` and Node CLI inspect; ASAR integrity is on. Extra `file://` privileges stay on so the notch can load local icons and fonts |
| Local data | History, logs, permission files, and settings are written with owner-only modes (honored on POSIX; Windows uses the user profile ACL) |

## Residual risk (accepted)

- **Same-user local attacker**: anything that can write `~/.agent-notch/permissions/decisions/` as you can approve a Claude hook. The protocol is local-file IPC by design.
- **PATH hijack**: dispatch locates `claude` / `codex` / `grok` / `opencode` on `PATH`. A malicious sibling executable with the same name would run as you.
- **Untrusted session logs**: prompt text and cwd come from agent transcripts. They are escaped in the UI; they are never evaluated as HTML or as a shell string.
- **Code signing**: the release workflow signs Windows when `WIN_CSC_LINK` is set and signs plus notarizes macOS when `MAC_CSC_LINK` and Apple notarization credentials are set. Until those secrets exist, release binaries are unsigned. Unsigned Windows builds show SmartScreen. Unsigned macOS builds are blocked by Gatekeeper until the user bypasses it.

Run `npm run audit:prod` to check production dependencies. CI fails on high+ production advisories.

---

## Supported Versions

Only the latest release version receives security updates.

| Version | Supported |
| :--- | :--- |
| 1.3.x | Yes |
| < 1.3 | No |

---

## Reporting a Vulnerability

If you discover a potential security vulnerability in AgentNotch, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Send an email describing the issue, potential impact, and reproduction steps to the maintainer via GitHub profile contact options or open a private vulnerability disclosure on the repository.
3. You will receive an acknowledgment within **48 hours**.
4. We will work with you to investigate, develop a patch, and publish a security advisory and patched release.

Thank you for keeping AgentNotch and its community safe!
