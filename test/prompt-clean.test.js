const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanPrompt,
  isSubstantive,
  preferUserPrompt,
  promptWasInjected
} = require('../src/main/prompt-clean');

describe('prompt-clean', () => {
  it('extracts USER_REQUEST / user_query inner text', () => {
    assert.equal(
      cleanPrompt('<USER_REQUEST>fix the auth bug</USER_REQUEST> <ADDITIONAL_METADATA>cwd=/tmp</ADDITIONAL_METADATA>'),
      'fix the auth bug'
    );
    assert.equal(
      cleanPrompt('<user_query>\nrefactor the watcher\n</user_query>'),
      'refactor the watcher'
    );
  });

  it('drops Codex plugin catalogs and AGENTS.md dumps', () => {
    assert.equal(cleanPrompt('<recommended_plugins> Here is a list of plugins that are available but not installed.'), '');
    assert.equal(cleanPrompt('# AGENTS.md instructions for C:\\dev\\app\n<INSTRUCTIONS> Stay calm'), '');
  });

  it('treats yes/ok as non-substantive', () => {
    assert.equal(isSubstantive('yes'), false);
    assert.equal(isSubstantive('ok'), false);
    assert.equal(isSubstantive('fix the auth bug in middleware'), true);
  });

  it('preferUserPrompt keeps last substantive turn', () => {
    let p = preferUserPrompt('', '<recommended_plugins> Here is a list of plugins');
    assert.equal(p, '');
    p = preferUserPrompt(p, 'show the usage chart');
    assert.equal(p, 'show the usage chart');
    p = preferUserPrompt(p, 'ok');
    assert.equal(p, 'show the usage chart');
    p = preferUserPrompt(p, 'also add a cost footnote');
    assert.equal(p, 'also add a cost footnote');
  });

  it('flags injected harness wrappers', () => {
    assert.equal(promptWasInjected('<USER_REQUEST>hi</USER_REQUEST> <ADDITIONAL_METADATA>' + 'x'.repeat(200)), true);
    assert.equal(promptWasInjected('fix the auth bug in middleware'), false);
  });
});
