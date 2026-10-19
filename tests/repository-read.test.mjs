import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRepositoryFile } from '../assets/repository.js';
import { deriveKey, encryptJson, decryptJson } from '../assets/crypto.js';

const options = { owner: 'example', repo: 'test', ref: 'fixed-snapshot', path: 'decks/index.enc' };
function fixture(bytes, override = {}) {
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const calls = [];
  const converted = Buffer.from(Buffer.from(bytes).toString('utf16le'), 'utf8');
  return {
    calls, converted,
    request: async (path) => {
      calls.push(path);
      if (path.includes('/contents/')) {
        return { type: 'file', sha, size: bytes.length, encoding: 'base64', content: converted.toString('base64') };
      }
      assert.equal(path, `/repos/example/test/git/blobs/${sha}`);
      return { sha, size: bytes.length, encoding: 'base64', content: Buffer.from(bytes).toString('base64'), ...override };
    },
  };
}

test('transcoded Contents payload is ignored; original blob decrypts with the same passphrase', async () => {
  const key = await deriveKey('test-only-passphrase', Buffer.alloc(16, 7).toString('base64'), 1000);
  const index = { version: 1, decks: [{ id: '12345678', title: '课件管理测试' }] };
  const bytes = await encryptJson(key, index);
  const mock = fixture(bytes);
  await assert.rejects(decryptJson(key, mock.converted));
  const loaded = await readRepositoryFile(mock.request, options);
  assert.deepEqual(loaded, bytes);
  assert.deepEqual(await decryptJson(key, loaded), index);
  assert.equal(mock.calls[0], '/repos/example/test/contents/decks/index.enc?ref=fixed-snapshot');
});

test('binary data including invalid UTF-8 and odd lengths survives without text decoding', async () => {
  const bytes = new Uint8Array([0x0a, 0xe0, 0x2f, 0x3f, 0xa2, 0x67, 0x32, 0x05, 0xf5, 0xcd, 0x9a, 0xc6, 0xff]);
  assert.deepEqual(await readRepositoryFile(fixture(bytes).request, options), bytes);
});

test('missing Contents file means uninitialized; permission and missing blob failures propagate', async () => {
  const missing = Object.assign(new Error('Not found'), { status: 404 });
  assert.equal(await readRepositoryFile(async () => { throw missing; }, options), null);
  const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(readRepositoryFile(async () => { throw forbidden; }, options), (e) => e === forbidden);
  const mock = fixture(new Uint8Array([1, 2, 3]));
  await assert.rejects(readRepositoryFile(async (path) => {
    if (path.includes('/git/blobs/')) throw missing;
    return mock.request(path);
  }, options), (e) => e === missing);
});

test('truncated or incorrectly encoded blob fails before decryption', async () => {
  const bytes = new Uint8Array([0, 255, 128]);
  for (const override of [{ content: 'AA==' }, { encoding: 'utf-8' }, { content: '!' }, { sha: 'other-blob' }]) {
    await assert.rejects(readRepositoryFile(fixture(bytes, override).request, options), /仓库文件/);
  }
});

test('configuration JSON uses the same byte-preserving reader', async () => {
  const site = { version: 1, kdf: { salt: 'example', iterations: 600000 } };
  const bytes = new TextEncoder().encode(JSON.stringify(site));
  const loaded = await readRepositoryFile(fixture(bytes).request, { ...options, path: 'site.json' });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(loaded)), site);
});
