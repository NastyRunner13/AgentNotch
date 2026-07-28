# Security Policy

## Privacy & Security Philosophy

**AgentNotch** is engineered as a **100% local-first** desktop status application.

- **Zero External Telemetry**: AgentNotch does not transmit telemetry, analytics, session contents, prompt text, or token counts to any cloud servers or third parties.
- **Local File Inspection**: AgentNotch reads agent log files and SQLite WAL databases directly from your local user directory (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.grok/`, `~/.local/share/opencode/`). Log inspection is read-only.
- **Claude Remote Approval**: The optional Claude permission bridge writes pending permission state and responses strictly to local disk IPC directories (`~/.agent-notch/permissions/`).

---

## Supported Versions

Only the latest release version receives security updates.

| Version | Supported |
| :--- | :--- |
| 1.0.x | Yes |
| < 1.0 | No |

---

## Reporting a Vulnerability

If you discover a potential security vulnerability in AgentNotch, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Send an email describing the issue, potential impact, and reproduction steps to the maintainer via GitHub profile contact options or open a private vulnerability disclosure on the repository.
3. You will receive an acknowledgment within **48 hours**.
4. We will work with you to investigate, develop a patch, and publish a security advisory and patched release.

Thank you for keeping AgentNotch and its community safe!
