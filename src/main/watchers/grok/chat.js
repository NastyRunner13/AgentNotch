const { getText } = require('../session-utils');
const { preferUserPrompt } = require('../../lib/prompt-clean');
const { uniqueTail } = require('./helpers');

/**
 * Parse Grok chat_history.jsonl for full assistant replies and user prompts.
 * This is the best source of complete agent text (updates stream is chunked/tailed).
 */
function analyzeChatHistory(entries) {
  let userPrompt = '';
  let lastMessage = '';
  /** @type {Array<{text:string, at?:number}>} */
  let recentMessages = [];
  const toolCalls = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const type = entry.type || entry.role || '';

    if (type === 'user') {
      const text = getText(entry.content || entry.message);
      if (!text) continue;
      // Prefer explicit user_query blocks; skip system reminders / user_info
      const queryMatch = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      if (queryMatch && queryMatch[1].trim()) {
        userPrompt = preferUserPrompt(userPrompt, queryMatch[1].trim());
      } else if (
        !text.includes('<system-reminder>') &&
        !text.includes('<user_info>') &&
        !text.includes('<agent_skills>') &&
        text.trim().length > 0
      ) {
        userPrompt = preferUserPrompt(userPrompt, text.trim());
      }
      continue;
    }

    if (type === 'assistant') {
      const text = typeof entry.content === 'string'
        ? entry.content
        : getText(entry.content || entry.message);
      if (text && text.trim()) {
        lastMessage = text.trim();
        recentMessages.push({
          text: lastMessage.length > 2000 ? lastMessage.slice(-2000) : lastMessage
        });
        if (recentMessages.length > 20) recentMessages = recentMessages.slice(-20);
      }
      if (Array.isArray(entry.tool_calls)) {
        for (const tc of entry.tool_calls) {
          const name = tc.name || tc.function?.name || tc.type;
          if (name) toolCalls.push(name);
        }
      }
    }
  }

  return {
    userPrompt: userPrompt ? userPrompt.substring(0, 600) : '',
    lastMessage: lastMessage ? lastMessage.substring(0, 2000) : '',
    recentMessages,
    toolCalls: uniqueTail(toolCalls, 24)
  };
}

module.exports = {
  analyzeChatHistory
};
