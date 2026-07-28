const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyIntent,
  detectWorkType,
  scoreComplexity,
  scoreSpecificity,
  buildInsightRecord,
  buildInsights,
  bandFor,
  COMPLEXITY_BANDS,
  SPECIFICITY_BANDS,
  CATEGORY_IDS
} = require('../src/main/insights');

describe('insights: intent classification', () => {
  const cat = (prompt, toolCalls = [], taskName = '') => classifyIntent(prompt, taskName, toolCalls).category;

  it('classifies bug fixes', () => {
    assert.equal(cat('fix the auth bug in middleware'), 'bugfix');
    assert.equal(cat('the settings page crashes when I toggle sound'), 'bugfix');
    assert.equal(cat('debug why the watcher is not working'), 'bugfix');
  });

  it('classifies testing', () => {
    assert.equal(cat('add unit tests for the parser'), 'testing');
    assert.equal(cat('improve coverage of the session utils with vitest'), 'testing');
  });

  it('fix-beats-test only when the verb is fixing', () => {
    assert.equal(cat('fix failing tests'), 'bugfix');
    assert.equal(cat('add tests for the failing parser'), 'testing');
  });

  it('classifies refactors — verb outranks domain nouns', () => {
    assert.equal(cat('refactor database connections to use a singleton pool'), 'refactor');
    assert.equal(cat('clean up the watcher code without changing behavior'), 'refactor');
  });

  it('classifies architecture', () => {
    assert.equal(cat('design the system architecture for the plugin API'), 'architecture');
    assert.equal(cat('scaffold a new monorepo project structure'), 'architecture');
  });

  it('classifies devops', () => {
    assert.equal(cat('set up the github actions deploy pipeline'), 'devops');
    assert.equal(cat('publish a new release to vercel'), 'devops');
  });

  it('classifies styling', () => {
    assert.equal(cat('make the settings page responsive on mobile'), 'styling');
    assert.equal(cat('redesign the session card layout'), 'styling');
  });

  it('classifies data work', () => {
    assert.equal(cat('write a migration for the users table'), 'data');
    assert.equal(cat('add an index to speed up the postgres query'), 'data');
    assert.equal(cat('analyze the user engagement data'), 'data');
    assert.equal(cat('run the backtest for midcap stocks'), 'data');
  });

  it('classifies performance', () => {
    assert.equal(cat('optimize the bundle size, the settings page is slow'), 'performance');
    assert.equal(cat('profile the memory leak in the renderer'), 'performance');
  });

  it('classifies security', () => {
    assert.equal(cat('sanitize user inputs to prevent xss'), 'security');
    assert.equal(cat('encrypt the stored credentials'), 'security');
  });

  it('classifies docs', () => {
    assert.equal(cat('update the readme with setup steps'), 'docs');
    assert.equal(cat('write a changelog entry for the release'), 'docs');
  });

  it('classifies review and exploration', () => {
    assert.equal(cat('review my changes for edge cases'), 'review');
    assert.equal(cat('what do you think of my current project'), 'review');
    assert.equal(cat('critique the implementation approach'), 'review');
    assert.equal(cat('how does the watcher detect sessions?'), 'exploration');
    assert.equal(cat('explain the dispatch flow'), 'exploration');
    assert.equal(cat('how much memory does the app use'), 'exploration');
    assert.equal(cat('what is the current version'), 'exploration');
  });

  it('classifies features', () => {
    assert.equal(cat('add a new endpoint for session export'), 'feature');
    assert.equal(cat('add email and password validation to register router'), 'feature');
    assert.equal(cat('upgrade the auth module to v2'), 'feature');
    assert.equal(cat('set up the project configuration'), 'feature');
  });

  it('generic verbs do not amplify: domain objects own the intent', () => {
    // "create ... add ..." is one weak feature signal; the migration owns it
    assert.equal(cat('create a migration to add email column to users'), 'data');
    // changelog writing is docs even though a "release" is mentioned
    assert.equal(cat('write a changelog entry for the release'), 'docs');
    // dark mode is UI theming work
    assert.equal(cat('implement dark mode support'), 'styling');
  });

  it('falls back to general for empty or noise prompts', () => {
    assert.equal(cat('hello'), 'general');
    assert.equal(cat('ok'), 'general');
    assert.equal(cat(''), 'general');
  });

  it('uses tool-call signals: repeated test runs point at testing', () => {
    assert.equal(cat('work on the parser', ['run(npm test)', 'run(npm test -- parser)']), 'testing');
  });

  it('a single incidental test run does not flip intent', () => {
    // "look at the" triggers review; the point is npm test didn't flip it to testing
    assert.equal(cat('look at the changes and give me a commit strategy', ['run_terminal_command: "git status"', 'run_terminal_command: "npm test"']), 'review');
  });

  it('uses file-extension signals: writing markdown supports docs', () => {
    assert.equal(cat('update the project files', ['Write(guide.md)', 'Edit(docs/intro.mdx)']), 'docs');
  });

  it('covers every documented category id', () => {
    for (const id of CATEGORY_IDS) {
      assert.ok(typeof id === 'string' && id.length > 0);
    }
    assert.ok(CATEGORY_IDS.includes('general'));
  });
});

describe('insights: work type detection', () => {
  it('detects frontend from tsx/css tool calls', () => {
    const { area, langs } = detectWorkType(['Edit(src/app.tsx)', 'Edit(styles/main.css)'], '');
    assert.equal(area, 'frontend');
    assert.deepEqual(langs.slice(0, 2), ['TypeScript', 'CSS']);
  });

  it('detects backend from python tool calls', () => {
    const { area, langs } = detectWorkType(['Edit(api/server.py)'], '');
    assert.equal(area, 'backend');
    assert.deepEqual(langs, ['Python']);
  });

  it('detects fullstack when frontend and backend files mix', () => {
    const { area } = detectWorkType(['Edit(web/app.tsx)', 'Edit(api/routes.py)'], '');
    assert.equal(area, 'fullstack');
  });

  it('falls back to prompt hints when there are no file signals', () => {
    assert.equal(detectWorkType([], 'fix the react component rendering').area, 'frontend');
    assert.equal(detectWorkType([], 'the api endpoint returns 500').area, 'backend');
    assert.equal(detectWorkType([], 'update the postgres schema').area, 'data');
  });

  it('detects docs from markdown edits', () => {
    assert.equal(detectWorkType(['Edit(README.md)'], '').area, 'docs');
  });

  it('returns general with no signals', () => {
    assert.equal(detectWorkType(['run(npm test)'], 'add tests').area, 'general');
  });
});

describe('insights: task complexity', () => {
  it('scores a trivial prompt-only session as simple', () => {
    const score = scoreComplexity({ duration: 30000 }, [], 'fix it');
    assert.equal(bandFor(score, COMPLEXITY_BANDS), 'simple');
  });

  it('scores a long, tool-heavy, planned session as deep', () => {
    const tools = [];
    const names = ['Read', 'Edit', 'Bash', 'Grep', 'Write', 'Search', 'List', 'MultiEdit'];
    for (let i = 0; i < 30; i++) tools.push(`${names[i % names.length]}(file${i % 5}.${['ts', 'py', 'css', 'md', 'sql'][i % 5]})`);
    const score = scoreComplexity(
      { duration: 45 * 60000, plan: [{}, {}, {}, {}, {}, {}] },
      tools,
      'a '.repeat(70)
    );
    assert.equal(score, 100);
    assert.equal(bandFor(score, COMPLEXITY_BANDS), 'deep');
  });

  it('mid-range session lands in the expected band', () => {
    const tools = [
      'Read(a.ts)', 'Read(b.ts)', 'Read(c.md)', 'Edit(d.py)', 'Edit(e.py)',
      'Edit(f.py)', 'Bash(npm test)', 'Bash(ls)', 'Grep(foo)', 'Grep(bar)'
    ];
    const score = scoreComplexity({ duration: 12 * 60000 }, tools, 'update the parser and its tests');
    // dur 22 (<20m) + tools 17 + distinct 8 + exts 6 + words 4 = 57
    assert.equal(score, 57);
    assert.equal(bandFor(score, COMPLEXITY_BANDS), 'complex');
  });

  it('clamps to 0..100', () => {
    assert.ok(scoreComplexity({}, [], '') >= 0);
    assert.ok(scoreComplexity({ duration: 1e9 }, [], '') <= 100);
  });
});

describe('insights: prompt specificity', () => {
  it('scores terse context-free prompts as vague', () => {
    assert.equal(bandFor(scoreSpecificity('fix it'), SPECIFICITY_BANDS), 'vague');
    assert.equal(bandFor(scoreSpecificity('update the code'), SPECIFICITY_BANDS), 'vague');
  });

  it('scores scoped prompts with tech terms as clear', () => {
    const score = scoreSpecificity('fix the auth bug in middleware');
    // 6 words → 20, terms auth+middleware → 8, scope bonus → 8 = 36
    assert.equal(score, 36);
    assert.equal(bandFor(score, SPECIFICITY_BANDS), 'clear');
  });

  it('scores detailed prompts with paths, identifiers and expectations as precise', () => {
    const prompt = 'Update src/auth/middleware.ts to validate JWT tokens before calling next(); '
      + 'currently expired tokens return 200 instead of 401, which should be unauthorized';
    const score = scoreSpecificity(prompt);
    assert.ok(score >= 65, `expected precise, got ${score}`);
    assert.equal(bandFor(score, SPECIFICITY_BANDS), 'precise');
  });

  it('rewards structure and file references', () => {
    const plain = scoreSpecificity('change the config values');
    const detailed = scoreSpecificity('1. open config/settings.json\n2. set pollInterval to 5000\n3. keep the rest unchanged');
    assert.ok(detailed > plain);
  });

  it('empty prompt scores zero', () => {
    assert.equal(scoreSpecificity(''), 0);
    assert.equal(scoreSpecificity(null), 0);
  });
});

describe('insights: record building', () => {
  it('skips sessions without a real prompt', () => {
    assert.equal(buildInsightRecord({ id: 'x-1', agent: 'Cursor', userPrompt: '' }), null);
    assert.equal(buildInsightRecord({ id: 'x-2', agent: 'Cursor' }), null);
    assert.equal(buildInsightRecord(null), null);
  });

  it('builds a complete record from a session', () => {
    const rec = buildInsightRecord({
      id: 'claude-abc',
      agent: 'Claude Code',
      taskName: 'fix auth bug',
      userPrompt: 'fix the auth bug in middleware',
      toolCalls: ['Read(src/auth/middleware.ts)', 'Edit(src/auth/middleware.ts)'],
      duration: 1620000,
      lastTime: 1700000000000
    });
    assert.equal(rec.id, 'claude-abc');
    assert.equal(rec.agent, 'Claude Code');
    assert.equal(rec.category, 'bugfix');
    assert.equal(rec.area, 'backend');
    assert.deepEqual(rec.langs, ['TypeScript']);
    assert.equal(rec.ts, 1700000000000);
    assert.equal(rec.words, 6);
    assert.equal(rec.tools, 2);
    assert.ok(rec.complexity > 0 && rec.complexity <= 100);
    assert.ok(rec.specificity > 0 && rec.specificity <= 100);
    assert.match(rec.day, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('strips xml-ish wrappers from prompts before scoring', () => {
    const rec = buildInsightRecord({
      id: 'grok-1',
      agent: 'Grok',
      userPrompt: '<user_query>\nrefactor the auth middleware to validate tokens\n</user_query>'
    });
    assert.equal(rec.category, 'refactor');
  });

  it('buildInsights sorts newest first and tolerates bad entries', () => {
    const { records } = buildInsights([
      { id: 'a', agent: 'Codex', userPrompt: 'add tests', lastTime: 1000 },
      null,
      { id: 'b', agent: 'Codex', userPrompt: 'fix the crash', lastTime: 3000 },
      { id: 'c', agent: 'Codex', userPrompt: '', lastTime: 2000 }
    ]);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(r => r.id), ['b', 'a']);
  });
});
