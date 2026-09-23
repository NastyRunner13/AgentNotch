# AgentNotch — Agent Notes

## Active work

Release line is **1.3.0**. Signing, the updater, and draft releases are in `scripts/release-build.js`, `src/main/updates.js`, `electron-builder.yml`, and `.github/workflows/release.yml`. Installer builds on `main` are `.github/workflows/installers.yml`. `CHANGELOG.md` is the record of what shipped. In-notch approve is Claude Code only, through the permission hook. Extending that is the next product gap.

## Design Context

Strategic and visual design context for UI work lives at the project root:

- **[PRODUCT.md](./PRODUCT.md)** — Register (`product`), platform (`web` / Electron), users, positioning, personality (**Calm · Precise · Unobtrusive**), anti-references, design principles, accessibility.
- **[DESIGN.md](./DESIGN.md)** — Visual system: near-black tonal stack, status/agent colors, Inter + JetBrains Mono, notch shell, session cards, components. Frontmatter tokens are normative.
- **`.impeccable/design.json`** — Sidecar for motion, shadows, and component snippets (live panel).

When changing renderer UI (`src/renderer/`), read PRODUCT.md + DESIGN.md first and stay on-brand. Prefer `$impeccable critique`, `audit`, `polish`, or `craft` over inventing a new aesthetic.
