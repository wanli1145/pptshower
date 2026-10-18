import test from 'node:test';
import assert from 'node:assert/strict';
import { commitChanges } from '../assets/repository.js';
import { deriveKey, encryptJson, decryptJson, b64encode, randomBytes } from '../assets/crypto.js';

const options = {
  owner: 'example', repo: 'test-only', branch: 'main', baseSha: 'base', message: 'update',
  entries: [{ path: 'decks/index.enc', bytes: new Uint8Array([1, 2, 3]) }],
};
function mockRepository({ head = 'base', race = false, failure = null } = {}) {
  const calls = [];
  return {
    calls,
    request: async (path, options = {}) => {
      calls.push({ path, ...options });
      if (path.endsWith('/ref/heads/main')) return { object: { sha: head } };
      if (path.endsWith('/commits/base')) return { tree: { sha: 'original-tree' } };
      if (path.endsWith('/blobs')) return { sha: 'encrypted-blob' };
      if (path.endsWith('/trees')) return { sha: 'new-tree' };
      if (path.endsWith('/commits')) return { sha: 'new-commit' };
      if (path.endsWith('/refs/heads/main')) {
        if (failure) throw failure;
        if (race) throw Object.assign(new Error('Not a fast forward'), { status: 422 });
        return { object: { sha: 'new-commit' } };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
}
test('save uses the decrypted snapshot as parent and updates without force', async () => {
  const mock = mockRepository();
  const result = await commitChanges(mock.request, options);
  assert.equal(result.sha, 'new-commit');
  assert.deepEqual(mock.calls.find((call) => call.path.endsWith('/commits')).body.parents, ['base']);
  assert.deepEqual(mock.calls.at(-1).body, { sha: 'new-commit', force: false });
});
test('stale index is rejected before any blob or branch write', async () => {
  const mock = mockRepository({ head: 'other-admin-saved' });
  await assert.rejects(commitChanges(mock.request, options), { code: 'STALE_REPOSITORY' });
  assert.equal(mock.calls.length, 1);
});
test('concurrent update after the initial check fails without retrying stale data', async () => {
  const mock = mockRepository({ race: true });
  await assert.rejects(commitChanges(mock.request, options), { code: 'STALE_REPOSITORY' });
  assert.equal(mock.calls.filter((call) => call.method === 'PATCH').length, 1);
});
test('delete and new index are submitted together in a single tree', async () => {
  const mock = mockRepository();
  await commitChanges(mock.request, { ...options, entries: [...options.entries, { path: 'decks/12345678/slides.pdf.enc', delete: true }] });
  const tree = mock.calls.find((call) => call.path.endsWith('/trees')).body;
  assert.equal(tree.base_tree, 'original-tree');
  assert.equal(tree.tree.length, 2);
  assert.equal(tree.tree[1].sha, null);
});
test('authentication failures keep their original message and status', async () => {
  const failure = Object.assign(new Error('Forbidden'), { status: 403 });
  const mock = mockRepository({ failure });
  await assert.rejects(commitChanges(mock.request, options), (error) => error === failure);
});
test('missing snapshot cannot write repository data', async () => {
  const mock = mockRepository();
  await assert.rejects(commitChanges(mock.request, { ...options, baseSha: null }), { code: 'STALE_REPOSITORY' });
  assert.equal(mock.calls.length, 0);
});
test('encrypted Chinese index round-trips and rejects a wrong key or altered data', async () => {
  const salt = b64encode(randomBytes(16));
  const key = await deriveKey('test-only-passphrase', salt, 1000);
  const wrongKey = await deriveKey('incorrect-passphrase', salt, 1000);
  const data = { version: 1, decks: [{ id: '12345678', title: '课堂测试' }] };
  const encrypted = await encryptJson(key, data);
  assert.deepEqual(await decryptJson(key, encrypted), data);
  await assert.rejects(decryptJson(wrongKey, encrypted));
  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(decryptJson(key, encrypted));
});
