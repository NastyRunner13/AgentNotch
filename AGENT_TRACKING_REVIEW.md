# Agent tracking review and product roadmap

Reviewed 2026-09-29 against commit `8268db1`, version 1.3.0.

Implementation progress: items 1, 2, and 4 are fixed in the working tree. Rules retain full paths and source homes; legacy basename-only rules are inactive. Codex, Claude, and Antigravity retain transcript state across appended batches, including metadata and cumulative Claude usage. The new reader also addresses item 6's truncation and replacement handling for those three watchers. Permission and question alerts use one deduplicated delivery path. Items 3, 5, and 7 and the proposed features remain pending.

Item 1 validation: all 15 permission-memory tests and 13 permission-bridge tests passed, followed by the full Node suite and isolated Electron renderer checks. The original cross-project reproduction now passes. A direct renderer check confirms the button uses the hook's project scope and is absent without that scope. The Electron check required execution outside the sandbox after its GPU process failed there.

Item 2 validation: 16 transcript tests cover large-file discovery and growth, metadata in the middle of files, cumulative usage and deduplication, appended-byte reads, bounded activity, partial UTF-8 writes, oversized records, missing final newlines, truncation, replacement, and cache cleanup. All 391 Node tests pass. The initial scan reads the full file once in chunks on the main thread; this change does not move parsing to a worker or establish a large-history latency benchmark. Grok and Cursor retain their existing readers.

Item 4 validation: six manager regression tests cover permission and question requests, orphan cards, repeated watcher updates, new request IDs, acknowledged episodes, and automatic approval. The focused attention and bridge checks pass, followed by all 397 Node tests. The duplicate direct emitter was removed; alerts use the existing 200 ms scheduled update.

The highest-value improvement is trustworthy session state. AgentNotch already has a useful attention queue, snoozing, project grouping, history, usage information, and a Claude permission bridge. Those features depend on distinguishing a completed turn from a new turn, a quiet process, and a broken connection.

## Scope and verification

Reviewed the six agent integrations, shared watcher, manager, permission matching, attention policy, session rendering, discovery, and focus behavior. Read PRODUCT.md and DESIGN.md. The review phase changed no application source; subsequent implementation progress is recorded above.

`npm test` passed all 366 tests, with no failures or skips, on Node 22.14.0 on Windows. Additional synthetic checks exercised the actual watcher/parser and manager methods and reproduced the seven cases below. Tests used temporary transcript files or in-memory objects; no live agent permission was granted. Temporary files were removed.

This is a source and behavior review, not an end-to-end certification against every installed agent version. The Electron UI, macOS/Linux behavior, and large-history CPU usage were not measured. Feature priorities are product hypotheses grounded in the app's stated users, not validated customer demand.

## Reproduced findings

### 1. P1: Always-allow rules cross project boundaries

Location: `src/main/permissions/permission-memory.js:41`, used by `src/main/agent-manager.js:798`.

`projectKey()` retains only the lowercased directory basename. A remembered Claude/Bash rule for `C:/work/client-a/app` also matches `C:/work/client-b/app`. The manager uses that match to submit an automatic allow decision. This is the first issue I would fix.

Reproduction: remember the first path and call `matches()` with the second. Expected `false`; actual `true`.

Use a canonical full project identity with an explicit source environment, including WSL distribution where relevant. Respect filesystem case semantics. Existing basename-only rules cannot be safely migrated to a unique path; require them to be re-established. Show the full scope when remembering a rule. Separately, make the UI explicit when a remembered rule permits every invocation of a tool, including Bash, in that project.

### 2. P1: Long transcripts erase session identity and context

Locations: `src/main/watchers/base-watcher.js:263` and `src/main/watchers/codex-watcher.js:106`.

Above 1,500,000 bytes, the reader reparses only the last 800,000 bytes. Codex reconstructs the session from that window and returns null or default fields when metadata is no longer present. The shared update then overwrites previously known values.

Reproduction: load a short Codex transcript with session ID, cwd, model, and prompt; append enough tool output to exceed the threshold. The next update changes cwd, native resume ID, and model to null. A fresh read of an already-large file has the same missing-head problem. Resume-ID fallback may still work for standard filenames, but the lost cwd can prevent dispatch and removes project context.

Preserve session metadata separately from recent activity. Parse the head on discovery, then consume appended complete records with a byte offset and retained partial line. Reset that parser when the file is replaced or truncated. Keep a bounded activity list without treating its window as the whole session.

Related inspection finding: Claude sums usage within the read window. A high-water mark prevents totals decreasing, but cannot recover newly used tokens while a rolling window remains below the previous cumulative maximum. Include accurate cumulative usage in the incremental-parser work.

### 3. P1: A new Grok turn can be overridden by an old completion

Fixed on 2026-09-29. The analyzers now retain explicit turn-boundary timestamps, and merging discards a completed source when the other source proves a later turn started. Regression coverage includes both file-write orders and manager completion delivery. Missing or tied boundary timestamps retain completion precedence rather than guessing from file modification time. The original finding follows for context.

Location: `src/main/watchers/grok/events.js:176`.

`mergeGrokStatus()` lets either source's idle/completed state win. When events.jsonl reports a new working turn before updates.jsonl advances from the previous completed turn, the merged session remains idle. This is a normal ordering possibility for two independently written files.

Reproduction: merge a working event state with `turnComplete: false` and a completed update state. Expected working; actual idle.

Carry turn identity and event order into both analyzers. Completion should end its own turn, not every later turn. If a source has no turn ID, use documented ordering evidence and retain uncertainty instead of applying unconditional completion precedence.

### 4. P2: One permission request emits attention twice

Locations: `src/main/agent-manager.js:491` and `src/main/agent-manager.js:576`.

`_onPendingPermissionsChanged()` emits attention immediately and schedules an update. `_detectStatusTransitions()` then sees the same previously unrecorded episode and emits it again. The main-process listener can deliver both notifications and alert sounds when those channels are enabled.

Reproduction: inject one pending request, invoke the pending-change handler, then run transition detection for the merged session. Expected one attention event; actual two.

Use one delivery path for attention episodes. Feed bridge observations through the same episode deduplication as transcript observations, retaining prompt delivery for orphan pending requests.

### 5. P2: Disabling a watcher leaves its sessions live

Locations: `src/main/watchers/base-watcher.js:33` and `src/main/agent-manager.js:738`.

`stop()` stops timers and closes file watching but retains the sessions map. `getSessions()` collects every watcher without checking whether monitoring is enabled. A disabled agent can therefore remain working and eventually receive a stall annotation.

Reproduction: seed a working session, stop its watcher, then read the manager feed. Expected no actively monitored session; actual one.

Define separate lifecycle operations for disabling monitoring and temporary suspension. Exclude disabled watchers from live aggregation and performance observation. Preserve history deliberately. A stopped poll that finishes late must not repopulate the active feed.

### 6. P2: Transcript truncation and same-size replacements are skipped

Locations: `src/main/watchers/codex-watcher.js:100`, `claude-watcher.js:112`, and the matching Antigravity code.

The size guard treats `stat.size <= lastSize` as unchanged. A rewritten file can contain new completion data but never be parsed until it grows past its previous size.

Reproduction: load a working Codex transcript, replace it with a shorter task-complete transcript, then process it again. Expected idle; actual working.

Track file identity and modification time alongside the byte offset. A smaller file must reset parsing; a same-size file with replacement evidence must be reread. Test append, partial append, truncate, and atomic replacement separately.

### 7. P2: A new Codex turn stays idle until assistant output arrives

Location: `src/main/watchers/codex-watcher.js:245`.

The user-message branch updates the prompt without updating status. There is no `task_started` branch. A session that previously completed stays idle during the initial wait for model output. An archived idle session can remain hidden through this interval.

Reproduction: analyze task-complete, new user-message, and task-started records in sequence. Expected working; actual idle.

Use an explicit turn-start signal where available. Distinguish a queued turn from active execution if the provider exposes both. Handle cancellation and failure explicitly too. Claude's user-message branch also updates text without setting a new active state; add provider-specific replay coverage rather than assuming all user records start a turn.

## Broader implementation improvements

### Separate activity, outcome, and observation health

Today the same status field carries execution state and user attention, while `isActive` has different meanings between providers. A quiet file does not establish whether the process is alive, blocked, disconnected, or finished. Most file integrations do not correlate sessions to individual processes.

Keep independent fields for execution state, terminal outcome, pending human action, source health, last event time, and observation time. Completion notifications should require a completion event for the current turn. File inactivity should lower confidence or indicate a quiet session without inventing a successful result.

Grok currently ages `needs-attention` into idle after its files go cold. The manager considers that transition eligible for a done notification. Preserve the failed outcome when removing an old session from the active list.

### Make source failures visible and recoverable

Several scans silently catch filesystem or schema failures. Some unreadable-directory paths are treated as an empty successful scan and remove sessions; other missing-root paths return early and leave stale sessions. Neither tells the user what failed. `getAgentDetection()` also hardcodes Cursor as detected.

Give each integration a health record: enabled, source found, last successful observation, event/poll mode, last error, and supported capabilities. A failed scan must not be mistaken for a confirmed empty source. Add retry/backoff, reconnection handling, and an error handler for the asynchronous file watcher. Reconcile after sleep or WSL reconnection.

### Reduce repeated work on Electron's main thread

File events currently trigger broad directory rescans. JSONL windows are synchronously reread, Cursor rereads composer/workspace data, and OpenCode reads all messages and parts for up to 50 recent sessions after a DB change. These are scaling risks, not measured performance regressions.

Use changed-file paths to update only affected sessions. Move heavy parsing/SQLite scans to a worker, bound concurrency, cache source indexes, and keep a slower discovery scan. Benchmark event-to-notch latency and CPU with large histories before choosing thresholds. Avoid overlapping event-triggered and scheduled polls.

### Test the whole observation pipeline

Keep the pure analyzer tests. Add fixtures that drive watcher, manager, and emitted events together. Cover the seven reproductions plus sleep/resume, transient unreadable directories, process exit, pending-request removal, replayed events, two source files advancing in either order, same-named projects, and provider schema changes. Use fixed clocks and temporary files.

## Features worth prioritizing

| Priority | Feature | User value and first scope |
| --- | --- | --- |
| Next | Tracking health and setup check | Explain whether an agent is connected, inferred from files, unavailable, or unsupported. Show last event age and a test-event/setup repair action. Put details in Settings and expose a quiet warning only when monitoring fails. |
| Next | Jump to the exact session | Open the terminal pane or editor conversation represented by the card. Windows focus currently remembers a window per agent name and otherwise selects a matching process, which cannot reliably identify one of several sessions. Store session-specific launch/window identity; use provider deep links where supported and disclose fallback behavior. |
| Next | More in-notch approvals | Extend the existing Claude workflow to a second provider with a supported response API. Show tool, project, scope, and request expiry. Start with approve-once and deny; add remembered rules only after scope identity is fixed. |
| Next | Useful completion receipts | A compact final outcome, linked changed files or diff, and reported test result with provenance. Distinguish turn ended, cancelled, failed, and tests passed. Do not infer success from a final message or idle state. |
| Later | Parent and subagent grouping | A parent task can show two workers running and one worker needing input. Collapse children by default and route attention to the specific child. Preserve separate session identities and avoid double-counting usage. |
| Later | Review multiple agents touching the same files | Warn only when observed edits overlap in the same checkout. Show the two tasks and affected files. Branch/worktree context already exists; detect real overlap before interrupting. |
| Later | Personal project budgets | Add user-defined daily/project limits to the existing usage view, with coverage and estimated-cost labels. Start with warnings, not automatic interruption. |
| Later | Local relay for remote work | Support explicitly connected SSH/dev-container sources through a small event relay. Retain source identity, authentication, and clear disconnect state. Reuse the event contract after local tracking is dependable. |

Project grouping, snooze, focus mode, history, usage analytics, and an attention queue already exist. Improve their accuracy and discoverability instead of presenting them as new roadmap items.

## Integration opportunities checked against current documentation

OpenCode documents server events, session status, child sessions, and permission responses. This makes it a practical candidate for the second approval integration. Connect to the server belonging to the user's active session; starting a separate server is not equivalent to attaching to an existing TUI. See the [OpenCode server documentation](https://opencode.ai/docs/server/).

Claude provides session and subagent lifecycle hooks. Extend the existing bridge to collect these signals, with transcript parsing as fallback. See the [Claude hooks reference](https://code.claude.com/docs/en/hooks).

Cursor documents session, tool, stop, and subagent hooks. A hook adapter can reduce dependence on private composer database fields. Confirm the supported hooks for the installed Cursor mode/version before advertising a capability. See the [Cursor hooks documentation](https://cursor.com/docs/hooks).

These documents establish technical opportunities, not evidence of customer demand. Validate the roadmap with developers running multiple agents. Ask them to replay a missed interruption, a wrong-session jump, and a confusing completion. Test whether the proposed feature resolves that incident.

## Suggested delivery order

1. Fix project permission scope, duplicate alerts, disabled-session handling, and the reproduced turn-state bugs. Add regression fixtures before each fix.
2. Implement incremental transcript reading and explicit observation health. Preserve identity, usage, and state across tailing, rewrites, and reconnection.
3. Ship exact-session navigation and a second supported approval adapter, followed by completion receipts.
4. Validate demand for subagent grouping, overlapping-edit warnings, budgets, and remote sources before expanding the UI.

Success criteria should include one notification per attention episode, no done notification without a terminal turn event, no cross-project remembered approval, preserved metadata after long sessions, and an explicit explanation when tracking cannot establish current state.
