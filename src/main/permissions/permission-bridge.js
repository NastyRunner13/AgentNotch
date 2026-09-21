/**
 * Claude Code remote-approval bridge.
 *
 * Claude's PermissionRequest hook runs this script, which writes a pending
 * request under ~/.agent-notch/permissions/ and waits for AgentNotch to write
 * a decision file. The hook then returns allow/deny so Claude continues without
 * switching windows.
 *
 * Protocol:
 *   pending/<id>.json   — hook is waiting
 *   decisions/<id>.json — AgentNotch wrote allow|deny
 *
 * CLI: node permission-bridge.js   (stdin = Claude hook JSON)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOOK_MARKER = 'claude-permission-bridge.js';
const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_NOTCH_PERMISSION_TIMEOUT_MS) || 600_000;
const POLL_MS = Number(process.env.AGENT_NOTCH_PERMISSION_POLL_MS) || 250;

// ── Paths ──────────────────────────────────────────────

function agentNotchHome() {
  return path.join(os.homedir(), '.agent-notch');
}

/** Extra AgentNotch homes (e.g. `\\wsl$\Ubuntu\home\ada\.agent-notch`). Hook process ignores these. */
let extraAgentNotchHomes = [];

function setExtraAgentNotchHomes(homes) {
  extraAgentNotchHomes = Array.isArray(homes)
    ? homes.map((h) => String(h || '').trim()).filter(Boolean)
    : [];
}

function allAgentNotchHomes() {
  const seen = new Set();
  const out = [];
  for (const home of [agentNotchHome(), ...extraAgentNotchHomes]) {
    const key = home.replace(/\//g, '\\').toLowerCase();
    if (!home || seen.has(key)) continue;
    seen.add(key);
    out.push(home);
  }
  return out;
}

function permissionsRoot(home = agentNotchHome()) {
  return path.join(home, 'permissions');
}

function pendingDir(home = agentNotchHome()) {
  return path.join(permissionsRoot(home), 'pending');
}

function decisionsDir(home = agentNotchHome()) {
  return path.join(permissionsRoot(home), 'decisions');
}

function bridgeInstallPath(home = agentNotchHome()) {
  return path.join(home, 'bin', HOOK_MARKER);
}

function ensureHomeDirs(home = agentNotchHome()) {
  for (const dir of [pendingDir(home), decisionsDir(home), path.dirname(bridgeInstallPath(home))]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* Windows may ignore */ }
    } catch {
      // Extra WSL homes may be offline
    }
  }
}

function ensureDirs() {
  for (const home of allAgentNotchHomes()) {
    ensureHomeDirs(home);
  }
}

// ── Session id helpers ─────────────────────────────────

/**
 * Map Claude hook session_id / transcript path → AgentNotch session id.
 * AgentNotch uses `claude-<jsonl-basename>` for Claude sessions.
 */
function toNotchSessionId(claudeSessionId, transcriptPath) {
  let raw = '';
  if (transcriptPath) {
    raw = path.basename(String(transcriptPath), '.jsonl');
  }
  if (!raw && claudeSessionId) {
    raw = String(claudeSessionId).replace(/\.jsonl$/i, '');
  }
  if (!raw) return null;
  return raw.startsWith('claude-') ? raw : `claude-${raw}`;
}

/** `claude-wsl-<uuid>` and `claude-<uuid>` are the same Claude session. */
function canonicalClaudeSessionId(id) {
  return String(id || '').replace(/^claude-wsl-/i, 'claude-');
}

function sessionIdsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return canonicalClaudeSessionId(a) === canonicalClaudeSessionId(b);
}

const MAX_TOOL_INPUT_CHARS = 32_768;

function clampToolInput(input) {
  if (!input || typeof input !== 'object') return {};
  try {
    if (JSON.stringify(input).length <= MAX_TOOL_INPUT_CHARS) return input;
  } catch {
    return {};
  }
  return { _truncated: true, file_path: extractFilePath(input) };
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return (
    toolInput.file_path ||
    toolInput.filePath ||
    toolInput.path ||
    toolInput.notebook_path ||
    ''
  );
}

// ── Pending / decision I/O ─────────────────────────────

function pendingPath(id, home = agentNotchHome()) {
  validateRequestId(id);
  return path.join(pendingDir(home), `${id}.json`);
}

function decisionPath(id, home = agentNotchHome()) {
  validateRequestId(id);
  return path.join(decisionsDir(home), `${id}.json`);
}

/**
 * Reject ids that don't look like UUIDs — path-traversal defence.
 * @param {string} id
 */
function validateRequestId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid permission request id: ${String(id).slice(0, 64)}`);
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function assertNotSymlink(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error('Refusing to write through symlink');
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  assertNotSymlink(filePath);
  const tmp = `${filePath}.${process.pid}.tmp`;
  // mode 0o600 — owner read/write only; pending/decision files may contain tool input / secrets
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows may ignore */ }
}

function removeQuiet(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * List open pending permission requests (newest first).
 * @returns {Array<object>}
 */
function listPending() {
  ensureDirs();
  const items = [];
  const seen = new Set();
  for (const home of allAgentNotchHomes()) {
    let files;
    try {
      files = fs.readdirSync(pendingDir(home)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const data = readJsonSafe(path.join(pendingDir(home), file));
      if (!data || !data.id || data.status === 'resolved' || seen.has(data.id)) continue;
      seen.add(data.id);
      items.push({ ...data, _home: home });
    }
  }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return items;
}

/**
 * Find the newest pending request for an AgentNotch session id.
 * Also accepts synthetic ids `claude-pending-<requestId>`.
 */
function pendingKind(pending) {
  return pending && pending.kind === 'question' ? 'question' : 'permission';
}

function findPendingForSession(notchSessionId) {
  if (!notchSessionId) return null;
  const all = listPending().filter((p) => pendingKind(p) === 'permission');
  const direct = all.find((p) => sessionIdsMatch(p.notchSessionId, notchSessionId));
  if (direct) return direct;

  const pendingPrefix = 'claude-pending-';
  if (String(notchSessionId).startsWith(pendingPrefix)) {
    const requestId = String(notchSessionId).slice(pendingPrefix.length);
    return all.find((p) => p.id === requestId) || null;
  }
  return null;
}

/**
 * Create a pending request from Claude PermissionRequest hook input.
 */
function createPendingFromHookInput(input) {
  ensureDirs();
  const id = crypto.randomUUID();
  const claudeSessionId = input.session_id || input.sessionId || '';
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  const toolName = String(input.tool_name || input.toolName || 'tool').slice(0, 120);
  const toolInput = clampToolInput(input.tool_input || input.toolInput || {});
  const notchSessionId = toNotchSessionId(claudeSessionId, transcriptPath);

  const pending = {
    id,
    kind: 'permission',
    claudeSessionId,
    notchSessionId,
    transcriptPath,
    cwd: input.cwd || '',
    tool: toolName,
    toolInput,
    filePath: extractFilePath(toolInput),
    permissionMode: input.permission_mode || input.permissionMode || '',
    createdAt: Date.now(),
    status: 'pending'
  };

  writeJsonAtomic(pendingPath(id), pending);
  return pending;
}

/**
 * Write an allow/deny decision for a pending request.
 * @param {string} requestId
 * @param {'allow'|'deny'} decision
 * @param {string} [source]
 */
function findPendingRecord(requestId) {
  if (!requestId) return null;
  try { validateRequestId(requestId); } catch { return null; }
  for (const home of allAgentNotchHomes()) {
    const data = readJsonSafe(pendingPath(requestId, home));
    if (data && data.id) return { pending: data, home };
  }
  return null;
}

function submitDecision(requestId, decision, source = 'agent-notch') {
  if (!requestId) {
    return { success: false, message: 'Missing request id' };
  }
  const normalized = decision === 'deny' ? 'deny' : 'allow';
  const found = findPendingRecord(requestId);
  if (!found) {
    return { success: false, message: 'No pending permission request for this id' };
  }
  if (pendingKind(found.pending) === 'question') {
    return { success: false, message: 'This prompt needs an answer, not allow/deny' };
  }

  writeJsonAtomic(decisionPath(requestId, found.home), {
    id: requestId,
    decision: normalized,
    decidedAt: Date.now(),
    source
  });

  return {
    success: true,
    remote: true,
    decision: normalized,
    requestId,
    message: normalized === 'allow' ? 'Approved from AgentNotch' : 'Denied from AgentNotch'
  };
}

/**
 * Resolve by AgentNotch session id (newest pending).
 */
function submitDecisionForSession(notchSessionId, decision) {
  const pending = findPendingForSession(notchSessionId);
  if (!pending) {
    return { success: false, message: 'No remote permission request pending for this session' };
  }
  return submitDecision(pending.id, decision);
}

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const MAX_ANSWER_CHARS = 500;

function clip(value, max) {
  return String(value || '').trim().slice(0, max);
}

/**
 * Claude AskUserQuestion input → notch form. Drops questions with no text.
 * @param {object} toolInput
 */
function normalizeQuestions(toolInput) {
  const raw = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const questions = [];
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== 'object') continue;
    const question = clip(q.question || q.prompt, 500);
    if (!question) continue;
    const options = [];
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    for (const opt of rawOpts.slice(0, 8)) {
      if (typeof opt === 'string') {
        const label = clip(opt, 160);
        if (label) options.push({ label, description: '' });
        continue;
      }
      if (!opt || typeof opt !== 'object') continue;
      const label = clip(opt.label || opt.value, 160);
      if (!label) continue;
      options.push({ label, description: clip(opt.description, 240) });
    }
    questions.push({
      id: String(questions.length),
      header: clip(q.header, 40),
      question,
      multiSelect: Boolean(q.multiSelect),
      options
    });
  }
  return questions;
}

function extractPlanText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const direct = toolInput.plan || toolInput.planText || toolInput.plan_markdown;
  return typeof direct === 'string' ? direct.trim().slice(0, 12000) : '';
}

/**
 * Pending record for a Claude question or plan-approval hook.
 * Returns null when AskUserQuestion has no usable questions — caller should
 * let Claude show its own dialog instead of blocking on an empty card.
 */
function createQuestionFromHookInput(input) {
  const toolName = String(input.tool_name || input.toolName || '').slice(0, 120);
  if (!QUESTION_TOOLS.has(toolName)) return null;
  const rawInput = input.tool_input || input.toolInput || {};
  const questions = toolName === 'AskUserQuestion' ? normalizeQuestions(rawInput) : [];
  if (toolName === 'AskUserQuestion' && questions.length === 0) return null;

  ensureDirs();
  const id = crypto.randomUUID();
  const claudeSessionId = input.session_id || input.sessionId || '';
  const transcriptPath = input.transcript_path || input.transcriptPath || '';
  const pending = {
    id,
    kind: 'question',
    questionKind: toolName === 'ExitPlanMode' ? 'plan' : 'ask',
    claudeSessionId,
    notchSessionId: toNotchSessionId(claudeSessionId, transcriptPath),
    transcriptPath,
    cwd: input.cwd || '',
    tool: toolName,
    toolInput: clampToolInput(rawInput),
    questions,
    plan: toolName === 'ExitPlanMode' ? extractPlanText(rawInput) : '',
    createdAt: Date.now(),
    status: 'pending'
  };
  writeJsonAtomic(pendingPath(id), pending);
  return pending;
}

function matchAnswer(question, given) {
  const text = clip(given, MAX_ANSWER_CHARS);
  if (!text) return { ok: false, message: 'Answer every question before sending' };
  const labels = (question.options || []).map((o) => o.label);
  if (question.multiSelect) {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    const known = parts.length > 0 && parts.every((p) => labels.includes(p));
    // A value that isn't a list of known labels is the Other field, commas included.
    if (!known) return { ok: true, value: text };
    return { ok: true, value: parts.join(', ') };
  }
  return { ok: true, value: text };
}

/**
 * @param {object} payload — `{ answers, deny, note, legacy }`
 */
function buildAnswers(pending, payload) {
  if (pending.questionKind === 'plan') return { ok: true, answers: {} };
  const questions = pending.questions || [];
  if (questions.length === 0) return { ok: false, message: 'Question has no choices' };

  const body = payload && typeof payload === 'object' ? payload : {};
  const legacy = typeof body.legacy === 'string' ? body.legacy.trim() : '';
  const raw = body.answers;
  const answers = {};

  if (legacy && questions.length === 1 && (!raw || typeof raw !== 'object')) {
    const checked = matchAnswer(questions[0], legacy);
    if (!checked.ok) return checked;
    answers[questions[0].question] = checked.value;
    return { ok: true, answers };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Answer every question before sending' };
  }
  for (const q of questions) {
    const given = raw[q.question] != null ? raw[q.question] : raw[q.id];
    const checked = matchAnswer(q, given);
    if (!checked.ok) return checked;
    answers[q.question] = checked.value;
  }
  return { ok: true, answers };
}

function submitQuestionDecision(requestId, payload) {
  if (!requestId) return { success: false, message: 'Missing request id' };
  const found = findPendingRecord(requestId);
  if (!found || pendingKind(found.pending) !== 'question') {
    return { success: false, message: 'No question waiting for this session' };
  }

  const deny = Boolean(payload && payload.deny);
  let answers = {};
  let note = '';
  if (deny) {
    note = clip(payload && payload.note, MAX_ANSWER_CHARS);
  } else {
    const built = buildAnswers(found.pending, payload);
    if (!built.ok) return { success: false, message: built.message };
    answers = built.answers;
  }

  const decision = deny ? 'deny' : 'allow';
  writeJsonAtomic(decisionPath(requestId, found.home), {
    id: requestId,
    decision,
    answers,
    note,
    decidedAt: Date.now(),
    source: 'agent-notch'
  });

  return {
    success: true,
    remote: true,
    decision,
    requestId,
    message: deny ? 'Declined from AgentNotch' : 'Answered from AgentNotch'
  };
}

function pendingToQuestion(pending) {
  const questions = Array.isArray(pending.questions) ? pending.questions : [];
  const first = questions[0];
  const plan = pending.questionKind === 'plan';
  return {
    requestId: pending.id,
    remote: true,
    kind: plan ? 'plan' : 'ask',
    text: plan ? 'Approve this plan?' : (first && first.question) || 'Question',
    questions,
    plan: pending.plan || '',
    options: questions.length === 1
      ? (first.options || []).map((o) => ({ label: o.label, description: o.description || '', value: o.label }))
      : []
  };
}

function buildHookResponse(decision) {
  const behavior = decision === 'deny' ? 'deny' : 'allow';
  const body = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior
      }
    }
  };
  if (behavior === 'deny') {
    body.hookSpecificOutput.decision.message = 'Denied from AgentNotch';
  }
  return body;
}

/**
 * PreToolUse response. AskUserQuestion must echo questions plus answers.
 * allow without updatedInput does not satisfy Claude for these tools.
 */
function buildQuestionHookResponse(pending, decision) {
  if (!decision || decision.decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: clip(decision && decision.note, MAX_ANSWER_CHARS) || 'Declined from AgentNotch'
      }
    };
  }

  const updatedInput = pending.toolInput && !pending.toolInput._truncated
    ? { ...pending.toolInput }
    : {};
  if (pending.questionKind === 'plan') {
    if (!updatedInput.plan && pending.plan) updatedInput.plan = pending.plan;
  } else {
    updatedInput.questions = (pending.questions || []).map((q) => ({
      question: q.question,
      header: q.header || '',
      multiSelect: Boolean(q.multiSelect),
      options: (q.options || []).map((o) => ({
        label: o.label,
        description: o.description || ''
      }))
    }));
    updatedInput.answers = decision.answers || {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput
    }
  };
}

/**
 * Poll for a decision file. Returns the file body, or null on timeout.
 */
async function waitForFullDecision(requestId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const dPath = decisionPath(requestId);

  while (Date.now() < deadline) {
    const data = readJsonSafe(dPath);
    if (data && (data.decision === 'allow' || data.decision === 'deny')) {
      return data;
    }
    await sleep(POLL_MS);
  }
  return null;
}

/**
 * Poll for a decision file. Returns 'allow' | 'deny' | null (timeout).
 */
async function waitForDecision(requestId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const data = await waitForFullDecision(requestId, timeoutMs);
  return data ? data.decision : null;
}

function cleanupRequest(requestId) {
  for (const home of allAgentNotchHomes()) {
    removeQuiet(pendingPath(requestId, home));
    removeQuiet(decisionPath(requestId, home));
  }
}

/**
 * Drop pending files older than maxAgeMs (orphan cleanup).
 */
function pruneStalePending(maxAgeMs = DEFAULT_TIMEOUT_MS + 60_000) {
  const now = Date.now();
  for (const p of listPending()) {
    if (p.createdAt && now - p.createdAt > maxAgeMs) {
      cleanupRequest(p.id);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Bridge install (copy script + Claude settings hook) ─

/**
 * Copy this module to ~/.agent-notch/bin so Claude hooks have a stable path
 * outside the Electron asar.
 */
function syncBridgeScript(sourcePath = __filename) {
  ensureDirs();
  const dest = bridgeInstallPath();
  const content = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(dest, content, 'utf8');
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // Windows may ignore chmod
  }
  return dest;
}

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readClaudeSettings() {
  const p = claudeSettingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeClaudeSettings(settings) {
  const p = claudeSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  assertNotSymlink(p);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
}

function isOurHookHandler(handler) {
  if (!handler || handler.type !== 'command') return false;
  const cmd = String(handler.command || '');
  const args = Array.isArray(handler.args) ? handler.args.join(' ') : '';
  return cmd.includes(HOOK_MARKER) || args.includes(HOOK_MARKER);
}

function isHookInstalled() {
  const settings = readClaudeSettings();
  const groups = settings.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const hooks = group?.hooks;
    if (!Array.isArray(hooks)) continue;
    if (hooks.some(isOurHookHandler)) return true;
  }
  // Also consider bridge binary present + any pending protocol readiness
  return false;
}

function makeHookHandler(bridgePath, statusMessage) {
  return {
    type: 'command',
    command: 'node',
    args: [bridgePath],
    timeout: 600,
    statusMessage
  };
}

function upsertOurHandler(settings, eventName, matcher, handler) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks[eventName])) settings.hooks[eventName] = [];
  for (const group of settings.hooks[eventName]) {
    if (!group || typeof group !== 'object') continue;
    if (!Array.isArray(group.hooks)) group.hooks = [];
    const idx = group.hooks.findIndex(isOurHookHandler);
    if (idx >= 0) {
      group.hooks[idx] = handler;
      if (!group.matcher) group.matcher = matcher;
      return;
    }
  }
  settings.hooks[eventName].push({ matcher, hooks: [handler] });
}

/** Permission allow/deny plus AskUserQuestion and ExitPlanMode. */
function installHooksInto(settings, bridgeArgPath) {
  upsertOurHandler(
    settings,
    'PermissionRequest',
    '*',
    makeHookHandler(bridgeArgPath, 'Waiting for AgentNotch approval…')
  );
  upsertOurHandler(
    settings,
    'PreToolUse',
    'AskUserQuestion|ExitPlanMode',
    makeHookHandler(bridgeArgPath, 'Waiting for AgentNotch answer…')
  );
  return settings;
}

function eventHasOurHandler(settings, eventName) {
  const groups = settings && settings.hooks && settings.hooks[eventName];
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const hooks = group && group.hooks;
    if (!Array.isArray(hooks)) continue;
    if (hooks.some(isOurHookHandler)) return true;
  }
  return false;
}

/**
 * Install/update Claude hooks in ~/.claude/settings.json
 * and sync the bridge script.
 */
function installClaudeHook() {
  const bridgePath = syncBridgeScript();
  const settings = readClaudeSettings();
  installHooksInto(settings, bridgePath);
  writeClaudeSettings(settings);
  return {
    success: true,
    bridgePath,
    settingsPath: claudeSettingsPath(),
    message: 'Claude hook installed. Restart any open Claude Code sessions.'
  };
}

/**
 * If the user already installed remote approve, add the question hook once.
 * Does nothing when the permission hook is absent.
 */
function ensureQuestionHook() {
  if (!isHookInstalled() || questionHookInstalled()) return { updated: false };
  installClaudeHook();
  return { updated: true };
}

/**
 * Install the hook into another home (WSL UNC + Linux path for the command arg).
 * The hook process inside WSL must see a Linux path to the copied bridge script.
 *
 * @param {{
 *   settingsPath: string,
 *   bridgePath: string,
 *   hookArgPath: string
 * }} dest
 */
function installClaudeHookAt(dest) {
  if (!dest || !dest.settingsPath || !dest.bridgePath || !dest.hookArgPath) {
    return { success: false, message: 'Missing WSL hook destination' };
  }
  try {
    fs.mkdirSync(path.dirname(dest.bridgePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest.bridgePath, fs.readFileSync(__filename, 'utf8'), 'utf8');
  } catch (err) {
    return { success: false, message: err.message || 'Could not copy bridge into WSL' };
  }

  let settings = {};
  try {
    if (fs.existsSync(dest.settingsPath)) {
      settings = JSON.parse(fs.readFileSync(dest.settingsPath, 'utf8')) || {};
    }
  } catch {
    settings = {};
  }
  installHooksInto(settings, dest.hookArgPath);

  try {
    fs.mkdirSync(path.dirname(dest.settingsPath), { recursive: true });
    assertNotSymlink(dest.settingsPath);
    const tmp = `${dest.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, dest.settingsPath);
  } catch (err) {
    return { success: false, message: err.message || 'Could not write WSL Claude settings' };
  }

  return {
    success: true,
    bridgePath: dest.bridgePath,
    settingsPath: dest.settingsPath,
    message: 'Claude remote-approve hook installed in WSL'
  };
}

/**
 * Remove AgentNotch PermissionRequest hook handlers from Claude settings.
 * Does not delete other hooks.
 */
function uninstallClaudeHook() {
  const settings = readClaudeSettings();
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { success: true, message: 'No AgentNotch hook was installed' };
  }

  for (const eventName of ['PermissionRequest', 'PreToolUse']) {
    const groups = settings.hooks[eventName];
    if (!Array.isArray(groups)) continue;
    const next = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => !isOurHookHandler(h));
      if (hooks.length > 0) next.push({ ...group, hooks });
    }
    if (next.length === 0) delete settings.hooks[eventName];
    else settings.hooks[eventName] = next;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeClaudeSettings(settings);
  return {
    success: true,
    message: 'Claude remote-approve hook removed'
  };
}

function questionHookInstalled() {
  return eventHasOurHandler(readClaudeSettings(), 'PreToolUse');
}

function getHookStatus() {
  const bridgePath = bridgeInstallPath();
  const bridgeExists = fs.existsSync(bridgePath);
  const installed = isHookInstalled();
  return {
    installed,
    questions: questionHookInstalled(),
    bridgePath,
    bridgeExists,
    settingsPath: claudeSettingsPath(),
    pendingCount: listPending().length
  };
}

// ── Session merge helpers (for AgentManager) ───────────

/**
 * Convert a pending request into the session.permissionRequest shape.
 */
function pendingToPermissionRequest(pending) {
  return {
    tool: pending.tool || 'tool',
    input: pending.toolInput || null,
    filePath: pending.filePath || '',
    requestId: pending.id,
    remote: true
  };
}

/**
 * Apply pending remote approvals onto a sessions array (mutates copies).
 * @param {Array<object>} sessions
 * @returns {Array<object>}
 */
function indexPendingBySession(items) {
  const byNotchId = new Map();
  for (const p of items) {
    if (!p.notchSessionId) continue;
    const key = canonicalClaudeSessionId(p.notchSessionId);
    if (!byNotchId.has(key)) byNotchId.set(key, p);
    if (!byNotchId.has(p.notchSessionId)) byNotchId.set(p.notchSessionId, p);
  }
  return byNotchId;
}

function lookupPending(index, sessionId) {
  return index.get(sessionId) || index.get(canonicalClaudeSessionId(sessionId)) || null;
}

function mergePendingIntoSessions(sessions) {
  const pending = listPending();
  const permissions = pending.filter((p) => pendingKind(p) === 'permission');
  const questions = pending.filter((p) => pendingKind(p) === 'question');
  if (permissions.length === 0 && questions.length === 0) {
    return sessions.map((s) => ({
      ...s,
      remoteApprove: s.agent === 'Claude Code',
      remoteAnswer: false
    }));
  }

  const permById = indexPendingBySession(permissions);
  const questionById = indexPendingBySession(questions);
  const used = new Set();
  const result = sessions.map((s) => {
    const perm = lookupPending(permById, s.id);
    if (perm) {
      used.add(perm.id);
      return {
        ...s,
        status: 'permission-request',
        permissionRequest: pendingToPermissionRequest(perm),
        currentTool: perm.tool || s.currentTool,
        remoteApprove: true,
        remoteAnswer: false,
        lastActivityAt: Math.max(s.lastActivityAt || 0, perm.createdAt || 0),
        lastTime: Math.max(s.lastTime || 0, perm.createdAt || 0),
        isActive: true
      };
    }
    const q = lookupPending(questionById, s.id);
    if (q) {
      used.add(q.id);
      return {
        ...s,
        status: 'question',
        question: pendingToQuestion(q),
        permissionRequest: null,
        currentTool: null,
        remoteApprove: false,
        remoteAnswer: true,
        lastActivityAt: Math.max(s.lastActivityAt || 0, q.createdAt || 0),
        lastTime: Math.max(s.lastTime || 0, q.createdAt || 0),
        isActive: true
      };
    }
    return {
      ...s,
      remoteApprove: false,
      remoteAnswer: false
    };
  });

  // Orphan pendings (Claude session not in watcher yet) → synthetic cards.
  // A permission wins over a question for the same session id.
  for (const p of permissions) {
    if (used.has(p.id)) continue;
    const id = p.notchSessionId || `claude-pending-${p.id}`;
    if (result.some((s) => s.id === id)) continue;
    used.add(p.id);
    result.push({
      id,
      agent: 'Claude Code',
      taskName: p.tool ? `Permission: ${p.tool}` : 'Permission request',
      status: 'permission-request',
      currentTool: p.tool || null,
      lastMessage: '',
      userPrompt: '',
      permissionRequest: pendingToPermissionRequest(p),
      question: null,
      duration: 0,
      durationFormatted: '0s',
      startTime: p.createdAt,
      lastTime: p.createdAt,
      lastActivityAt: p.createdAt,
      terminal: 'Terminal',
      toolCalls: p.tool ? [p.tool] : [],
      activity: [],
      isActive: true,
      cwd: p.cwd || '',
      model: null,
      remoteApprove: true,
      remoteAnswer: false
    });
  }
  for (const p of questions) {
    if (used.has(p.id)) continue;
    const id = p.notchSessionId || `claude-pending-${p.id}`;
    if (result.some((s) => s.id === id)) continue;
    const question = pendingToQuestion(p);
    result.push({
      id,
      agent: 'Claude Code',
      taskName: question.text || 'Claude asks',
      status: 'question',
      currentTool: null,
      lastMessage: '',
      userPrompt: '',
      permissionRequest: null,
      question,
      duration: 0,
      durationFormatted: '0s',
      startTime: p.createdAt,
      lastTime: p.createdAt,
      lastActivityAt: p.createdAt,
      terminal: 'Terminal',
      toolCalls: [],
      activity: [],
      isActive: true,
      cwd: p.cwd || '',
      model: null,
      remoteApprove: false,
      remoteAnswer: true
    });
  }

  return result;
}

// ── Hook CLI entry ─────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Claude Code PermissionRequest hook entrypoint.
 * Exit 0 + JSON decision → remote resolve
 * Exit 0 + empty stdout → fall through to Claude's own dialog
 */
async function runHookMode() {
  let input;
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.exit(0);
    }
    if (raw.length > 256 * 1024) {
      process.stderr.write('[agent-notch] hook input too large\n');
      process.exit(0);
    }
    input = JSON.parse(raw);
  } catch (err) {
    // Don't block Claude if we can't parse input
    process.stderr.write(`[agent-notch] invalid hook input: ${err.message}\n`);
    process.exit(0);
  }

  const eventName = input.hook_event_name || input.hookEventName || '';
  const toolName = String(input.tool_name || input.toolName || '');
  const isQuestion = eventName === 'PreToolUse' && QUESTION_TOOLS.has(toolName);
  // Other PreToolUse calls must not block. Only PermissionRequest and the
  // question tools are ours.
  if (eventName === 'PreToolUse' && !isQuestion) {
    process.exit(0);
  }
  if (eventName && eventName !== 'PermissionRequest' && !isQuestion) {
    process.exit(0);
  }

  let pending;
  try {
    pruneStalePending();
    pending = isQuestion ? createQuestionFromHookInput(input) : createPendingFromHookInput(input);
  } catch (err) {
    process.stderr.write(`[agent-notch] failed to create pending: ${err.message}\n`);
    process.exit(0);
  }
  if (!pending) {
    process.exit(0);
  }

  const cleanup = () => {
    try {
      cleanupRequest(pending.id);
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  try {
    const decision = isQuestion
      ? await waitForFullDecision(pending.id, DEFAULT_TIMEOUT_MS)
      : await waitForDecision(pending.id, DEFAULT_TIMEOUT_MS);
    if (!decision) {
      // Timeout: remove pending so notch clears; Claude shows its own dialog
      cleanup();
      process.exit(0);
    }

    const response = isQuestion
      ? buildQuestionHookResponse(pending, decision)
      : buildHookResponse(decision);
    process.stdout.write(JSON.stringify(response));
    cleanup();
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[agent-notch] wait failed: ${err.message}\n`);
    cleanup();
    process.exit(0);
  }
}

module.exports = {
  HOOK_MARKER,
  agentNotchHome,
  permissionsRoot,
  pendingDir,
  decisionsDir,
  bridgeInstallPath,
  ensureDirs,
  setExtraAgentNotchHomes,
  allAgentNotchHomes,
  toNotchSessionId,
  canonicalClaudeSessionId,
  sessionIdsMatch,
  listPending,
  findPendingForSession,
  createPendingFromHookInput,
  createQuestionFromHookInput,
  submitDecision,
  submitDecisionForSession,
  submitQuestionDecision,
  buildHookResponse,
  buildQuestionHookResponse,
  waitForDecision,
  waitForFullDecision,
  cleanupRequest,
  pruneStalePending,
  syncBridgeScript,
  installClaudeHook,
  ensureQuestionHook,
  installClaudeHookAt,
  uninstallClaudeHook,
  isHookInstalled,
  questionHookInstalled,
  getHookStatus,
  pendingToPermissionRequest,
  pendingToQuestion,
  mergePendingIntoSessions,
  runHookMode,
  QUESTION_TOOLS
};

if (require.main === module) {
  runHookMode();
}
