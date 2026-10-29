const commitFields = '%H%x00%P%x00%an%x00%ae%x00%at%x00%s';
const hashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const fileLimit = 1000;
const diffLimit = 30000;
export const PAGE_SIZE = 25;

async function run(git, args) {
  const result = await git(['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args]);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || `git ${args[0]} failed (${result.code})`);
  return result.stdout;
}

function validHash(hash) {
  if (!hashPattern.test(hash)) throw new Error('Invalid commit hash.');
  return hash;
}

function metadata(fields) {
  const [hash, parents, author, email, date] = fields;
  return { hash, parents: parents ? parents.split(' ') : [], author, email, date: Number(date) };
}

async function readSnapshot(git, scope, root) {
  const [headResult, branchResult, refsOutput] = await Promise.all([
    git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']),
    git(['symbolic-ref', '-q', '--short', 'HEAD']),
    run(git, ['for-each-ref', '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(refname)%00%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']),
  ]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const refs = [];
  for (const line of refsOutput.split('\n').filter(Boolean)) {
    const [object, type, peeled, peeledType, full, name] = line.split('\0');
    if (full.startsWith('refs/remotes/') && full.endsWith('/HEAD')) continue;
    let hash = type === 'commit' ? object : peeledType === 'commit' ? peeled : null;
    if (!hash && type === 'tag' && peeledType === 'tag') {
      const resolved = await git(['rev-parse', '--verify', '-q', `${full}^{commit}`]);
      if (resolved.code === 0) hash = resolved.stdout.trim();
    }
    if (!hash) continue;
    const kind = full.startsWith('refs/heads/') ? 'head' : full.startsWith('refs/remotes/') ? 'remote' : 'tag';
    refs.push(Object.freeze({ hash, name, kind, isCurrent: kind === 'head' && name === branch }));
  }
  if (head) refs.unshift(Object.freeze({ hash: head, name: 'HEAD', kind: 'head', isCurrent: true }));
  const tips = scope === 'all' ? [...new Set(refs.map(ref => ref.hash))] : head ? [head] : [];
  return Object.freeze({ root, head, branch, scope, refs: Object.freeze(refs), tips: Object.freeze(tips) });
}

export async function loadHistory(git, { scope = 'current', limit = PAGE_SIZE, snapshot = null } = {}) {
  if (scope !== 'current' && scope !== 'all') throw new Error('Unknown history scope.');
  const root = (await run(git, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  if (snapshot && (snapshot.root !== root || snapshot.scope !== scope)) throw new Error('History snapshot belongs to another worktree or scope.');
  snapshot ??= await readSnapshot(git, scope, root);
  limit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || PAGE_SIZE)));
  const byHash = new Map();
  for (const { hash, ...ref } of snapshot.refs) {
    byHash.set(hash, [...(byHash.get(hash) || []), ref]);
  }
  let commits = [];
  if (snapshot.tips.length) {
    const output = await run(git, ['log', '--topo-order', '-z', `--max-count=${limit + 1}`, `--format=${commitFields}`, ...snapshot.tips.map(validHash), '--']);
    const fields = output.split('\0');
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const values = fields.slice(i, i + 6);
      commits.push({ ...metadata(values), subject: values[5], refs: byHash.get(values[0]) || [] });
    }
  }
  return { root, head: snapshot.head, branch: snapshot.branch, commits: commits.slice(0, limit), hasMore: commits.length > limit, snapshot };
}

function treeArgs(hash, parents) {
  return parents[0] ? [validHash(parents[0]), validHash(hash)] : ['--root', validHash(hash)];
}

function parseFiles(namesOutput, statsOutput) {
  const names = namesOutput.split('\0');
  const files = [];
  for (let i = 0; i < names.length && names[i];) {
    const status = names[i++];
    const paired = /^[RC]/.test(status);
    const oldPath = paired ? names[i++] : null;
    const path = names[i++];
    if (path === undefined) break;
    files.push({ path, oldPath, status: status[0], added: null, removed: null });
  }
  const stats = new Map();
  const tokens = statsOutput.split('\0');
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = token.slice(0, firstTab);
    const removed = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    if (!path) { i++; path = tokens[i++]; }
    stats.set(path, { added: added === '-' ? null : Number(added), removed: removed === '-' ? null : Number(removed) });
  }
  return files.map(file => ({ ...file, ...stats.get(file.path) }));
}

export async function loadDetails(git, hash) {
  const output = await run(git, ['show', '-s', `--format=${commitFields.replace('%s', '%B')}`, validHash(hash), '--']);
  const fields = output.split('\0');
  const details = metadata(fields);
  const args = ['diff-tree', '-r', '-M', '--no-ext-diff', '--no-textconv', '--no-commit-id', '-z'];
  const [names, stats] = await Promise.all([
    run(git, [...args, '--name-status', ...treeArgs(details.hash, details.parents), '--']),
    run(git, [...args, '--numstat', ...treeArgs(details.hash, details.parents), '--']),
  ]);
  const files = parseFiles(names, stats);
  return { ...details, body: fields.slice(5).join('\0').replace(/\n$/, ''), files: files.slice(0, fileLimit), filesLimited: files.length > fileLimit };
}

export async function loadDiff(git, hash, parents, path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid file path.');
  const text = await run(git, ['diff-tree', '-p', '-M', '--follow', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--no-color', '--unified=3', ...treeArgs(hash, parents), '--', path]);
  return { text: text.slice(0, diffLimit), truncated: text.length > diffLimit, binary: /^Binary files .* differ$/m.test(text) || text.includes('GIT binary patch') };
}
