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

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  // mode 0o600 — owner read/write only; pending/decision files may contain tool input / secrets
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
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
function findPendingForSession(notchSessionId) {
  if (!notchSessionId) return null;
  const all = listPending();
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
  const toolName = input.tool_name || input.toolName || 'tool';
  const toolInput = input.tool_input || input.toolInput || {};
  const notchSessionId = toNotchSessionId(claudeSessionId, transcriptPath);

  const pending = {
    id,
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
 * Poll for a decision file. Returns 'allow' | 'deny' | null (timeout).
 */
async function waitForDecision(requestId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const dPath = decisionPath(requestId);

  while (Date.now() < deadline) {
    const data = readJsonSafe(dPath);
    if (data && (data.decision === 'allow' || data.decision === 'deny')) {
      return data.decision;
    }
    await sleep(POLL_MS);
  }
  return null;
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
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
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

function makeHookHandler(bridgePath) {
  return {
    type: 'command',
    command: 'node',
    args: [bridgePath],
    timeout: 600,
    statusMessage: 'Waiting for AgentNotch approval…'
  };
}

/**
 * Install/update the PermissionRequest hook in ~/.claude/settings.json
 * and sync the bridge script.
 */
function installClaudeHook() {
  const bridgePath = syncBridgeScript();
  const settings = readClaudeSettings();
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.PermissionRequest)) {
    settings.hooks.PermissionRequest = [];
  }

  const handler = makeHookHandler(bridgePath);
  let foundGroup = false;

  for (const group of settings.hooks.PermissionRequest) {
    if (!group || typeof group !== 'object') continue;
    if (!Array.isArray(group.hooks)) group.hooks = [];
    const idx = group.hooks.findIndex(isOurHookHandler);
    if (idx >= 0) {
      group.hooks[idx] = handler;
      foundGroup = true;
      break;
    }
  }

  if (!foundGroup) {
    // Prefer a dedicated catch-all matcher group
    settings.hooks.PermissionRequest.push({
      matcher: '*',
      hooks: [handler]
    });
  }

  writeClaudeSettings(settings);
  return {
    success: true,
    bridgePath,
    settingsPath: claudeSettingsPath(),
    message: 'Claude remote-approve hook installed. Restart any open Claude Code sessions.'
  };
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
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PermissionRequest)) settings.hooks.PermissionRequest = [];

  const handler = makeHookHandler(dest.hookArgPath);
  let foundGroup = false;
  for (const group of settings.hooks.PermissionRequest) {
    if (!group || typeof group !== 'object') continue;
    if (!Array.isArray(group.hooks)) group.hooks = [];
    const idx = group.hooks.findIndex(isOurHookHandler);
    if (idx >= 0) {
      group.hooks[idx] = handler;
      foundGroup = true;
      break;
    }
  }
  if (!foundGroup) {
    settings.hooks.PermissionRequest.push({ matcher: '*', hooks: [handler] });
  }

  try {
    fs.mkdirSync(path.dirname(dest.settingsPath), { recursive: true });
    const tmp = `${dest.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
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
  const groups = settings.hooks?.PermissionRequest;
  if (!Array.isArray(groups)) {
    return { success: true, message: 'No AgentNotch hook was installed' };
  }

  const next = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      next.push(group);
      continue;
    }
    const hooks = group.hooks.filter((h) => !isOurHookHandler(h));
    if (hooks.length > 0) {
      next.push({ ...group, hooks });
    }
  }

  if (next.length === 0) {
    delete settings.hooks.PermissionRequest;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  } else {
    settings.hooks.PermissionRequest = next;
  }

  writeClaudeSettings(settings);
  return {
    success: true,
    message: 'Claude remote-approve hook removed'
  };
}

function getHookStatus() {
  const bridgePath = bridgeInstallPath();
  const bridgeExists = fs.existsSync(bridgePath);
  const installed = isHookInstalled();
  return {
    installed,
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
function mergePendingIntoSessions(sessions) {
  const pending = listPending();
  if (pending.length === 0) {
    return sessions.map((s) => ({
      ...s,
      remoteApprove: s.agent === 'Claude Code'
    }));
  }

  const byNotchId = new Map();
  for (const p of pending) {
    if (!p.notchSessionId) continue;
    const key = canonicalClaudeSessionId(p.notchSessionId);
    if (!byNotchId.has(key)) byNotchId.set(key, p);
    if (!byNotchId.has(p.notchSessionId)) byNotchId.set(p.notchSessionId, p);
  }

  const used = new Set();
  const result = sessions.map((s) => {
    const p = byNotchId.get(s.id) || byNotchId.get(canonicalClaudeSessionId(s.id));
    if (!p) {
      return {
        ...s,
        remoteApprove: false
      };
    }
    used.add(p.id);
    return {
      ...s,
      status: 'permission-request',
      permissionRequest: pendingToPermissionRequest(p),
      currentTool: p.tool || s.currentTool,
      remoteApprove: true,
      lastActivityAt: Math.max(s.lastActivityAt || 0, p.createdAt || 0),
      lastTime: Math.max(s.lastTime || 0, p.createdAt || 0),
      isActive: true
    };
  });

  // Orphan pendings (Claude session not in watcher yet) → synthetic cards
  for (const p of pending) {
    if (used.has(p.id)) continue;
    const id = p.notchSessionId || `claude-pending-${p.id}`;
    if (result.some((s) => s.id === id)) continue;
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
      remoteApprove: true
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
    input = JSON.parse(raw);
  } catch (err) {
    // Don't block Claude if we can't parse input
    process.stderr.write(`[agent-notch] invalid hook input: ${err.message}\n`);
    process.exit(0);
  }

  const eventName = input.hook_event_name || input.hookEventName || '';
  // Allow PreToolUse only if someone misconfigured; we only decide PermissionRequest shape
  if (eventName && eventName !== 'PermissionRequest') {
    process.exit(0);
  }

  let pending;
  try {
    pruneStalePending();
    pending = createPendingFromHookInput(input);
  } catch (err) {
    process.stderr.write(`[agent-notch] failed to create pending: ${err.message}\n`);
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
    const decision = await waitForDecision(pending.id, DEFAULT_TIMEOUT_MS);
    if (!decision) {
      // Timeout: remove pending so notch clears; Claude shows its own dialog
      cleanup();
      process.exit(0);
    }

    const response = buildHookResponse(decision);
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
  submitDecision,
  submitDecisionForSession,
  buildHookResponse,
  waitForDecision,
  cleanupRequest,
  pruneStalePending,
  syncBridgeScript,
  installClaudeHook,
  installClaudeHookAt,
  uninstallClaudeHook,
  isHookInstalled,
  getHookStatus,
  pendingToPermissionRequest,
  mergePendingIntoSessions,
  runHookMode
};

if (require.main === module) {
  runHookMode();
}
