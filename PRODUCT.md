# Product

## Register

product

## Platform

web

## Users

Solo AI-assisted developers who run one or more coding agents (Claude Code, Codex, Cursor, Antigravity, Grok Build) while they work. They are mid-task in an editor or terminal, attention split across tools, and they need glanceable status without abandoning flow.

Primary job: **never miss when an agent needs them** — permission requests, questions, finished turns, and other attention states — without alt-tabbing through every agent UI.

## Product Purpose

AgentNotch is a cross-platform system tray app that presents a Mac-style top notch for live multi-agent status. It watches local agent session files and process presence, surfaces working / idle / needs-attention states, and expands when something requires action. History, usage limits, settings, and optional task dispatch live in the expanded panel.

Success looks like: the developer trusts the notch to interrupt only when it matters, can identify which agent needs them in under a second, and otherwise keeps the surface quiet and out of the way.

## Positioning

The always-on multi-agent status bar — one glanceable notch for every agent’s state and attention needs, without opening each tool.

## Brand Personality

**Calm · Precise · Unobtrusive.** Voice is short, technical when useful, never promotional. The interface should feel like a quiet system companion: clear status, minimal chrome, only loud when something actually needs a human. Emotions: confidence that nothing important is missed, calm while agents run, urgency only for true attention states.

## Anti-references

- Chatty SaaS dashboards: big empty marketing chrome, metric-hero cards, “AI platform” bloat, and decorative card grids that do not help act now.
- Patterns that train ignore-behavior: constant badges, red-dot spam, and alert noise without a clear next action.

## Design Principles

1. **Interrupt only when it matters** — Autohide, expand-on-attention, and sound/notification are earned by real agent need; idle should feel almost invisible.
2. **Status before chrome** — Agent identity, state, and the next action outrank decorative layout. Density is fine when it is scannable.
3. **One surface, many agents** — Unified session feed beats per-agent silos; the notch is the single place to look.
4. **Local and private by design** — UI and copy never imply cloud surveillance; everything is on-machine files and process presence.
5. **Practice restraint** — Prefer fewer controls, quieter empty states, and precise labels over feature-showcasing panels.

## Accessibility & Inclusion

Target **WCAG 2.2 AA** for the renderer UI: text contrast, focus visibility, meaningful control labels, and operable keyboard paths for expand/collapse, tabs, session actions, and dispatch where the surface allows.

**Reduced motion** is required: honor `prefers-reduced-motion` for expand/collapse, icon animation, and entrance effects (crossfade or instant, not bounce or elastic). Support color-independent status cues (icon + text, not color alone) for working / attention / error states.
