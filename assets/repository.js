import { b64encode } from './crypto.js';

export function staleRepositoryError() {
  const error = new Error('仓库已在其他页面更新。请刷新管理台并重新解锁后再操作；本次修改尚未保存。');
  error.code = 'STALE_REPOSITORY';
  return error;
}

// Save against the exact snapshot that the user decrypted. Never rebase a stale
// encrypted index onto newer data: its entries cannot be merged without decrypting.
export async function commitChanges(request, { owner, repo, branch, baseSha, message, entries }) {
  if (!baseSha) throw staleRepositoryError();
  const root = `/repos/${owner}/${repo}/git`;
  const ref = await request(`${root}/ref/heads/${branch}`);
  if (ref.object.sha !== baseSha) throw staleRepositoryError();
  const parent = await request(`${root}/commits/${baseSha}`);
  const treeEntries = [];
  for (const entry of entries) {
    let sha = null;
    if (!entry.delete) {
      const blob = await request(`${root}/blobs`, {
        method: 'POST', body: { content: b64encode(entry.bytes), encoding: 'base64' },
      });
      sha = blob.sha;
    }
    treeEntries.push({ path: entry.path, mode: '100644', type: 'blob', sha });
  }
  const tree = await request(`${root}/trees`, {
    method: 'POST', body: { base_tree: parent.tree.sha, tree: treeEntries },
  });
  const created = await request(`${root}/commits`, {
    method: 'POST', body: { message, tree: tree.sha, parents: [baseSha] },
  });
  try {
    await request(`${root}/refs/heads/${branch}`, {
      method: 'PATCH', body: { sha: created.sha, force: false },
    });
  } catch (error) {
    if (error.status === 409 || error.status === 422) throw staleRepositoryError();
    throw error;
  }
  return created;
}
