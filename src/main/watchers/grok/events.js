const { phaseToLabel, uniqueTail, resolveTimestamp } = require('./helpers');

/**
 * Lightweight timeline from events.jsonl.
 */
function analyzeGrokEvents(entries) {
  let status = null;
  let currentTool = null;
  let phase = null;
  let phaseLabel = null;
  let permissionRequest = null;
  const toolCalls = [];
  let pendingPermission = null;
  let turnComplete = false;
  let turnStartedAt = null;
  let turnCompletedAt = null;
  let model = null;

  for (const entry of entries) {
    const type = entry.type || '';
    const toolName = entry.tool_name || entry.toolName || entry.tool || null;
    if (entry.model_id || entry.modelId || entry.model) {
      model = entry.model_id || entry.modelId || entry.model;
    }

    switch (type) {
      case 'phase_changed':
        phase = entry.phase || phase;
        phaseLabel = phaseToLabel(phase);
        if (phase === 'permission_prompt') {
          turnComplete = false;
          status = 'permission-request';
        } else if (
          phase === 'tool_execution' ||
          phase === 'streaming_reasoning' ||
          phase === 'streaming_response' ||
          phase === 'streaming_text' ||
          phase === 'streaming' ||
          phase === 'waiting_for_model' ||
          phase === 'planning'
        ) {
          // Active model/tool work — but do not un-complete a finished turn
          // solely because the last phase event was streaming_text before turn_ended
          if (!turnComplete) {
            status = 'working';
          }
        } else if (phase === 'idle' || phase === 'done' || phase === 'completed') {
          turnComplete = true;
          turnCompletedAt = resolveTimestamp(entry);
          status = 'idle';
          currentTool = null;
        }
        break;

      case 'tool_started':
        turnComplete = false;
        if (toolName) {
          currentTool = toolName;
          toolCalls.push(toolName);
        }
        status = 'working';
        break;

      case 'tool_completed':
        if (!turnComplete) {
          // Keep showing last tool until the turn ends
          if (toolName) currentTool = toolName;
          status = 'working';
        }
        break;

      case 'permission_requested':
        turnComplete = false;
        status = 'permission-request';
        pendingPermission = {
          tool: toolName || 'tool',
          filePath: entry.file_path || '',
          input: entry.input || null
        };
        permissionRequest = pendingPermission;
        if (toolName) currentTool = toolName;
        break;

      case 'permission_resolved':
        permissionRequest = null;
        pendingPermission = null;
        // After allow/deny, stay working unless the turn already completed
        if (!turnComplete) {
          if (entry.decision === 'deny' || entry.decision === 'denied') {
            // Deny may end the tool attempt but agent often continues
            status = 'working';
          } else {
            status = 'working';
          }
        }
        break;

      case 'turn_started':
      case 'loop_started':
      case 'first_token':
        turnComplete = false;
        turnStartedAt = resolveTimestamp(entry);
        turnCompletedAt = null;
        status = 'working';
        currentTool = null;
        permissionRequest = null;
        pendingPermission = null;
        phase = null;
        phaseLabel = null;
        if (entry.model_id || entry.modelId || entry.model) {
          model = entry.model_id || entry.modelId || entry.model;
        }
        break;

      // Grok Build emits turn_ended (not turn_completed) on events.jsonl
      case 'turn_ended':
      case 'turn_completed':
      case 'session_ended': {
        const outcome = (entry.outcome || entry.stop_reason || '').toLowerCase();
        // cancelled / error still means the turn is done from the notch's perspective
        turnComplete = true;
        turnCompletedAt = resolveTimestamp(entry);
        status = outcome === 'error' || outcome === 'failed' ? 'needs-attention' : 'idle';
        currentTool = null;
        permissionRequest = null;
        pendingPermission = null;
        break;
      }

      case 'error':
        status = 'needs-attention';
        break;

      default:
        break;
    }
  }

  // If the last phase is permission and never resolved, keep it
  if (!turnComplete && phase === 'permission_prompt' && pendingPermission) {
    status = 'permission-request';
    permissionRequest = pendingPermission;
  }

  // When turn completed, never surface a stale tool/phase as current work
  if (turnComplete) {
    status = status === 'needs-attention' ? 'needs-attention' : 'idle';
    currentTool = null;
  } else if (status === 'working' && !currentTool && phaseLabel) {
    currentTool = phaseLabel;
  }

  return {
    status,
    currentTool,
    phase,
    phaseLabel,
    permissionRequest,
    toolCalls: uniqueTail(toolCalls, 8),
    turnComplete,
    turnStartedAt,
    turnCompletedAt,
    model
  };
}

/**
 * Merge events + updates into a single live status.
 * Completion wins over leftover activity unless the other stream explicitly
 * started a newer turn. File mtimes and arbitrary chunks cannot establish that.
 */
function mergeGrokStatus({ eventState, updateState, isActive }) {
  // Discard the older turn as a whole so its tool/permission cannot leak into
  // the new one. Missing or tied timestamps retain completion precedence.
  const startsAfter = (active, completed) => Boolean(
    active && !active.turnComplete && completed && completed.turnComplete &&
    Number.isFinite(active.turnStartedAt) && active.turnStartedAt > 0 &&
    Number.isFinite(completed.turnCompletedAt) && completed.turnCompletedAt > 0 &&
    active.turnStartedAt > completed.turnCompletedAt
  );
  if (startsAfter(eventState, updateState)) updateState = {};
  else if (startsAfter(updateState, eventState)) eventState = null;

  let status = updateState.status || 'idle';
  let currentTool = updateState.currentTool || null;
  let permissionRequest = updateState.permissionRequest || null;

  const eventStatus = eventState && eventState.status;
  const eventIdle = eventStatus === 'idle' || (eventState && eventState.turnComplete);
  // An empty updates stream defaults to idle but has not completed any turn.
  const updateIdle = updateState.turnComplete === true;

  if (eventState) {
    if (eventState.permissionRequest) {
      permissionRequest = eventState.permissionRequest;
    }

    if (eventStatus === 'permission-request') {
      status = 'permission-request';
    } else if (eventStatus === 'needs-attention') {
      status = 'needs-attention';
    } else if (eventIdle || updateIdle) {
      // Either source reporting turn complete → idle (do not keep working)
      status = 'idle';
      currentTool = null;
      permissionRequest = null;
    } else if (eventStatus === 'working' || updateState.status === 'working') {
      status = 'working';
    }

    // Tool label: only while still working / awaiting permission
    if (status === 'working' || status === 'permission-request') {
      if (eventState.currentTool) {
        const eventTool = eventState.currentTool;
        const updateTool = updateState.currentTool || '';
        if (
          updateTool &&
          (updateTool === eventTool ||
            updateTool.startsWith(eventTool + ':') ||
            updateTool.startsWith(eventTool + ' '))
        ) {
          currentTool = updateTool;
        } else if (eventTool.includes('…') || eventTool.includes('...')) {
          currentTool = updateTool || eventTool;
        } else {
          currentTool = eventTool;
        }
      }
    }
  } else if (updateIdle) {
    status = 'idle';
    currentTool = null;
  }

  // Stale files: settle errored turns so they can archive. Working stays
  // working — AgentManager annotates stall after the quiet threshold.
  if (!isActive && status === 'needs-attention') {
    status = 'idle';
    currentTool = null;
    permissionRequest = null;
  }

  if (status === 'idle') {
    currentTool = null;
  }

  return { status, currentTool, permissionRequest };
}

module.exports = {
  analyzeGrokEvents,
  mergeGrokStatus
};
