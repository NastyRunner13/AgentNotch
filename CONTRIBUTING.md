# Contributing to AgentNotch

Thank you for your interest in contributing to **AgentNotch**! AgentNotch is designed as a calm, precise, unobtrusive system-tray status bar for multi-agent AI developers.

We welcome bug reports, watcher improvements, new agent parsers, UI polish, and feature proposals.

---

## Code of Conduct

Please note that this project is governed by the [AgentNotch Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

---

## Project Principles & Design System

AgentNotch adheres strictly to three core principles:
1. **Calm & Unobtrusive**: The notch stays out of the developer's flow. It tucks away when inactive, never steals focus, and expands only on explicit user request.
2. **Precise & Local-First**: Status, metrics, token costs, and log parsing happen 100% locally on your machine. No telemetry or cloud proxies.
3. **High Aesthetic Standards**: Design matters. UI components must align with the visual system documented in [`DESIGN.md`](DESIGN.md) and [`PRODUCT.md`](PRODUCT.md).

Before modifying renderer UI files (`src/renderer/`), please read [`DESIGN.md`](DESIGN.md) and [`PRODUCT.md`](PRODUCT.md) to preserve the near-black tonal stack, status color semantics, and typography.

---

## Getting Started

### Prerequisites
- **Node.js**: `≥ 20.0.0`
- **npm**: Included with Node.js
- **Git**

### Local Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/AgentNotch.git
   cd AgentNotch
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run in development mode:
   ```bash
   npm run dev
   ```

4. Run the full test suite:
   ```bash
   npm test
   ```

---

## Architecture Overview

AgentNotch is built with **Electron + Vanilla CSS/JS** with zero heavy UI frameworks or bundlers to guarantee instant startup and low memory footprint.

- **`src/main/`**: Electron main process. Handles system tray integration, window positioning, file watching (via `chokidar`), IPC handlers, local SQLite/JSON log parsing, usage stats tracking (`usage-stats.js`), and Claude permission bridge installation.
- **`src/renderer/`**: Electron renderer process. Pure DOM + Vanilla CSS components for the notch bar, session cards, usage analytics dashboard (`usage-view.js`), and settings view.
- **`test/`**: Unit test suite using Node.js native test runner (`node --test`). Contains test fixtures and tests for all agent log scanners, cost calculators, and view state builders.

---

## Development & Testing Guidelines

### Adding or Updating Agent Watchers
- Place watcher parsers under `src/main/` (or dedicated analyzer utilities).
- Ensure file watching and polling handle missing files, corrupted logs, or read access locks gracefully without crashing the main process.
- Write unit tests under `test/` verifying log parsing, token extraction, timestamp ordering, and status mapping.

### UI & Styling Standards
- Style rules live in `src/renderer/styles/`.
- Use design tokens defined in [`DESIGN.md`](DESIGN.md) (e.g., CSS variables for background tones, agent status colors, fonts).
- Maintain responsive notch autohide behaviors and keyboard shortcuts (`Ctrl+Shift+A` / `⌘⇧A`, `Ctrl+Y`, `Ctrl+N`).

### Running & Writing Tests
We use Node.js's built-in test runner. All tests must pass before submitting a PR:

```bash
npm test
```

When creating new functionality, add corresponding `.test.js` files in the `test/` directory.

---

## Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

Format: `<type>(<scope>): <short summary>`

### Types
- `feat`: A new feature or watcher capability
- `fix`: A bug fix
- `docs`: Documentation updates
- `style`: Formatting or visual tweaks matching `DESIGN.md`
- `refactor`: Code restructuring without functional changes
- `test`: Adding or updating unit tests
- `chore`: Build scripts, dependencies, or workflow changes

### Examples
- `feat(watchers): add support for custom agent session log schema`
- `fix(usage): correctly deduplicate streamed message spans in Claude parser`
- `docs(readme): update setup commands for Linux distributions`

---

## Submitting a Pull Request

1. **Create a feature branch**:
   ```bash
   git checkout -b feat/my-new-feature
   ```
2. **Make your changes** following the project principles.
3. **Verify tests pass**:
   ```bash
   npm test
   ```
4. **Commit your changes**:
   ```bash
   git commit -m "feat(scope): concise description of changes"
   ```
5. **Push to your fork & submit a PR**:
   - Describe the problem solved or feature added.
   - Reference any related issues (`Fixes #12`).
   - Confirm all 146+ unit tests pass.

---

## Reporting Bugs & Requesting Features

- **Bug Reports**: Use our [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md). Please include your OS version, Node version, affected agent watcher, and any error logs.
- **Feature Requests**: Use our [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md) to discuss proposed features or new agent watcher support.

---

Thank you for building AgentNotch with us! 🚀
