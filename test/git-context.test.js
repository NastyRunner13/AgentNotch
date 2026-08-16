const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseHead,
  parseGitDirFile,
  worktreeNameFromGitDir,
  parseLocalPr,
  readGitContext,
  clearGitContextCache
} = require('../src/main/session/git-context');

describe('git-context parsers', () => {
  it('parseHead reads a branch ref or detached SHA', () => {
    assert.deepEqual(parseHead('ref: refs/heads/feat/oauth\n'), {
      branch: 'feat/oauth',
      detached: false
    });
    assert.deepEqual(parseHead('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n'), {
      branch: 'a1b2c3d',
      detached: true
    });
    assert.equal(parseHead(''), null);
  });

  it('parseGitDirFile and worktree name', () => {
    assert.equal(
      parseGitDirFile('gitdir: /repo/.git/worktrees/oauth-wt\n'),
      '/repo/.git/worktrees/oauth-wt'
    );
    assert.equal(
      worktreeNameFromGitDir('/repo/.git/worktrees/oauth-wt'),
      'oauth-wt'
    );
    assert.equal(worktreeNameFromGitDir('/repo/.git'), '');
  });

  it('parseLocalPr reads refs/pull/N from the matching branch section', () => {
    const cfg = `
[core]
	repositoryformatversion = 0
[branch "feat/oauth"]
	remote = origin
	merge = refs/pull/412/head
[branch "main"]
	merge = refs/heads/main
`;
    assert.equal(parseLocalPr(cfg, 'feat/oauth'), 412);
    assert.equal(parseLocalPr(cfg, 'main'), null);
  });
});

describe('readGitContext', () => {
  let root;

  beforeEach(() => {
    clearGitContextCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'an-git-'));
  });

  afterEach(() => {
    clearGitContextCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reads branch from a normal .git directory', () => {
    const git = path.join(root, '.git');
    fs.mkdirSync(git);
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/feat/oauth\n');
    fs.writeFileSync(path.join(git, 'config'), `[branch "feat/oauth"]\n\tmerge = refs/pull/99/head\n`);

    const ctx = readGitContext(root);
    assert.equal(ctx.branch, 'feat/oauth');
    assert.equal(ctx.pr, 99);
    assert.equal(ctx.worktree, undefined);
  });

  it('reads a worktree checkout (.git file)', () => {
    const repoGit = path.join(root, 'repo.git');
    const wtGit = path.join(repoGit, 'worktrees', 'oauth-wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(repoGit, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat/oauth\n');

    const checkout = path.join(root, 'oauth-wt');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${wtGit}\n`);

    const ctx = readGitContext(checkout);
    assert.equal(ctx.branch, 'feat/oauth');
    // worktree name matches folder basename → omitted
    assert.equal(ctx.worktree, undefined);
  });

  it('includes worktree when the folder name differs', () => {
    const repoGit = path.join(root, 'repo.git');
    const wtGit = path.join(repoGit, 'worktrees', 'oauth-wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feat/oauth\n');

    const checkout = path.join(root, 'some-checkout');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${wtGit}\n`);

    const ctx = readGitContext(checkout);
    assert.equal(ctx.branch, 'feat/oauth');
    assert.equal(ctx.worktree, 'oauth-wt');
  });

  it('returns null when cwd is not a git work tree', () => {
    assert.equal(readGitContext(root), null);
    assert.equal(readGitContext(''), null);
  });
});
