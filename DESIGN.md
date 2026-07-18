---
name: AgentNotch
description: Quiet multi-agent status strip — dark, dense, interrupt-only UI for solo AI-assisted developers.
colors:
  bg-notch: "#0a0a0a"
  bg-panel: "#0d0d0d"
  bg-card: "#151515"
  bg-card-hover: "#1c1c1c"
  bg-input: "#1a1a1a"
  border-subtle: "#1e1e1e"
  border-light: "#2a2a2a"
  border-accent: "#333333"
  text-primary: "#f0f0f0"
  text-secondary: "#8a8a8a"
  text-tertiary: "#666666"
  text-inverse: "#000000"
  status-idle: "#4ADE80"
  status-idle-bright: "#86EFAC"
  status-working: "#60A5FA"
  status-working-bright: "#93C5FD"
  status-attention: "#F59E0B"
  status-attention-bright: "#FCD34D"
  status-error: "#EF4444"
  status-question: "#06B6D4"
  status-question-bright: "#22D3EE"
  agent-claude: "#D97757"
  agent-codex: "#10B981"
  agent-cursor: "#06B6D4"
  agent-antigravity: "#4285F4"
  agent-grok: "#EF4444"
typography:
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  mono:
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  eyebrow:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  notch: "0 0 20px 20px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  session-card:
    backgroundColor: "{colors.bg-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  session-card-hover:
    backgroundColor: "{colors.bg-card-hover}"
  button-allow:
    backgroundColor: "#0a1a0a"
    textColor: "{colors.status-idle}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
  button-deny:
    backgroundColor: "#1a0a0a"
    textColor: "{colors.status-error}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
  button-jump:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
  button-dispatch:
    backgroundColor: "rgba(96, 165, 250, 0.15)"
    textColor: "{colors.status-working}"
    rounded: "{rounded.sm}"
    size: "28px"
  input-dispatch:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  chip-usage:
    backgroundColor: "rgba(255, 255, 255, 0.04)"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "3px 8px"
  tab-nav:
    backgroundColor: "transparent"
    textColor: "{colors.text-tertiary}"
    padding: "8px 10px"
  tab-nav-active:
    textColor: "{colors.text-primary}"
  toggle-on:
    backgroundColor: "#0a2a0a"
    textColor: "{colors.status-idle}"
    rounded: "{rounded.full}"
    height: "18px"
    width: "34px"
---

# Design System: AgentNotch

## 1. Overview

**Creative North Star: "The Quiet Signal Strip"**

AgentNotch is a thin, near-black system strip that lives at the top of the display. It is not a dashboard, not a marketing surface, and not a second IDE. It is an ambient status channel for solo developers running multiple AI coding agents — glanceable when idle, decisive when something needs a human.

The aesthetic is **Calm · Precise · Unobtrusive**. Surfaces stack as tonal near-blacks; chroma is reserved for status (working, idle, attention, error, question) and agent identity. Type is small, Inter for UI and JetBrains Mono for numbers, models, paths, and tool names. Motion is short and purposeful: breathe while working, pulse when attention is required, then get out of the way. Empty and idle states stay quiet.

This system explicitly rejects **chatty SaaS dashboards** (metric-hero cards, decorative card grids, “AI platform” bloat) and **patterns that train ignore-behavior** (constant badges, red-dot spam, alert noise without a clear next action). Color and animation are earned by real agent state.

**Key Characteristics:**
- Near-black tonal stack, hairline borders, almost no ambient shadow
- Status and agent color only where state must be read in under a second
- Dense, scannable session cards — not identical marketing tiles
- Signature shell: 40px collapsed bar, bottom-rounded notch (`0 0 20px 20px`)
- Refined and restrained controls; allow/deny and dispatch are the only “loud” moments

## 2. Colors

A restrained dark product palette: neutral ink for structure, semantic status for meaning, per-agent brand hues for identity only.

### Primary
- **Working Blue** (`#60A5FA`): Live “agent is doing work” cue — status dots, status text, dispatch affordances, tool chips. The operational accent when nothing is wrong.

### Secondary (status system)
- **Idle Green** (`#4ADE80`): Healthy idle / done / allow. Also toggle-on knob.
- **Attention Amber** (`#F59E0B`): Permission, needs-attention, session badge — the interrupt color. Rarity is the point.
- **Question Cyan** (`#06B6D4`): Agent is asking a question; pairs with question blocks, not with idle chrome.
- **Error Red** (`#EF4444`): Deny, destructive clear, critical usage — reserved for failure or refusal.

### Tertiary (agent identity)
- **Claude Clay** (`#D97757`), **Codex Emerald** (`#10B981`), **Cursor Cyan** (`#06B6D4`), **Antigravity Blue** (`#4285F4`), **Grok Red** (`#EF4444`): Agent tags and dots only. Never recolor the whole shell with these.

### Neutral
- **Void Notch** (`#0a0a0a`): Outer shell / dispatch bar background.
- **Panel Ink** (`#0d0d0d`): Expanded panel depth step.
- **Card Charcoal** (`#151515`): Session cards, history rows, setting hover.
- **Card Lift** (`#1c1c1c`): Card hover surface.
- **Input Graphite** (`#1a1a1a`): Inputs, selects, tag fills.
- **Hairline** (`#1e1e1e` / `#2a2a2a` / `#333333`): Borders from subtle → light → accent.
- **Ink Primary** (`#f0f0f0`): Primary labels and names.
- **Ink Secondary** (`#8a8a8a`): Status lines, secondary labels — keep ≥4.5:1 on void when used as body.
- **Ink Tertiary** (`#555555`): Meta, timestamps, eyebrows — never for long body copy.

### Named Rules
**The Earned Color Rule.** Status and agent hues appear only on state, identity tags, or the action that state demands. Decorative fills, gradient washes, and rainbow chrome are prohibited.

**The Interrupt Amber Rule.** Attention amber is scarce. If everything is amber, nothing is. Prefer quiet idle green/blue until a real needs-attention or permission state.

## 3. Typography

**Display Font:** Not used — this product has no hero display type.
**Body Font:** Inter (system UI fallbacks)
**Label/Mono Font:** JetBrains Mono (Cascadia Code / Fira Code fallbacks)

**Character:** Technical product density. Inter carries readable UI at 11–13px; mono owns duration, model ids, tool names, paths, and usage percentages so the eye separates “facts” from “prose.”

### Hierarchy
- **Title** (600, 13px, -0.01em): Session names, primary row labels.
- **Body** (400–500, 13px, 1.5): Status lines, prompts, activity (clamp long text).
- **Label** (500, 11px): Tabs, secondary UI, dispatch input.
- **Mono** (500–600, 9–10px): Stats, model tags, tools, timestamps, kbd hints.
- **Eyebrow** (600, 10px, 0.08em, uppercase): Settings headings, history date groups, prompt labels — sparingly, not on every section.

### Named Rules
**The No-Hero-Type Rule.** There is no 48px marketing headline in this product. Maximum type scale stays in the compact UI band (≤15px for primary UI text).

**The Mono-Means-Data Rule.** Use mono only for machine-readable or time-bound data. Do not set body prose in mono.

## 4. Elevation

Depth is **tonal layering, almost no shadow**. Surfaces step Void → Panel → Card → Lift; 1px hairline borders define edges. Soft drop shadows are not part of the resting language.

Attention may use a soft pulse ring (`box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2)` on a cycle) only on attention-state cards. Plan-step “in progress” may use a tiny working-blue glow ring. Neither is ambient decoration.

### Shadow Vocabulary
- **Attention pulse** (`0 0 0 2px rgba(245, 158, 11, 0.2)` animated): Session cards in attention state only.
- **Plan progress ring** (`0 0 0 3px rgba(96, 165, 250, 0.12)`): In-progress plan markers only.
- **Ambient / card drop shadows:** Forbidden at rest.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Glow appears only as a response to real agent attention or in-progress plan state.

## 5. Components

Feel: **refined and restrained** — tight radii, muted fills, color only for status and agent identity.

### Buttons
- **Shape:** Gently curved (`6px` / `radius-sm`)
- **Allow:** Green-tinted dark fill (`#0a1a0a`), idle green text, border `#102a10`
- **Deny:** Red-tinted dark fill (`#1a0a0a`), error text, border `#2a1010`
- **Jump / ghost:** Transparent, light border, secondary text → primary on hover
- **Dispatch send:** 28×28, working-blue translucent fill (`rgba(96,165,250,0.15)`), scale feedback on press
- **Hover / Focus:** Fast 0.12s ease; focus borders use working blue, not generic browser outlines when styled

### Chips
- **Usage chips:** Full pill, translucent white 4% fill, hairline border, mono percentage
- **Agent tags:** Small radius-sm pills, agent hue text + darkened matching border
- **Model tags:** Mono, muted translucent fill
- **Tool chips:** Tiny mono (9px), working-blue on deep blue fill (`#0d1a2a`)

### Cards / Containers
- **Corner Style:** Medium (`10px`) for session cards; smaller (`6px`) for history rows
- **Background:** Card charcoal; hover lifts to `#1c1c1c`
- **Shadow Strategy:** Flat-by-default; attention pulse only when status demands
- **Border:** Subtle `#1e1e1e`, lightens on hover; attention cards use warm border `#3d2a00`
- **Internal Padding:** Header `10px 12px`; detail stack with `space-sm` gaps

### Inputs / Fields
- **Style:** Transparent or graphite fill, hairline border, `6px` radius, 11–13px type
- **Focus:** Working-blue border; slight white 2% fill on dispatch input
- **Select (agent):** Mono, graphite, same focus language

### Navigation
- **Tabs:** Text + icon, tertiary by default, primary + 2px white underline when active
- **Collapsed bar:** 40px height, icon cluster left, status center, mono stats + chevron right
- **Settings gear:** Icon tab pinned right (`ntab-icon`)

### Signature: Notch shell
- Collapsed **40px** bar; expanded fills the Electron window
- Bottom corners **20px** (`radius-notch`); no top border (sits under screen edge)
- Outer border `1px solid rgba(255,255,255,0.04)` without top edge
- Autohide is window geometry + opacity — do not fake hide by collapsing content height abruptly

### Toggles
- 34×18 track, full pill; off = `#222` / knob `#666`; on = green-tinted track + idle green knob

## 6. Do's and Don'ts

### Do:
- **Do** keep the shell near-black and let status color carry meaning (working blue, idle green, attention amber).
- **Do** pair every status color with text and/or icon so state is not color-only (PRODUCT accessibility).
- **Do** prefer tonal surface steps and 1px hairlines over drop shadows.
- **Do** use mono for durations, models, tools, paths, and usage % only.
- **Do** honor `prefers-reduced-motion`: replace breathe/shake/spin/pulse with static or simple opacity.
- **Do** keep empty states quiet — short title + one-line desc, no hero marketing empty illustrations.
- **Do** treat attention expansion and sound as earned by real agent need.

### Don't:
- **Don't** build **chatty SaaS dashboards**: big empty marketing chrome, metric-hero cards, “AI platform” bloat, or decorative card grids that do not help act now.
- **Don't** use **patterns that train ignore-behavior**: constant badges, red-dot spam, and alert noise without a clear next action.
- **Don't** use gradient text, glassmorphism as default decoration, or wide soft card shadows with 1px borders as a “premium” recipe.
- **Don't** put a colored side-stripe (`border-left` > 1px) on every card as scaffolding (plan inset is a rare, intentional exception for nested plan lists only — do not generalize).
- **Don't** recolor the whole notch with agent brand colors; agent hues stay on tags/dots.
- **Don't** ship hero display type, cream/sand marketing backgrounds, or light-mode SaaS defaults in this product surface.
- **Don't** animate layout for decoration; window geometry owns expand/collapse size.
