# AgentNotch — Product Roadmap

Strategic roadmap from product analysis: features users will most want, and settings customization worth shipping. Grounded in `PRODUCT.md`, `DESIGN.md`, and the live codebase.

**Last updated:** 2026-08-01  
**Personality:** Calm · Precise · Unobtrusive  
**Core job:** Never miss when an agent needs you — without alt-tabbing every tool.

---

## Product snapshot

AgentNotch is a **local-first Electron tray app**: a Mac-style top notch that watches **six AI coding agents** (Claude Code, Codex, Cursor, Antigravity, Grok Build, OpenCode) via files/process presence.

| Surface | Job |
|--------|-----|
| Collapsed notch | Glance: N running / N done / amber attention / optional crit limit |
| Expanded panel | Sessions, History, Usage, Insights, Settings |
| Interrupts | Sound + desktop notifications (policy-gated; panel never auto-opens) |
| Act | Claude remote Allow/Deny; Jump; Snooze; Session dispatch; History continue |
| Analytics | Usage (tokens/cost/limits) + Conversation Insights (local) |

**Constraints that never change:**
1. Interrupt only when it matters — no badge spam.
2. Status before chrome — mute channels, not truth on the bar.
3. Panel expands only on user action (bar, tray, hotkey, notification click).
4. Local and private by design.
5. Practice restraint — fewer controls, dense Settings, no SaaS bloat.

---

## Shipped foundation

| Area | Status |
|------|--------|
| Ambient notch + autohide + pin | Done |
| Multi-agent watchers (6 agents) | Done |
| Claude remote approve | Done |
| Session cards, Jump, Snooze, Dismiss | Done |
| Session dispatch (live + new) | Done |
| Usage dashboard + Insights | Done |
| Attention Control (event × channel matrix) | Done |
| Focus mode + per-agent mute | Done |
| Notch placement (display, align, autohide, hotkey) | Done |
| History search, pin, Continue / Jump | Done |
| Usage limits glance (header chips, notch crit, soft alert) | Done |
| Settings: agent toggles, attention, notch, startup, Claude hook, limit toggles | Done |

---

## Features users will most want

Ranked by **job impact** for solo multi-agent developers.

### Tier A — Highest desire (protects or completes the core job)

#### 1. Act without leaving the notch (beyond Claude) — **open**
Claude remote approve is the standout differentiator. Other agents still force Jump → native UI.

Possible slices:
- Remote or faster approve/deny where hooks/APIs exist
- Unified **attention queue**: “N things need you” → act / jump / dismiss in order
- Deeper **Cursor** signal (today is process-only)

#### 2. Focus mode / Quiet hours — **shipped** (schedule later)
Attention Control is granular but not situational. Deep work needs one switch: bar still truthful, sound/toast off.

- Global Focus toggle (Settings + tray menu) — **shipped**
- Quiet “focus” chip on collapsed bar — **shipped**
- Optional schedule later (e.g. 9–12) — not a full calendar product — **open**

#### 3. Per-agent mute — **shipped**
Session snooze exists; chronically noisy agents need **mute this agent’s alerts** while status stays on the bar.

```text
mutedAgents: []  // e.g. 'cursor', 'opencode' — mute sound + toast only
```

Settings → Mute alerts; policy wires through `attention-policy.js`.

#### 4. Stronger multi-agent attention command center — **open**
When 2+ sessions need human input:
- Clear priority on the strip and list
- Keyboard path to next attention item
- Optional “dismiss this attention” without losing the session

---

### Tier B — High value polish (daily stickiness)

#### 5. Smarter session feed density — **open**
- Compact vs comfortable cards
- Auto-collapse finished sessions
- Toggle which fields show by default (model, cwd, activity)
- Filter/group by agent or project folder

#### 6. Better Jump & project context — **open**
- Open project folder / copy cwd
- Remember last-focused agent window per OS
- Clearer labels when multiple sessions share the same agent

#### 7. Dispatch reliability & discoverability — **partial**
Dispatch exists for Claude/Codex/Grok/OpenCode. Still useful:
- Clearer feedback when a prompt landed
- Optional default agent/project for “new session”

#### 8. Usage limits as “can I keep going?” — **shipped**
- Limit chips on Usage header (all agents with local data)
- Crit chip on collapsed notch (attention always wins)
- Soft one-shot toast/notify on crit crossing
- Settings: show on notch, notify when critical

#### 9. History that helps resume work — **shipped**
- Search by task / project / agent / prompt
- Pin important finished sessions
- Continue / re-dispatch / Jump from history

---

### Tier C — Nice-to-have / platform / a11y

#### 10. Appearance knobs (not themes) — **open**
On-brand only: motion full/reduced/off, high-contrast status, quieter idle strip.  
**Avoid:** light mode marketplace, skins, decorative themes.

#### 11. Multi-monitor robustness — **partial**
Display picker ships; real-world pain is display ID drift — “always primary” / “follow cursor display” still open.

#### 12. More agents / better coverage — **later**
Windsurf, Aider, Continue, Gemini CLI, etc. only after action layer and noise control feel excellent for the six already supported.

#### 13. Insights that stay actionable — **partial**
Keep Insights sparse and local — answer *what slowed me down / which agent thrashing*, not SaaS analytics bloat.

---

### Explicitly low demand / avoid

| Idea | Why avoid |
|------|-----------|
| Auto-expand panel on attention | Violates product law; trains interruption fatigue |
| Constant red badges / unread dots | Trains ignore-behavior |
| Theme packs / light-mode party | Off-brand, low job impact |
| Custom WAV alert libraries | `shell.beep` + OS notify is enough |
| Another big analytics dashboard | Usage + Insights already cover it |
| Cloud sync / accounts | Contradicts local-private positioning |

---

## Settings customization for the client

### A. Attention (extend existing) — highest ROI

| Setting | Status | Notes |
|---------|--------|--------|
| Event × channel matrix | **Shipped** | permission / question / needs-attention / done |
| Master sound + notifications | **Shipped** | |
| Focus mode | **Shipped** | Suppress sound + toast; bar truth stays; tray + Settings |
| Focus schedule | Open (later) | Optional daily window |
| Per-agent mute | **Shipped** | Mute sound/toast only (`mutedAgents`) |
| Reveal bar on attention / done | Internal | Expose if users ask |
| Snooze defaults | Open | Optional default preset |

Wire all interrupt delivery through `attention-policy.js`.

### B. Notch & shell

| Setting | Status | Notes |
|---------|--------|--------|
| Display, align, autohide, hotkey | **Shipped** | |
| Pin on bar | **Shipped** | |
| Start pinned | Open | Persist preference at launch |
| Follow active display | Open | Alternative to fixed display id |
| Crit limit on notch | **Shipped** | `showLimitOnNotch` |

### C. Sessions appearance (density, not themes)

| Setting | Status | Notes |
|---------|--------|--------|
| Card density | Open | Compact / comfortable |
| Field visibility | Open | Model / cwd / activity |
| Auto-collapse idle | Open | Reduces list noise |
| Group by agent | Open | Optional |
| Motion intensity | Open | Full / reduced / off |
| High-contrast status | Open | Accessibility |

### D. Agents (beyond enable toggles)

| Setting | Status | Notes |
|---------|--------|--------|
| Per-agent enable | **Shipped** | |
| Agent order / attention priority | Open | |
| Custom data paths | Open (advanced) | Non-default installs |
| Hooks for other agents | Open | When remote-approve expands |

### E. Dispatch & actions

| Setting | Status | Notes |
|---------|--------|--------|
| Default dispatch agent | Open | For “new session” |
| Confirm before dispatch | Open | Optional |
| Default project cwd | Open | Last used / per-agent |

### F. Notifications & privacy

| Setting | Status | Notes |
|---------|--------|--------|
| Notify on limit crit | **Shipped** | Soft, never auto-opens panel |
| Clear history / usage data | Partial | Clear history exists |
| Export usage JSON | Open | Power users |
| Open data folder (`~/.agent-notch`) | Open | Transparency, support |

### G. Advanced (collapsed by default)

| Setting | Status | Notes |
|---------|--------|--------|
| Poll interval | Internal | Expose only if users ask |
| Log level / open logs | Open | Support |
| Reset settings to defaults | Open | One button |

### H. Do not add to Settings

- Full theme editor / accent pickers for every token  
- Decorative skins  
- Social/cloud accounts  
- Per-event custom sounds library  
- Analytics product toggles that turn the app into a dashboard  

---

## Suggested sequencing

| Order | Bet | Rationale |
|------|-----|-----------|
| 1 | ~~**Focus mode** + **per-agent mute**~~ | **Shipped** — noise control |
| 2 | **Action layer beyond Claude** + attention queue | Largest differentiator |
| 3 | **Density / auto-collapse** | Drive-by when touching session cards |
| 4 | **Appearance knobs** | Only if a11y / motion demand appears |
| 5 | Expose reveal-on-done / start-pinned | Small Settings rows when convenient |
| — | New agents / heavy analytics | After action + noise feel excellent |

### Recently completed (this cycle)

1. ~~History search + pin + Continue~~  
2. ~~Usage limits glance (header, notch crit, soft alert, settings)~~  
3. ~~Focus mode (Settings + tray; bar chip; policy mute sound/toast)~~  
4. ~~Per-agent mute (`mutedAgents` in Settings; policy)~~  

---

## Implementation guardrails

1. New settings keys → `settings-defaults.js` (whitelist + electron-store stay in sync).  
2. Interrupts → `attention-policy.js` (pure + unit-tested).  
3. Mute channels, never mute **truth** on the bar.  
4. Panel expands only on user action.  
5. Read `PRODUCT.md` + `DESIGN.md` before any Settings or renderer UI work.  

---

## North star

If a feature or setting does not help:

> *See agent need in under a second, interrupt only when earned, act without chaos*

…it is probably off-brand for AgentNotch.

---

## Related docs

| Document | Purpose |
|----------|---------|
| [PRODUCT.md](./PRODUCT.md) | Users, positioning, principles |
| [DESIGN.md](./DESIGN.md) | Visual system (normative tokens) |
| [CHANGELOG.md](./CHANGELOG.md) | What shipped in each release |
| [README.md](./README.md) | Features, setup, architecture |
