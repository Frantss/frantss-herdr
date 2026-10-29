import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadHistory, loadDetails, loadDiff } from './git.js';

const exec = promisify(execFile);

async function repository(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'herdr-git-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = async args => {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd: dir, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || error.message };
    }
  };
  const run = async (...args) => {
    const result = await git(args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await run('init', '-b', 'main');
  await run('config', 'user.name', 'Test Author');
  await run('config', 'user.email', 'test@example.com');
  const commit = async (message, files = {}) => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
    await run('add', '-A');
    await run('commit', '--allow-empty', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  return { dir, git, run, commit };
}

test('unborn and detached HEAD preserve the worktree identity', async t => {
  const { dir, git, run, commit } = await repository(t);
  const empty = await loadHistory(git);
  assert.equal(empty.root, dir);
  assert.equal(empty.branch, 'main');
  assert.equal(empty.head, null);
  assert.deepEqual(empty.commits, []);
  assert.equal(empty.hasMore, false);
  const hash = await commit('root');
  await run('checkout', '--detach', hash);
  const detached = await loadHistory(git);
  assert.equal(detached.branch, null);
  assert.equal(detached.head, hash);
  assert.ok(detached.commits[0].refs.some(ref => ref.name === 'HEAD'));
});

test('current and all history include every merge parent in topological order', async t => {
  const { git, run, commit } = await repository(t);
  const root = await commit('root');
  await run('checkout', '-b', 'feature');
  const feature = await commit('feature', { feature: 'feature\n' });
  await run('checkout', 'main');
  const main = await commit('main', { main: 'main\n' });
  await run('merge', '--no-ff', 'feature', '-m', 'merge');
  const merge = await run('rev-parse', 'HEAD');
  await run('tag', '-a', 'release', '-m', 'release');
  await run('tag', '-a', 'nested', 'release', '-m', 'nested');
  await run('update-ref', 'refs/remotes/origin/main', merge);
  await run('checkout', '-b', 'unmerged', root);
  const unmerged = await commit('unmerged');
  await run('checkout', 'main');
  const current = await loadHistory(git);
  assert.equal(current.commits.length, 4);
  assert.equal(current.commits[0].hash, merge);
  assert.deepEqual(current.commits[0].parents, [main, feature]);
  assert.equal(current.commits.at(-1).hash, root);
  assert.deepEqual(current.commits[0].refs.map(ref => ref.name).sort(), ['HEAD', 'main', 'nested', 'origin/main', 'release']);
  const all = await loadHistory(git, { scope: 'all' });
  assert.equal(all.commits.length, 5);
  assert.ok(all.commits.some(commit => commit.hash === unmerged));
  const rows = new Map(all.commits.map((commit, row) => [commit.hash, row]));
  for (const commit of all.commits) for (const parent of commit.parents) assert.ok(rows.get(parent) > rows.get(commit.hash));
  const details = await loadDetails(git, merge);
  assert.deepEqual(details.files.map(file => file.path), ['feature']);
  assert.match((await loadDiff(git, merge, details.parents, 'feature')).text, /\+feature/);
});

test('frozen prefix paging keeps the original tip and decorations after new commits', async t => {
  const { git, run, commit } = await repository(t);
  await commit('one');
  const two = await commit('two');
  const three = await commit('three');
  const first = await loadHistory(git, { limit: 1 });
  assert.equal(first.hasMore, true);
  assert.equal(first.commits[0].hash, three);
  assert.ok(Object.isFrozen(first.snapshot));
  assert.ok(Object.isFrozen(first.snapshot.refs));
  await commit('four');
  await run('tag', 'new-tag', two);
  const next = await loadHistory(git, { limit: 3, snapshot: first.snapshot });
  assert.equal(next.head, three);
  assert.deepEqual(next.commits.map(commit => commit.subject), ['three', 'two', 'one']);
  assert.equal(next.hasMore, false);
  assert.ok(next.commits[0].refs.some(ref => ref.name === 'main'));
  assert.ok(!next.commits[1].refs.some(ref => ref.name === 'new-tag'));
  assert.equal((await loadHistory(git)).commits[0].subject, 'four');
});

test('all-branch paging keeps deleted tips and excludes branches created after the snapshot', async t => {
  const { git, run, commit } = await repository(t);
  const root = await commit('root');
  await run('checkout', '-b', 'feature');
  const feature = await commit('feature');
  await run('checkout', 'main');
  const main = await commit('main');
  const first = await loadHistory(git, { scope: 'all', limit: 1 });
  await run('branch', '-D', 'feature');
  await run('checkout', '-b', 'later', root);
  const later = await commit('later');
  const next = await loadHistory(git, { scope: 'all', limit: 100, snapshot: first.snapshot });
  assert.deepEqual(new Set(next.commits.map(commit => commit.hash)), new Set([main, feature, root]));
  assert.deepEqual(next.commits.slice(0, 1), first.commits);
  assert.ok(next.commits.find(commit => commit.hash === feature).refs.some(ref => ref.name === 'feature'));
  assert.equal(next.head, main);
  assert.ok((await loadHistory(git, { scope: 'all' })).commits.some(commit => commit.hash === later));
});

test('reference decorations include commit tags and omit symbolic remote HEAD and non-commit tags', async t => {
  const { git, run, commit } = await repository(t);
  const hash = await commit('root', { file: 'content\n' });
  await run('tag', 'lightweight');
  await run('tag', 'tree-tag', `${hash}^{tree}`);
  await run('tag', '-a', 'annotated-tree', `${hash}^{tree}`, '-m', 'tree');
  await run('update-ref', 'refs/remotes/origin/main', hash);
  await run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const history = await loadHistory(git, { scope: 'all' });
  assert.equal(history.commits.length, 1);
  assert.deepEqual(history.commits[0].refs, [
    { name: 'HEAD', kind: 'head', isCurrent: true },
    { name: 'main', kind: 'head', isCurrent: true },
    { name: 'origin/main', kind: 'remote', isCurrent: false },
    { name: 'lightweight', kind: 'tag', isCurrent: false },
  ]);
});

test('merge details and diffs compare additions, changes and deletions with the first parent', async t => {
  const { dir, git, run, commit } = await repository(t);
  await commit('root', { shared: 'before\n', removed: 'remove me\n' });
  await run('checkout', '-b', 'feature');
  await rm(join(dir, 'removed'));
  await commit('feature', { shared: 'after\n', added: 'new file\n' });
  await run('checkout', 'main');
  const main = await commit('main', { 'main-only': 'main file\n' });
  await run('merge', '--no-ff', 'feature', '-m', 'merge');
  const merge = await run('rev-parse', 'HEAD');
  const details = await loadDetails(git, merge);
  assert.equal(details.parents[0], main);
  assert.deepEqual(details.files, [
    { path: 'added', oldPath: null, status: 'A', added: 1, removed: 0 },
    { path: 'removed', oldPath: null, status: 'D', added: 0, removed: 1 },
    { path: 'shared', oldPath: null, status: 'M', added: 1, removed: 1 },
  ]);
  assert.match((await loadDiff(git, merge, details.parents, 'added')).text, /\+new file/);
  assert.match((await loadDiff(git, merge, details.parents, 'removed')).text, /-remove me/);
  const shared = (await loadDiff(git, merge, details.parents, 'shared')).text;
  assert.match(shared, /-before/);
  assert.match(shared, /\+after/);
  assert.equal((await loadDiff(git, merge, details.parents, 'main-only')).text, '');
});

test('details and root diff preserve unusual paths, message control characters and binary status', async t => {
  const { git, commit } = await repository(t);
  const path = 'tab\tand\nnewline.txt';
  const hash = await commit('root\u001f subject\u001e\n\nbody\u001f preserved\u001e', { [path]: 'hello\n', binary: Buffer.from([0, 1, 2]) });
  const history = await loadHistory(git);
  assert.match(history.commits[0].subject, /\u001f subject\u001e/);
  const details = await loadDetails(git, hash);
  assert.deepEqual(details.parents, []);
  assert.match(details.body, /body\u001f preserved\u001e/);
  const file = details.files.find(file => file.path === path);
  assert.deepEqual(file, { path, oldPath: null, status: 'A', added: 1, removed: 0 });
  assert.equal(details.files.find(file => file.path === 'binary').added, null);
  assert.match((await loadDiff(git, hash, [], path)).text, /\+hello/);
  assert.equal((await loadDiff(git, hash, [], 'binary')).binary, true);
});

test('renamed files retain source path and stats and produce rename diffs', async t => {
  const { dir, git, run, commit } = await repository(t);
  await commit('root', { 'old\tname': 'one\ntwo\nthree\n' });
  await rename(join(dir, 'old\tname'), join(dir, 'new\nname'));
  await run('add', '-A');
  await run('commit', '-m', 'rename');
  const hash = await run('rev-parse', 'HEAD');
  const details = await loadDetails(git, hash);
  assert.deepEqual(details.files, [{ path: 'new\nname', oldPath: 'old\tname', status: 'R', added: 0, removed: 0 }]);
  const diff = await loadDiff(git, hash, details.parents, 'new\nname');
  assert.match(diff.text, /rename from/);
  assert.match(diff.text, /rename to/);
});

test('diff uses literal pathspecs and bounds displayed text', async t => {
  const { git, commit } = await repository(t);
  const path = ':(glob)*.txt';
  const hash = await commit('large root', { [path]: 'a'.repeat(45000) + '\n', 'other.txt': 'SECRET_OTHER_FILE\n' });
  const diff = await loadDiff(git, hash, [], path);
  assert.equal(diff.text.length, 30000);
  assert.equal(diff.truncated, true);
  assert.ok(!diff.text.includes('SECRET_OTHER_FILE'));
  await assert.rejects(loadDetails(git, '--all'), /Invalid commit hash/);
});

test('worktree snapshot cannot be reused for a different worktree', async t => {
  const { dir, git, run, commit } = await repository(t);
  await commit('root');
  const snapshot = (await loadHistory(git)).snapshot;
  const worktree = join(dir, 'other-worktree');
  await run('worktree', 'add', '-b', 'other', worktree);
  const worktreeGit = async args => {
    try { const result = await exec('git', args, { cwd: worktree }); return { code: 0, ...result }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  assert.equal((await loadHistory(worktreeGit)).root, worktree);
  await assert.rejects(loadHistory(worktreeGit, { snapshot }), /another worktree/);
  await assert.rejects(loadHistory(git, { scope: 'all', snapshot }), /scope/);
});

test('changed files expose their listing limit', async t => {
  const { dir, git, run } = await repository(t);
  const folder = join(dir, 'files');
  await mkdir(folder);
  await Promise.all(Array.from({ length: 1003 }, (_, index) => writeFile(join(folder, `file-${index}`), 'line\n')));
  await run('add', '-A');
  await run('commit', '-m', 'many files');
  const details = await loadDetails(git, await run('rev-parse', 'HEAD'));
  assert.equal(details.files.length, 1000);
  assert.equal(details.filesLimited, true);
});

test('git failures surface their diagnostic', async () => {
  await assert.rejects(loadHistory(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' })), /not a git repository/);
});
