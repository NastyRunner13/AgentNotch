const { dayKey } = require('./usage-stats');

/**
 * Conversation Insights — local, heuristic classification of agent sessions.
 *
 * Every record is derived on-device from data the watchers already surface
 * (user prompt, task name, tool calls, duration, plan). Nothing leaves the
 * machine; there is no model in the loop — the classifier is a transparent,
 * weighted keyword/signal scorer that tests can pin down exactly.
 *
 * Per prompted session it produces:
 *   category    — intent: feature | bugfix | testing | refactor | architecture |
 *                 styling | data | devops | performance | security | docs |
 *                 review | exploration | general
 *   area        — work type: frontend | backend | fullstack | data | devops |
 *                 mobile | docs | general
 *   langs       — top languages (from file extensions in tool calls)
 *   complexity  — 0..100 from duration, tool breadth, file spread, prompt size
 *   specificity — 0..100 from prompt length, paths, identifiers, tech terms
 *
 * Sessions without a real prompt (bare process placeholders like "Cursor IDE")
 * are not conversations and produce no record.
 */

/* ── Intent categories ──────────────────────────────────
 * Ordered: earlier wins ties. Specific intents precede feature (the default
 * verb "add" lives there) and the general fallback. Each pattern carries a
 * weight; the category with the highest total wins, below threshold the
 * session is "general". */

const CATEGORY_DEFS = [
  {
    id: 'bugfix',
    patterns: [
      [/\b(fix|fixes|fixed|fixing|bug|bugs|bugfix|hotfix|debug|debugging|broken|broke|error|errors|exception|exceptions|crash|crashes|crashed|regression|regressions|traceback|stack\s?trace|not working|doesn'?t work|isn'?t working|stopped working)\b/i, 3],
      [/\b(failing|failure|issue|issues|wrong|incorrect|unexpected|weird|defect|broken)\b/i, 1.5],
      [/\b(the problem is|but it (shows?|does|doesn'?t|only)|instead of|not the actual|not showing|shows? wrong|shows? only)\b/i, 2]
    ]
  },
  {
    id: 'testing',
    patterns: [
      [/\b(test|tests|testing|spec|specs|unit tests?|integration tests?|e2e|tdd|coverage|assertion|assertions|snapshot tests?)\b/i, 3],
      [/\b(jest|vitest|mocha|pytest|playwright|cypress|phpunit|rspec|xunit|nunit|mock|mocks|mocking|stub|stubs|fixture|fixtures)\b/i, 3]
    ],
    toolPatterns: [
      // 1.5 per matching call (cap 2): one incidental `npm test` verification
      // must not flip intent; a test-focused session runs them repeatedly.
      [/\b((npm|yarn|pnpm|bun|deno)\s+(run\s+)?test|pytest|jest|vitest|go test|cargo test|mvn test|gradle(w)? test|playwright test|cypress run)\b/i, 1.5]
    ]
  },
  {
    id: 'security',
    patterns: [
      [/\b(security|secure|vulnerability|vulnerabilities|cve|xss|csrf|sql injection|injection|sanitize|sanitization|encrypt|encryption|decrypt|exploit|pentest|threat model)\b/i, 3],
      [/\b(authentication|authorization|oauth|jwt|permissions?|acl|rate.?limit(?:ing)?|cors|credentials?|secrets?)\b/i, 1.5]
    ]
  },
  {
    id: 'performance',
    patterns: [
      // Action verbs outrank domain nouns elsewhere ("optimize the db" → perf)
      [/\b(optimi[sz]e|optimi[sz]ation|optimi[sz]ing|profile|profiling|benchmark|speed up|speedup)\b/i, 3],
      [/\b(performance|perf|faster|slow|latency|memory leak|leak|bundle size|cache|caching|n\+1|lazy.?load(?:ing)?|debounce|throttle|minification|compression)\b/i, 2.5]
    ]
  },
  {
    id: 'data',
    patterns: [
      // Domain nouns — weighted below action verbs so "refactor the schema"
      // classifies as refactor, not data.
      [/\b(database|databases|db|sql|query|queries|schema|schemas|migration|migrations|migrate|table|tables|postgres|postgresql|mysql|sqlite|mongodb|mongo|redis|prisma|sequelize|typeorm|drizzle|orm|seed|seeding|etl|dataframe|pandas)\b/i, 2.5],
      [/\b(analy[sz]e|analy[sz]ing|analysis|analytical|backtest|backtesting|metrics|visuali[sz]ation|visuali[sz]e|visuali[sz]ing|dataset|datasets|csv|excel|portfolio|simulation|winrate|win rate)\b/i, 2]
    ]
  },
  {
    id: 'refactor',
    patterns: [
      [/\b(refactor|refactors|refactoring|cleanup|clean up|cleaning up|restructure|restructuring|reorganize|reorganize|rename|renaming|simplify|simplification|dedupe|deduplicate|extract|decouple|modularize|consolidate|consolidation|tidy)\b/i, 3],
      [/\b(technical debt|tech debt|code smell|without changing (behavior|behaviour|functionality))\b/i, 2.5]
    ]
  },
  {
    id: 'architecture',
    patterns: [
      [/\b(scaffold|scaffolding|bootstrap|design the (system|architecture|api))\b/i, 3],
      [/\b(architecture|architect|architectural|system design|project structure|folder structure|module structure|module boundaries|monorepo|microservice|microservices|monolith|domain model)\b/i, 2.5],
      [/\b(rfc|adr|blueprint|proposal for)\b/i, 2]
    ]
  },
  {
    id: 'devops',
    patterns: [
      [/\b(deploy|deploys|deployment|deploying|publish|publishing|containerize|version bump)\b/i, 3],
      [/\b(ci\/cd|pipeline|pipelines|docker|dockerfile|container|containers|kubernetes|k8s|terraform|ansible|jenkins|github actions|gitlab ci|circleci|vercel|netlify|heroku|nginx|release|releases)\b/i, 2.5],
      [/\b(aws|gcp|azure|ec2|s3|lambda|cloudflare|workflow)\b/i, 2]
    ]
  },
  {
    id: 'styling',
    patterns: [
      [/\b(redesign|restyle|restyling|animate|animating)\b/i, 3],
      [/\b(css|scss|sass|tailwind|style|styles|styling|stylesheet|layout|layouts|responsive|animation|animations|transition|transitions|hover|theme|themes|theming|dark mode|light mode|visual|pixels?|typography|font|fonts|colors?|color scheme|spacing|margins?|paddings?|flexbox|flex|grid|ui|ux|modal|tooltip|navbar|sidebar|hero|button)\b/i, 2.5],
      [/\b(logo|logos|icon|icons|dots?|badge|avatar|in that place|in the.{0,20}section)\b/i, 1.5]
    ]
  },
  {
    id: 'docs',
    patterns: [
      [/\b(document|documentation|documenting|readme|docs|docstring|docstrings|jsdoc|changelog|comments?|guide|tutorial|walkthrough)\b/i, 3]
    ],
    extAreas: { docs: 1.5 } // .md/.mdx/.rst writes support docs intent (cap 2)
  },
  {
    id: 'review',
    patterns: [
      [/\b(code review|review|reviewing|audit|auditing|look over|double.?check|check my|sanity check|is this (right|correct|safe|okay|ok))\b/i, 3],
      [/\b(what do you think|what are your thoughts|your opinion|your thoughts|critique|critiquing|assess|assessing|assessment|study the|look at the|check if|check whether)\b/i, 2.5]
    ]
  },
  {
    id: 'exploration',
    patterns: [
      [/\b(explain|explaining|how does|how do|what does|why does|why is|walk me through|understand|where is|where does|investigate|explore|exploring|trace|show me how|find (the |where )?(code|logic|function|bug))\b/i, 3],
      [/\b(how much|how many|how long|what is|what are|what was|tell me about|tell me how|can you explain|can you show|can I|is it possible|does it support)\b/i, 2]
    ]
  },
  {
    id: 'feature',
    patterns: [
      // Generic verbs are weak signals — counted once so "create a migration
      // to add a column" still classifies as data work, not a feature.
      [/\b(add|adds|adding|implement|implements|implementing|build|building|create|creating|introduce|introducing|support|enable|enabling|feature|features)\b/i, 2, 1],
      [/\b(new|make it possible|i want|we need|allow users|let users)\b/i, 1.5],
      [/\b(upgrade|upgrading|upgraded|configure|configuring|configuration|set up|setting up|setup|generate|generating|automate|automating|automation)\b/i, 2, 1]
    ]
  }
];

const FALLBACK_CATEGORY = 'general';
/** Minimum weighted score to assign a real intent. */
const CATEGORY_THRESHOLD = 1.5;

/* ── Work-type (area) detection ───────────────────────── */

/** Known file extension → { lang, area? }. ts/js stay area-neutral (web). */
const EXT_MAP = {
  ts: { lang: 'TypeScript' }, mts: { lang: 'TypeScript' }, cts: { lang: 'TypeScript' },
  tsx: { lang: 'TypeScript', area: 'frontend' },
  js: { lang: 'JavaScript' }, mjs: { lang: 'JavaScript' }, cjs: { lang: 'JavaScript' },
  jsx: { lang: 'JavaScript', area: 'frontend' },
  css: { lang: 'CSS', area: 'frontend' }, scss: { lang: 'CSS', area: 'frontend' },
  sass: { lang: 'CSS', area: 'frontend' }, less: { lang: 'CSS', area: 'frontend' },
  html: { lang: 'HTML', area: 'frontend' }, vue: { lang: 'Vue', area: 'frontend' },
  svelte: { lang: 'Svelte', area: 'frontend' },
  py: { lang: 'Python', area: 'backend' }, go: { lang: 'Go', area: 'backend' },
  rs: { lang: 'Rust', area: 'backend' }, java: { lang: 'Java', area: 'backend' },
  rb: { lang: 'Ruby', area: 'backend' }, php: { lang: 'PHP', area: 'backend' },
  cs: { lang: 'C#', area: 'backend' }, cpp: { lang: 'C++', area: 'backend' },
  c: { lang: 'C', area: 'backend' }, h: { lang: 'C', area: 'backend' },
  ex: { lang: 'Elixir', area: 'backend' }, exs: { lang: 'Elixir', area: 'backend' },
  sql: { lang: 'SQL', area: 'data' }, ipynb: { lang: 'Notebook', area: 'data' },
  yaml: { lang: 'YAML', area: 'devops' }, yml: { lang: 'YAML', area: 'devops' },
  sh: { lang: 'Shell', area: 'devops' }, bash: { lang: 'Shell', area: 'devops' },
  ps1: { lang: 'PowerShell', area: 'devops' }, tf: { lang: 'Terraform', area: 'devops' },
  md: { lang: 'Markdown', area: 'docs' }, mdx: { lang: 'Markdown', area: 'docs' },
  rst: { lang: 'reST', area: 'docs' },
  swift: { lang: 'Swift', area: 'mobile' }, kt: { lang: 'Kotlin', area: 'mobile' },
  dart: { lang: 'Dart', area: 'mobile' },
  json: { lang: 'JSON' }, toml: { lang: 'TOML' }, xml: { lang: 'XML' }
};

/** Prompt keywords that hint at an area (weight 1 each). */
const AREA_PROMPT_HINTS = {
  frontend: /\b(react|vue|svelte|angular|css|tailwind|dom|browser|component|components|frontend|front-end|ui|ux|webpage|landing page|responsive|button|modal|navbar|sidebar|layout)\b/i,
  backend: /\b(api|apis|endpoint|endpoints|server|express|fastapi|django|flask|rails|backend|back-end|middleware|websocket|microservice|cli)\b/i,
  data: /\b(database|db|sql|postgres|mysql|sqlite|mongo|prisma|pandas|dataframe|etl|migration|schema)\b/i,
  devops: /\b(docker|kubernetes|k8s|ci|deploy|deployment|pipeline|terraform|github actions|nginx|aws|gcp|azure|vercel|release)\b/i,
  mobile: /\b(ios|android|swift|kotlin|flutter|react native|xcode|mobile)\b/i,
  docs: /\b(readme|documentation|docs|changelog|guide|tutorial)\b/i
};

/* ── Specificity signals ──────────────────────────────── */

const TECH_TERMS = new RegExp(
  '\\b(' +
  [
    'api', 'apis', 'endpoint', 'endpoints', 'route', 'routes', 'router', 'handler', 'handlers',
    'middleware', 'auth', 'token', 'tokens', 'jwt', 'oauth', 'database', 'db', 'sql', 'query',
    'schema', 'migration', 'table', 'index', 'cache', 'redis', 'component', 'components', 'hook',
    'hooks', 'state', 'props', 'dom', 'css', 'selector', 'responsive', 'layout', 'async', 'await',
    'promise', 'promises', 'callback', 'websocket', 'socket', 'stream', 'streams', 'queue',
    'worker', 'workers', 'regex', 'parser', 'lexer', 'ast', 'compiler', 'bundler', 'webpack',
    'vite', 'esbuild', 'test', 'tests', 'spec', 'mock', 'stub', 'fixture', 'coverage', 'docker',
    'kubernetes', 'pipeline', 'nginx', 'lambda', 'function', 'class', 'interface', 'type',
    'types', 'enum', 'struct', 'generics?', 'error', 'errors', 'exception', 'crash', 'leak',
    'race condition', 'deadlock', 'timeout', 'retry', 'validation', 'sanitize', 'encryption',
    'hash', 'cors', 'csrf', 'xss', 'config', 'env', 'cli', 'sdk', 'grpc', 'rest', 'graphql',
    'singleton', 'factory', 'observer', 'mutex', 'throttle', 'debounce', 'breakpoint', 'viewport',
    'watcher', 'watchers', 'session', 'sessions', 'notch', 'electron', 'transcript', 'sidebar',
    'modal', 'tooltip', 'toggle', 'dropdown', 'ffmpeg', 'stripe', 'supabase', 'firebase'
  ].join('|') +
  ')\\b',
  'gi'
);

const PATH_RE = /(?:^|[\s`'"(=])[\w.@~/-]*[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|cs|cpp|c|h|css|scss|sass|less|html|vue|svelte|sql|md|mdx|rst|json|ya?ml|toml|xml|sh|bash|ps1|swift|kt|dart|ipynb|env|ini|conf|lock)\b/i;
const DIR_PATH_RE = /\b[\w@-]+\/[\w@/.+-]+\//;
const IDENTIFIER_RE = /(\b[a-z][a-z0-9]*[A-Z][\w]*\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[\w.]+\(\)|`[^`\n]+`)/;
const NUMBER_RE = /\b\d+(\.\d+)*([a-z]+)?\b/;
const STRUCTURE_RE = /(\r?\n|\s[-*•]\s|\b\d+[.)]\s)/;
const EXPECTATION_RE = /\b(should|expected|expect|instead|currently|actually|actual|so that|because|reproduce|steps to|when i|after i|before it)\b/i;

/* ── Helpers ──────────────────────────────────────────── */

/** Harness-injected blocks that follow the real user text (IDE state, open
 *  documents, timestamps). They are not user intent and must not feed the
 *  classifier — a `.test.js` path here would flip anything to "testing". */
const METADATA_CUT_RE = /<(additional_metadata|system-reminder|metadata|environment_context|user_state|context|active_editor|ide_state)\b/i;

function cleanPrompt(prompt) {
  let text = String(prompt || '');
  const cut = text.search(METADATA_CUT_RE);
  if (cut !== -1) text = text.slice(0, cut);
  return text
    .replace(/<\/?[a-z_ -]+>/gi, ' ') // strip <user_request>-style wrappers
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/** Tool name from strings like `Edit(x.ts)`, `run(npm test)`, `bash: ls`. */
function toolName(call) {
  const s = String(call || '').trim();
  const m = s.match(/^([A-Za-z][\w-]*)/);
  return m ? m[1] : s;
}

/** Inner argument text of a tool call — `Edit(src/a.ts)` → `src/a.ts`. */
function toolArgs(call) {
  const s = String(call || '');
  const paren = s.match(/\((.*)\)/);
  if (paren) return paren[1];
  const colon = s.match(/^[A-Za-z][\w-]*:\s*(.*)$/);
  return colon ? colon[1] : s;
}

/** Known file extensions mentioned in a text (tool args or prompt). */
function extractExtensions(text) {
  const exts = new Set();
  const re = /[\w@-]+\.([a-z0-9]{1,10})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ext = m[1].toLowerCase();
    if (EXT_MAP[ext]) exts.add(ext);
  }
  return exts;
}

/* ── Classifiers ──────────────────────────────────────── */

/**
 * Weighted intent classification. Prompt text carries the patterns; tool
 * calls add execution signals (test runs, doc writes). Returns the winning
 * category id and the raw scores (useful for tests/debugging).
 *
 * @param {string} prompt
 * @param {string} [taskName]
 * @param {string[]} [toolCalls]
 * @returns {{ category: string, scores: Object<string, number> }}
 */
function classifyIntent(prompt, taskName = '', toolCalls = []) {
  const text = `${cleanPrompt(prompt)} ${String(taskName || '')}`.trim();
  const scores = {};

  for (const def of CATEGORY_DEFS) {
    let score = 0;
    for (const [re, weight, cap = 2] of def.patterns || []) {
      const matches = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      if (matches) score += weight * Math.min(matches.length, cap); // cap repeat gaming
    }
    for (const [re, weight] of def.toolPatterns || []) {
      const hits = toolCalls.filter(call => re.test(String(call))).length;
      if (hits) score += weight * Math.min(hits, 2);
    }
    if (def.extAreas) {
      const exts = new Set();
      for (const call of toolCalls) {
        for (const e of extractExtensions(toolArgs(call))) exts.add(e);
      }
      let hits = 0;
      for (const e of exts) {
        const area = EXT_MAP[e] && EXT_MAP[e].area;
        if (area && def.extAreas[area]) hits += 1;
      }
      const weight = Object.values(def.extAreas)[0] || 0;
      if (hits) score += weight * Math.min(hits, 2);
    }
    if (score > 0) scores[def.id] = Math.round(score * 100) / 100;
  }

  let best = FALLBACK_CATEGORY;
  let bestScore = 0;
  for (const def of CATEGORY_DEFS) {
    const s = scores[def.id] || 0;
    if (s > bestScore) {
      best = def.id;
      bestScore = s;
    }
  }
  if (bestScore < CATEGORY_THRESHOLD) best = FALLBACK_CATEGORY;
  return { category: best, scores };
}

/**
 * Work type from file extensions in tool calls plus prompt hints.
 * frontend+backend signals together → "fullstack".
 *
 * @returns {{ area: string, langs: string[], areas: Object<string, number> }}
 */
function detectWorkType(toolCalls = [], prompt = '') {
  const areaScores = {};
  const langCount = new Map();
  const bump = (area, n) => { areaScores[area] = (areaScores[area] || 0) + n; };

  for (const call of toolCalls) {
    const seenInCall = new Set();
    for (const ext of extractExtensions(toolArgs(call))) {
      const info = EXT_MAP[ext];
      if (!info) continue;
      if (info.area && !seenInCall.has(info.area)) {
        bump(info.area, 2);
        seenInCall.add(info.area);
      }
      if (!seenInCall.has(`lang:${info.lang}`)) {
        langCount.set(info.lang, (langCount.get(info.lang) || 0) + 1);
        seenInCall.add(`lang:${info.lang}`);
      }
    }
  }

  const text = cleanPrompt(prompt);
  for (const [area, re] of Object.entries(AREA_PROMPT_HINTS)) {
    if (re.test(text)) bump(area, 1);
  }

  let area = 'general';
  const fe = areaScores.frontend || 0;
  const be = areaScores.backend || 0;
  if (fe > 0 && be > 0) {
    area = 'fullstack';
  } else {
    let bestScore = 0;
    for (const [a, s] of Object.entries(areaScores)) {
      if (s > bestScore) { bestScore = s; area = a; }
    }
  }

  const langs = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => lang);

  return { area, langs, areas: areaScores };
}

/**
 * Task complexity 0..100 from observable effort signals:
 *   duration 35 · tool count 25 · distinct tools 10 · file-type spread 10 ·
 *   prompt size 10 · plan steps 10.
 */
function scoreComplexity(session = {}, toolCalls = [], prompt = '') {
  const ms = Number(session.duration)
    || (Number.isFinite(session.startTime) && Number.isFinite(session.lastTime)
      ? session.lastTime - session.startTime : 0);
  const minutes = Math.max(0, ms) / 60000;
  let durPts;
  if (minutes < 2) durPts = 4;
  else if (minutes < 5) durPts = 9;
  else if (minutes < 10) durPts = 15;
  else if (minutes < 20) durPts = 22;
  else if (minutes < 40) durPts = 29;
  else durPts = 35;

  const n = toolCalls.length;
  let toolPts;
  if (n === 0) toolPts = 0;
  else if (n <= 3) toolPts = 7;
  else if (n <= 8) toolPts = 12;
  else if (n <= 15) toolPts = 17;
  else if (n <= 25) toolPts = 21;
  else toolPts = 25;

  const distinctTools = new Set(toolCalls.map(toolName)).size;
  const exts = new Set();
  for (const call of toolCalls) {
    for (const e of extractExtensions(toolArgs(call))) exts.add(e);
  }

  const words = wordCount(cleanPrompt(prompt));
  let wordPts;
  if (words < 5) wordPts = 0;
  else if (words < 20) wordPts = 4;
  else if (words < 60) wordPts = 7;
  else wordPts = 10;

  const planSteps = Array.isArray(session.plan) ? session.plan.length : 0;

  const total = durPts + toolPts
    + Math.min(10, distinctTools * 2)
    + Math.min(10, exts.size * 2)
    + wordPts
    + Math.min(10, planSteps * 2);
  return Math.max(0, Math.min(100, Math.round(total)));
}

/**
 * Prompt specificity 0..100 — how much actionable context the prompt gives:
 *   length 46 · file path 14 · code identifier 12 · tech terms 16 ·
 *   multi-term scope bonus 8 · numbers 6 · structure 6 · expectation 6.
 */
function scoreSpecificity(prompt = '') {
  const text = cleanPrompt(prompt);
  if (!text) return 0;

  const words = wordCount(text);
  let wordPts;
  if (words <= 3) wordPts = words === 0 ? 0 : 6;
  else if (words <= 8) wordPts = 20;
  else if (words <= 20) wordPts = 32;
  else if (words <= 50) wordPts = 40;
  else wordPts = 46;

  const terms = text.match(TECH_TERMS) || [];
  const termCount = new Set(terms.map(t => t.toLowerCase())).size;
  const termPts = Math.min(16, termCount * 4);
  const scopeBonus = termCount >= 2 ? 8 : 0;

  const pathPts = (PATH_RE.test(text) || DIR_PATH_RE.test(text)) ? 14 : 0;
  const identPts = IDENTIFIER_RE.test(text) ? 12 : 0;
  const numPts = NUMBER_RE.test(text) ? 6 : 0;
  const structPts = STRUCTURE_RE.test(String(prompt)) ? 6 : 0;
  const expectPts = EXPECTATION_RE.test(text) ? 6 : 0;

  return Math.max(0, Math.min(100,
    wordPts + pathPts + identPts + termPts + scopeBonus + numPts + structPts + expectPts
  ));
}

/** Score → band id. Exported thresholds keep renderer and tests honest. */
const COMPLEXITY_BANDS = [
  { id: 'simple', max: 24 },
  { id: 'moderate', max: 49 },
  { id: 'complex', max: 74 },
  { id: 'deep', max: 100 }
];
const SPECIFICITY_BANDS = [
  { id: 'vague', max: 34 },
  { id: 'clear', max: 64 },
  { id: 'precise', max: 100 }
];

function bandFor(score, bands) {
  for (const b of bands) {
    if (score <= b.max) return b.id;
  }
  return bands[bands.length - 1].id;
}

/**
 * Build one insight record from a session, or null when the session is not
 * a real conversation (no user prompt — e.g. bare process placeholders).
 */
function buildInsightRecord(session) {
  if (!session || !session.id) return null;
  const prompt = cleanPrompt(session.userPrompt);
  if (!prompt) return null;

  const toolCalls = Array.isArray(session.toolCalls) ? session.toolCalls : [];
  const taskName = String(session.taskName || '').trim();
  const { category } = classifyIntent(prompt, taskName, toolCalls);
  const { area, langs } = detectWorkType(toolCalls, `${prompt} ${taskName}`);
  const complexity = scoreComplexity(session, toolCalls, prompt);
  const specificity = scoreSpecificity(prompt);
  const ts = session.lastTime || session.archivedAt || session.startTime || Date.now();
  const durationMs = Number(session.duration)
    || (Number.isFinite(session.startTime) && Number.isFinite(session.lastTime)
      ? session.lastTime - session.startTime : 0);

  return {
    id: session.id,
    agent: session.agent || 'Unknown',
    ts,
    day: dayKey(ts),
    taskName: taskName.length > 72 ? `${taskName.slice(0, 71)}…` : taskName,
    category,
    area,
    langs,
    complexity,
    specificity,
    words: wordCount(prompt),
    tools: toolCalls.length,
    durationMs: Math.max(0, Math.round(durationMs))
  };
}

/**
 * Records for a session list (history + live, caller dedupes).
 * @returns {{ updatedAt: number, records: Array<object> }}
 */
function buildInsights(sessions) {
  const records = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    try {
      const rec = buildInsightRecord(s);
      if (rec) records.push(rec);
    } catch {
      // one malformed session must not sink the rest
    }
  }
  records.sort((a, b) => b.ts - a.ts);
  return { updatedAt: Date.now(), records };
}

module.exports = {
  classifyIntent,
  detectWorkType,
  scoreComplexity,
  scoreSpecificity,
  buildInsightRecord,
  buildInsights,
  bandFor,
  COMPLEXITY_BANDS,
  SPECIFICITY_BANDS,
  CATEGORY_IDS: CATEGORY_DEFS.map(d => d.id).concat(FALLBACK_CATEGORY)
};
