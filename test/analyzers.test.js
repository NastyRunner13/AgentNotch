const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeClaudeEntries } = require('../src/main/watchers/claude-watcher');
const { analyzeCodexEntries } = require('../src/main/watchers/codex-watcher');
const { analyzeGrokEntries } = require('../src/main/watchers/grok-watcher');
const { analyzeAntigravityEntries } = require('../src/main/watchers/antigravity-watcher');
const { analyzeOpencodeSession } = require('../src/main/watchers/opencode-watcher');
const { extractTaskName, parseJSONL, formatDuration } = require('../src/main/watchers/base-watcher');
const { getText, normalizePlan } = require('../src/main/watchers/session-utils');
const { collectUsageLimits } = require('../src/main/usage-limits');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fileTimes = { startTime: 1_000, lastTime: 2_000 };

describe('base helpers', () => {
  it('extractTaskName truncates and strips tags', () => {
    assert.equal(extractTaskName('<USER>Fix the auth bug please</USER>'), 'Fix the auth bug please');
    assert.ok(extractTaskName('a'.repeat(100)).endsWith('…'));
  });

  it('parseJSONL skips bad lines', () => {
    const entries = parseJSONL('{"a":1}\nnot-json\n{"b":2}\n');
    assert.equal(entries.length, 2);
  });

  it('formatDuration', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(120000), '2m');
    assert.equal(formatDuration(3660000), '1h 1m');
  });

  it('getText and normalizePlan', () => {
    assert.equal(getText([{ text: 'hi' }, { text: 'there' }]), 'hi\nthere');
    assert.deepEqual(normalizePlan(['step one', { title: 'two', status: 'completed' }]), [
      { step: 'step one', status: 'pending' },
      { step: 'two', status: 'completed' }
    ]);
  });
});

describe('Codex rate limit + model', () => {
  it('extracts model and rate_limits from token_count', () => {
    const entries = [
      {
        timestamp: '2026-07-18T11:12:16.375Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-terra', cwd: '/tmp' }
      },
      {
        timestamp: '2026-07-18T11:14:09.663Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 39902 },
            model_context_window: 258400
          },
          rate_limits: {
            plan_type: 'go',
            primary: {
              used_percent: 10,
              window_minutes: 43200,
              resets_at: 1786965143
            }
          }
        }
      },
      {
        timestamp: '2026-07-18T11:14:09.786Z',
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'All set.' }
      }
    ];
    const result = analyzeCodexEntries(entries, 'c1', '', fileTimes);
    assert.equal(result.model, 'gpt-5.6-terra');
    assert.ok(result.rateLimit);
    assert.equal(result.rateLimit.usedPercent, 10);
    assert.equal(result.rateLimit.planType, 'go');
    assert.equal(result.status, 'idle');
    assert.ok(String(result.lastMessage).includes('All set'));
  });
});

describe('Claude analyzer', () => {
  it('detects working tool use and task name', () => {
    const entries = [
      { type: 'human', message: 'Fix the auth bug', timestamp: '2024-01-01T00:00:00Z' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking at middleware' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/x/middleware.ts' } }
          ]
        },
        timestamp: '2024-01-01T00:01:00Z'
      }
    ];
    const result = analyzeClaudeEntries(entries, '', fileTimes);
    assert.equal(result.taskName, 'Fix the auth bug');
    assert.equal(result.status, 'working');
    assert.ok(result.currentTool.includes('Edit'));
  });

  it('detects permission request', () => {
    const entries = [
      {
        type: 'permission_request',
        tool: 'Bash',
        input: { command: 'rm -rf /' },
        file_path: ''
      }
    ];
    const result = analyzeClaudeEntries(entries, '', fileTimes);
    assert.equal(result.status, 'permission-request');
    assert.equal(result.permissionRequest.tool, 'Bash');
  });

  it('marks idle on end_turn', () => {
    const entries = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' }
      }
    ];
    const result = analyzeClaudeEntries(entries, '', fileTimes);
    assert.equal(result.status, 'idle');
  });
});

describe('Codex analyzer', () => {
  it('extracts user prompt and tool call', () => {
    const entries = [
      { role: 'user', content: 'Add unit tests' },
      {
        role: 'assistant',
        content: 'Working',
        tool_calls: [{ function: { name: 'shell' } }]
      }
    ];
    const result = analyzeCodexEntries(entries, 'codex-1', '', fileTimes);
    assert.equal(result.taskName, 'Add unit tests');
    assert.equal(result.status, 'working');
    assert.equal(result.currentTool, 'shell');
  });
});

describe('Grok analyzer', () => {
  it('uses summary title and tool events (legacy shape)', () => {
    const entries = [
      { type: 'user_message', content: 'hello' },
      { type: 'tool_call', name: 'read_file' }
    ];
    const result = analyzeGrokEntries(entries, 'g1', '', fileTimes, 'My Grok Task');
    assert.equal(result.taskName, 'My Grok Task');
    assert.equal(result.status, 'working');
    assert.ok(result.toolCalls.includes('read_file'));
  });

  it('parses ACP session/update tool_call and user_message_chunk', () => {
    const entries = [
      {
        timestamp: 1784375339,
        method: 'session/update',
        params: {
          sessionId: 'abc',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'fix the notch autohide' }
          }
        }
      },
      {
        timestamp: 1784375341,
        method: 'session/update',
        params: {
          sessionId: 'abc',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Looking at the watcher next.' }
          }
        }
      },
      {
        timestamp: 1784375342,
        method: 'session/update',
        params: {
          sessionId: 'abc',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'run_terminal_command',
            rawInput: { command: 'npm test', description: 'Run unit tests' },
            _meta: {
              'x.ai/tool': { name: 'run_terminal_command', label: 'Run Command' }
            }
          }
        }
      }
    ];
    const result = analyzeGrokEntries(entries, 'g1', '', fileTimes, '');
    assert.equal(result.taskName, 'fix the notch autohide');
    assert.equal(result.status, 'working');
    assert.ok(result.userPrompt.includes('autohide'));
    assert.ok(result.lastMessage.includes('watcher'));
    assert.ok(result.toolCalls.includes('run_terminal_command'));
    assert.ok(String(result.currentTool).includes('run_terminal_command'));
    assert.ok(String(result.currentTool).includes('npm test'));
  });
});

describe('Grok events analyzer', () => {
  const { analyzeGrokEvents, analyzeGrokEntries, analyzeChatHistory, mergeGrokStatus } = require('../src/main/watchers/grok-watcher');

  it('maps tool_started and permission phases', () => {
    const working = analyzeGrokEvents([
      { type: 'phase_changed', phase: 'tool_execution' },
      { type: 'tool_started', tool_name: 'read_file' }
    ]);
    assert.equal(working.status, 'working');
    assert.equal(working.currentTool, 'read_file');

    const perm = analyzeGrokEvents([
      { type: 'phase_changed', phase: 'permission_prompt' },
      { type: 'permission_requested', tool_name: 'run_terminal_command' }
    ]);
    assert.equal(perm.status, 'permission-request');
    assert.equal(perm.permissionRequest.tool, 'run_terminal_command');
  });

  it('marks idle on turn_ended (Grok events.jsonl name)', () => {
    const done = analyzeGrokEvents([
      { type: 'turn_started' },
      { type: 'phase_changed', phase: 'streaming_text' },
      { type: 'tool_started', tool_name: 'read_file' },
      { type: 'tool_completed', tool_name: 'read_file' },
      { type: 'phase_changed', phase: 'streaming_text' },
      { type: 'turn_ended', outcome: 'completed' }
    ]);
    assert.equal(done.status, 'idle');
    assert.equal(done.currentTool, null);
    assert.equal(done.turnComplete, true);
  });

  it('captures model_id from turn_started', () => {
    const state = analyzeGrokEvents([
      { type: 'turn_started', model_id: 'grok-4.5' },
      { type: 'phase_changed', phase: 'waiting_for_model' }
    ]);
    assert.equal(state.model, 'grok-4.5');
    assert.equal(state.status, 'working');
  });

  it('treats streaming_text as working mid-turn', () => {
    const mid = analyzeGrokEvents([
      { type: 'turn_started' },
      { type: 'phase_changed', phase: 'streaming_text' }
    ]);
    assert.equal(mid.status, 'working');
    assert.ok(String(mid.currentTool || mid.phaseLabel).includes('Responding') || mid.phase === 'streaming_text');
  });

  it('marks idle on ACP turn_completed in updates stream', () => {
    const entries = [
      {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'All done with the refactor.' }
          }
        }
      },
      {
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            stop_reason: 'end_turn'
          }
        }
      }
    ];
    const result = analyzeGrokEntries(entries, 'g1', '', fileTimes, '');
    assert.equal(result.status, 'idle');
    assert.equal(result.turnComplete, true);
    assert.ok(result.lastMessage.includes('refactor'));
  });

  it('captures agent_thought_chunk into activity as thinking', () => {
    const entries = [
      {
        timestamp: 1784471756,
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'The user wants fuller thinking in the notch feed. ' }
          }
        }
      },
      {
        timestamp: 1784471758,
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'I will surface thought chunks next to tools.' }
          }
        }
      },
      {
        timestamp: 1784471760,
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call',
            title: 'read_file',
            rawInput: { target_file: 'src/renderer/components/session-card.js' },
            _meta: { 'x.ai/tool': { name: 'read_file' } }
          }
        }
      },
      {
        timestamp: 1784471762,
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Thinking is now in the live activity feed.' }
          }
        }
      }
    ];
    const result = analyzeGrokEntries(entries, 'g1', '', fileTimes, '');
    assert.equal(result.status, 'working');
    assert.ok(
      (result.recentThoughts || []).some(t => String(t.text || t).includes('fuller thinking')),
      'expected recentThoughts to include thought text'
    );
    const thinkingRows = (result.activity || []).filter(a => a.kind === 'thinking');
    assert.ok(thinkingRows.length >= 1, 'expected thinking activity rows');
    assert.ok(thinkingRows.some(a => a.text.includes('fuller thinking') || a.text.includes('thought chunks')));
    assert.ok((result.activity || []).some(a => a.kind === 'message' && a.text.includes('live activity')));
    assert.ok((result.activity || []).some(a => a.kind === 'file' || (a.tool && String(a.tool).includes('read'))));
  });

  it('parses chat_history assistant text and user_query', () => {
    const chat = analyzeChatHistory([
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nFix the notch\n</user_query>' }] },
      { type: 'assistant', content: '', tool_calls: [{ name: 'read_file' }] },
      { type: 'assistant', content: 'I fixed the slide animation in index.js.' }
    ]);
    assert.equal(chat.userPrompt, 'Fix the notch');
    assert.ok(chat.lastMessage.includes('slide animation'));
    assert.ok(chat.toolCalls.includes('read_file'));
  });

  it('merge prefers idle when either source completed the turn', () => {
    const merged = mergeGrokStatus({
      eventState: {
        status: 'working',
        currentTool: 'todo_write',
        turnComplete: false
      },
      updateState: {
        status: 'idle',
        currentTool: null,
        turnComplete: true,
        permissionRequest: null
      },
      isActive: true
    });
    assert.equal(merged.status, 'idle');
    assert.equal(merged.currentTool, null);

    const fromEvents = mergeGrokStatus({
      eventState: {
        status: 'idle',
        currentTool: null,
        turnComplete: true
      },
      updateState: {
        status: 'working',
        currentTool: 'read_file',
        turnComplete: false,
        permissionRequest: null
      },
      isActive: true
    });
    assert.equal(fromEvents.status, 'idle');
  });
});

describe('Antigravity analyzer', () => {
  it('detects USER_INPUT and tool calls', () => {
    const entries = [
      { type: 'USER_INPUT', content: 'refactor database layer', created_at: '2024-01-01T00:00:00Z' },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Editing client',
        tool_calls: [{ name: 'Write', arguments: { TargetFile: '/db/client.ts' } }],
        created_at: '2024-01-01T00:01:00Z'
      }
    ];
    const result = analyzeAntigravityEntries(entries, 'a1', 'conv', '', fileTimes);
    assert.equal(result.taskName, 'refactor database layer');
    assert.equal(result.status, 'working');
    assert.ok(result.currentTool.includes('Write'));
  });

  it('marks needs-attention on ERROR', () => {
    const entries = [{ type: 'SYSTEM', status: 'ERROR' }];
    const result = analyzeAntigravityEntries(entries, 'a1', 'conv', '', fileTimes);
    assert.equal(result.status, 'needs-attention');
  });
});

describe('Usage limits', () => {
  it('reads Grok creditUsagePercent from unified log', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notch-usage-'));
    try {
      const logDir = path.join(tmp, '.grok', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const line = JSON.stringify({
        ts: '2026-07-18T12:07:49.732Z',
        msg: 'billing: fetched credits config',
        ctx: {
          subscriptionTier: 'X Premium',
          config: {
            creditUsagePercent: 22,
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-07-15T02:57:29.752425+00:00',
              end: '2026-07-22T02:57:29.752425+00:00'
            }
          }
        }
      });
      fs.writeFileSync(path.join(logDir, 'unified.jsonl'), line + '\n');

      const usage = await collectUsageLimits({
        home: tmp,
        sessions: [{ agent: 'Grok', model: 'grok-4.5' }]
      });
      const grok = usage.find(u => u.id === 'grok');
      assert.ok(grok);
      assert.equal(grok.available, true);
      assert.equal(grok.usedPercent, 22);
      assert.equal(grok.remainingPercent, 78);
      assert.equal(grok.model, 'grok-4.5');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prefers Codex rateLimit from live sessions', async () => {
    const usage = await collectUsageLimits({
      home: path.join(os.tmpdir(), 'agent-notch-no-home'),
      sessions: [{
        agent: 'Codex',
        model: 'gpt-5.6-terra',
        rateLimit: {
          usedPercent: 41,
          planType: 'go',
          updatedAt: Date.now()
        }
      }]
    });
    const codex = usage.find(u => u.id === 'codex');
    assert.ok(codex);
    assert.equal(codex.available, true);
    assert.equal(codex.usedPercent, 41);
    assert.equal(codex.model, 'gpt-5.6-terra');
  });
});

describe('OpenCode analyzer', () => {
  const now = Date.now();
  // Mirrors the real opencode.db schema verified against a live install:
  // session.model = {"id":...,"providerID":...}, token/cost columns, ms epochs
  const baseSession = {
    id: 'ses_07f90e00effemsC1YABbM76Wxn',
    title: 'Fix auth bug',
    model: JSON.stringify({ id: 'kimi-k3', providerID: 'opencode-go' }),
    cost: 0.742,
    tokens_input: 92027,
    tokens_output: 3450,
    tokens_reasoning: 6908,
    tokens_cache_read: 1037056,
    tokens_cache_write: 0,
    time_created: now - 120_000,
    time_updated: now - 1_000
  };
  const userMsg = {
    id: 'msg_user1',
    time_created: now - 119_000,
    data: JSON.stringify({ role: 'user' })
  };
  const assistantMsg = {
    id: 'msg_asst1',
    time_created: now - 60_000,
    data: JSON.stringify({ role: 'assistant' })
  };

  it('detects working state from running tool part (state.input shape)', () => {
    const parts = [
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 2_000,
        data: JSON.stringify({
          type: 'tool',
          tool: 'bash',
          callID: 'bash_1',
          state: { status: 'running', input: { command: 'npm test' } }
        })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [userMsg, assistantMsg], parts, now);
    assert.equal(result.status, 'working');
    assert.equal(result.currentTool, 'bash: npm test');
    assert.equal(result.agent, 'OpenCode');
  });

  it('detects idle state from step-finish with reason=stop', () => {
    const parts = [
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 5_000,
        data: JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'npm test' } } })
      },
      {
        id: 'prt_2',
        message_id: 'msg_asst1',
        time_created: now - 1_000,
        data: JSON.stringify({ type: 'step-finish', reason: 'stop' })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [], parts, now);
    assert.equal(result.status, 'idle');
    assert.equal(result.currentTool, null);
  });

  it('stays working on step-finish with reason=tool-calls (multi-step turn)', () => {
    const parts = [
      {
        id: 'prt_0',
        message_id: 'msg_asst1',
        time_created: now - 6_000,
        data: JSON.stringify({ type: 'step-start' })
      },
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 5_000,
        data: JSON.stringify({ type: 'reasoning', text: 'I should run the tests first' })
      },
      {
        id: 'prt_2',
        message_id: 'msg_asst1',
        time_created: now - 3_000,
        data: JSON.stringify({
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'npm test' } }
        })
      },
      {
        id: 'prt_3',
        message_id: 'msg_asst1',
        time_created: now - 1_000,
        data: JSON.stringify({ type: 'step-finish', reason: 'tool-calls' })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [assistantMsg], parts, now);
    assert.equal(result.status, 'working', 'tool-calls step-finish must not mark the turn complete');
  });

  it('stays working while streaming reasoning / assistant text', () => {
    const parts = [
      {
        id: 'prt_0',
        message_id: 'msg_asst1',
        time_created: now - 3_000,
        data: JSON.stringify({ type: 'step-start' })
      },
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 2_000,
        data: JSON.stringify({ type: 'reasoning', text: 'thinking about the approach…' })
      },
      {
        id: 'prt_2',
        message_id: 'msg_asst1',
        time_created: now - 500,
        data: JSON.stringify({ type: 'text', text: 'I will inspect the auth middleware next.' })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [assistantMsg], parts, now);
    assert.equal(result.status, 'working');
    assert.equal(result.lastMessage, 'I will inspect the auth middleware next.');
  });

  it('only goes idle after the final step-finish stop in a multi-step run', () => {
    const parts = [
      {
        id: 'prt_0',
        message_id: 'msg_asst1',
        time_created: now - 10_000,
        data: JSON.stringify({ type: 'step-start' })
      },
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 9_000,
        data: JSON.stringify({ type: 'reasoning', text: 'need files' })
      },
      {
        id: 'prt_2',
        message_id: 'msg_asst1',
        time_created: now - 8_000,
        data: JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'a.js' } } })
      },
      {
        id: 'prt_3',
        message_id: 'msg_asst1',
        time_created: now - 7_000,
        data: JSON.stringify({ type: 'step-finish', reason: 'tool-calls' })
      },
      {
        id: 'prt_4',
        message_id: 'msg_asst1',
        time_created: now - 6_000,
        data: JSON.stringify({ type: 'step-start' })
      },
      {
        id: 'prt_5',
        message_id: 'msg_asst1',
        time_created: now - 5_000,
        data: JSON.stringify({ type: 'text', text: 'Here is the summary of the auth flow.' })
      },
      {
        id: 'prt_6',
        message_id: 'msg_asst1',
        time_created: now - 1_000,
        data: JSON.stringify({ type: 'step-finish', reason: 'stop' })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [assistantMsg], parts, now);
    assert.equal(result.status, 'idle');
    assert.equal(result.lastMessage, 'Here is the summary of the auth flow.');
  });

  it('uses session title as taskName', () => {
    const result = analyzeOpencodeSession(baseSession, [], [], now);
    assert.equal(result.taskName, 'Fix auth bug');
  });

  it('falls back to first user text part when title is empty', () => {
    const session = { ...baseSession, title: '' };
    const parts = [
      {
        id: 'prt_0',
        message_id: 'msg_user1',
        time_created: now - 118_000,
        data: JSON.stringify({ type: 'text', text: 'refactor the auth middleware to validate tokens' })
      }
    ];
    const result = analyzeOpencodeSession(session, [userMsg], parts, now);
    // extractTaskName truncates to 40 chars with ellipsis
    assert.equal(result.taskName, 'refactor the auth middleware to validat…');
  });

  it('extracts model from JSON session.model field', () => {
    const result = analyzeOpencodeSession(baseSession, [], [], now);
    assert.equal(result.model, 'kimi-k3');
  });

  it('surfaces tokens and cost from the session row', () => {
    const result = analyzeOpencodeSession(baseSession, [], [], now);
    assert.deepEqual(result.tokens, {
      input: 92027,
      output: 3450,
      reasoning: 6908,
      cacheRead: 1037056,
      cacheWrite: 0
    });
    assert.equal(result.cost, 0.742);
  });

  it('builds an activity timeline with kinds and part timestamps', () => {
    const parts = [
      {
        id: 'prt_0',
        message_id: 'msg_user1',
        time_created: now - 118_000,
        data: JSON.stringify({ type: 'text', text: 'please run the tests' })
      },
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 60_000,
        data: JSON.stringify({ type: 'reasoning', text: 'thinking about the failure' })
      },
      {
        id: 'prt_2',
        message_id: 'msg_asst1',
        time_created: now - 30_000,
        data: JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' } } })
      },
      {
        id: 'prt_3',
        message_id: 'msg_asst1',
        time_created: now - 5_000,
        data: JSON.stringify({ type: 'text', text: 'All tests pass now.' })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [userMsg, assistantMsg], parts, now);
    assert.equal(result.activity.length, 4);
    assert.equal(result.activity[0].kind, 'message');
    assert.equal(result.activity[1].kind, 'thinking');
    assert.equal(result.activity[2].kind, 'terminal');
    assert.equal(result.activity[2].at, now - 30_000);
    assert.equal(result.activity[3].kind, 'message');
    // Last assistant text becomes lastMessage for the status line
    assert.equal(result.lastMessage, 'All tests pass now.');
  });

  it('demotes working to idle when update is stale', () => {
    const staleMs = 5_000;
    const staleNow = now + 10_000; // simulate 10s passing after last update
    const parts = [
      {
        id: 'prt_1',
        message_id: 'msg_asst1',
        time_created: now - 2_000,
        data: JSON.stringify({ type: 'tool', tool: 'grep', state: { status: 'running', input: {} } })
      }
    ];
    const result = analyzeOpencodeSession(baseSession, [], parts, staleNow, staleMs);
    assert.equal(result.status, 'idle', 'should demote working to idle when stale');
  });
});
