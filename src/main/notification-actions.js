/**
 * Pure helper: which OS notification action buttons to show for a session.
 * Electron Notification.actions is Windows/macOS; Linux ignores them.
 * Click-on-body still expands the panel (handled by the caller).
 */

'use strict';

const DISPATCHABLE_AGENTS = new Set(['Claude Code', 'Codex', 'Grok', 'OpenCode']);
const SHORT_LABEL_MAX = 22;

/**
 * @param {object|null|undefined} session
 * @returns {boolean}
 */
function canRemoteApprove(session) {
  return Boolean(session && session.remoteApprove && session.status === 'permission-request');
}

/**
 * @param {object|null|undefined} session
 * @returns {boolean}
 */
function canRemoteAnswer(session) {
  return Boolean(
    session &&
    session.status === 'question' &&
    DISPATCHABLE_AGENTS.has(session.agent)
  );
}

function optionParts(opt) {
  const label = typeof opt === 'string' ? opt : (opt && (opt.label || opt.value));
  const value = typeof opt === 'string' ? opt : (opt && (opt.value || opt.label));
  return {
    label: String(label || '').trim(),
    value: String(value || '').trim()
  };
}

/**
 * Build action buttons for an attention notification.
 * `id` is what the main process switches on; `text` is the button label.
 * `answer` is set for question-option actions.
 *
 * @param {object|null|undefined} session — queue head
 * @returns {Array<{ id: string, text: string, answer?: string }>}
 */
function notificationActionsFor(session) {
  if (!session) return [];
  const status = session.status;

  if (status === 'permission-request') {
    if (canRemoteApprove(session)) {
      return [
        { id: 'allow', text: 'Allow' },
        { id: 'deny', text: 'Deny' },
        { id: 'snooze', text: 'Snooze' }
      ];
    }
    return [
      { id: 'jump', text: 'Jump' },
      { id: 'snooze', text: 'Snooze' }
    ];
  }

  if (status === 'question') {
    if (canRemoteAnswer(session)) {
      const raw = Array.isArray(session.question && session.question.options)
        ? session.question.options
        : [];
      const options = raw.map(optionParts).filter((o) => o.label);
      const short = options.filter((o) => o.label.length <= SHORT_LABEL_MAX);
      if (options.length >= 1 && options.length <= 2 && short.length === options.length) {
        return [
          ...options.map((o) => ({ id: 'answer', text: o.label, answer: o.value })),
          { id: 'snooze', text: 'Snooze' }
        ];
      }
      return [
        { id: 'open', text: 'Open' },
        { id: 'snooze', text: 'Snooze' }
      ];
    }
    return [
      { id: 'jump', text: 'Jump' },
      { id: 'snooze', text: 'Snooze' }
    ];
  }

  if (status === 'needs-attention' || session.stalled) {
    return [
      { id: 'jump', text: 'Jump' },
      { id: 'snooze', text: 'Snooze' }
    ];
  }

  return [];
}

module.exports = {
  DISPATCHABLE_AGENTS,
  canRemoteApprove,
  canRemoteAnswer,
  notificationActionsFor
};
