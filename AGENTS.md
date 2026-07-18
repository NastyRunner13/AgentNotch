# AgentNotch — Agent Notes

## Design Context

Strategic and visual design context for UI work lives at the project root:

- **[PRODUCT.md](./PRODUCT.md)** — Register (`product`), platform (`web` / Electron), users, positioning, personality (**Calm · Precise · Unobtrusive**), anti-references, design principles, accessibility.
- **[DESIGN.md](./DESIGN.md)** — Visual system: near-black tonal stack, status/agent colors, Inter + JetBrains Mono, notch shell, session cards, components. Frontmatter tokens are normative.
- **`.impeccable/design.json`** — Sidecar for motion, shadows, and component snippets (live panel).

When changing renderer UI (`src/renderer/`), read PRODUCT.md + DESIGN.md first and stay on-brand. Prefer `$impeccable critique`, `audit`, `polish`, or `craft` over inventing a new aesthetic.
