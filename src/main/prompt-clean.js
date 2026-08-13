/**
 * Shared prompt cleaning for Insights and watchers.
 *
 * Harnesses wrap the real ask in tags and prepend plugin catalogs,
 * AGENTS.md dumps, and IDE metadata. Those must not become the
 * session's userPrompt or feed the classifier.
 */

const INNER_BLOCKS = [
  /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/gi,
  /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi,
  /<user_request>\s*([\s\S]*?)\s*<\/user_request>/gi
];

/** Cut here — everything after is harness/IDE state, not user intent. */
const CUT_RE = /<(additional_metadata|system-reminder|metadata|environment_context|user_state|context|active_editor|ide_state|recommended_plugins|instructions|agent_skills|user_info)\b/i;

const DUMP_HEAD = /^(here is a list of plugins|#\s*agents\.md\b|you are (an?|the) (coding )?agent)\b/i;

const TRIVIAL_RE = /^(yes|yep|yeah|ok|okay|k|no|nope|thanks|thank you|thx|ls|pwd|hi|hello|hey)\.?$/i;

function lastInnerBlock(text) {
  let last = '';
  for (const re of INNER_BLOCKS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = String(m[1] || '').trim();
      if (inner) last = inner;
    }
  }
  return last;
}

/**
 * Extract the user's actual ask from a raw harness prompt.
 * Returns '' for plugin catalogs, AGENTS.md dumps, and empty wrappers.
 */
function cleanPrompt(prompt) {
  let text = String(prompt || '');
  const inner = lastInnerBlock(text);
  if (inner) text = inner;
  const cut = text.search(CUT_RE);
  if (cut !== -1) text = text.slice(0, cut);
  text = text
    .replace(/<\/?[a-zA-Z][\w:_ -]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (DUMP_HEAD.test(text)) return '';
  return text;
}

function isSubstantive(prompt) {
  const t = cleanPrompt(prompt);
  if (!t) return false;
  if (TRIVIAL_RE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (t.length < 8 && words.length < 3) return false;
  return true;
}

/**
 * Keep the last substantive user turn. Empty / dump / "ok" candidates
 * never replace a real ask; a later real ask replaces an earlier dump.
 */
function preferUserPrompt(current, candidate) {
  const next = cleanPrompt(candidate);
  if (!next) return current ? cleanPrompt(current) : '';
  const cur = cleanPrompt(current);
  if (!cur) return next;
  if (!isSubstantive(cur) && isSubstantive(next)) return next;
  if (isSubstantive(next)) return next;
  return cur;
}

/** True when most of the raw string was harness wrapper, not the ask. */
function promptWasInjected(raw) {
  const src = String(raw || '');
  if (!src) return false;
  const cleaned = cleanPrompt(src);
  if (!cleaned) return true;
  if (src.length >= 80 && cleaned.length / src.length < 0.35) return true;
  return /<(recommended_plugins|INSTRUCTIONS|ADDITIONAL_METADATA|system-reminder|USER_REQUEST|user_query)\b/i.test(src);
}

module.exports = {
  cleanPrompt,
  isSubstantive,
  preferUserPrompt,
  promptWasInjected
};
