import {
  KDF_DEFAULT_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  SALT_BYTES,
  b64encode,
  decryptJson,
  deriveKey,
  encryptBytes,
  encryptJson,
  randomBytes,
} from '../assets/crypto.js';

const OWNER = 'wanli1145';
const REPO = 'pptshower';
const BRANCH = 'main';
const TOKEN_KEY = 'pptshower.pat';
const MAX_BYTES = 50 * 1024 * 1024;
const WARN_BYTES = 25 * 1024 * 1024;

const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const localOverride =
  LOCAL && typeof window.PPTSHOWER_API_BASE === 'string' && window.PPTSHOWER_API_BASE
    ? window.PPTSHOWER_API_BASE
    : '';
const API = (localOverride || 'https://api.github.com').replace(/\/+$/, '');
const KDF_ITERATIONS =
  LOCAL &&
  Number.isInteger(window.PPTSHOWER_KDF_ITERATIONS) &&
  window.PPTSHOWER_KDF_ITERATIONS >= 1000
    ? window.PPTSHOWER_KDF_ITERATIONS
    : KDF_DEFAULT_ITERATIONS;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  tokenCard: $('token-card'),
  tokenForm: $('token-form'),
  tokenInput: $('token-input'),
  tokenButton: $('token-button'),
  disconnectButton: $('disconnect-button'),
  authCard: $('auth-card'),
  authForm: $('auth-form'),
  adminPassphrase: $('admin-passphrase'),
  authButton: $('auth-button'),
  initCard: $('init-card'),
  initForm: $('init-form'),
  initPassphrase: $('init-passphrase'),
  initConfirm: $('init-confirm'),
  initError: $('init-error'),
  initButton: $('init-button'),
  manageCard: $('manage-card'),
  addForm: $('add-form'),
  addTitle: $('add-title'),
  addDate: $('add-date'),
  addFile: $('add-file'),
  addButton: $('add-button'),
  adminDeckList: $('admin-deck-list'),
  adminEmpty: $('admin-empty'),
  editDialog: $('edit-dialog'),
  editForm: $('edit-form'),
  editTitle: $('edit-title'),
  editDate: $('edit-date'),
  editCancel: $('edit-cancel'),
  editSave: $('edit-save'),
  replaceFile: $('replace-file'),
};

const state = {
  token: '',
  connected: false,
  key: null,
  salt: null,
  iterations: KDF_DEFAULT_ITERATIONS,
  decks: [],
  busy: false,
  editId: null,
  replaceId: null,
};

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function loadStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

function setStatus(message, kind) {
  el.status.hidden = !message;
  el.status.textContent = message || '';
  el.status.className = `status${kind ? ` ${kind}` : ''}`;
}

function setBusy(busy) {
  state.busy = busy;
  el.manageCard.classList.toggle('busy', busy);
  el.tokenButton.disabled = busy;
  el.authButton.disabled = busy;
  el.initButton.disabled = busy;
  el.editSave.disabled = busy;
  el.disconnectButton.disabled = busy;
}

function friendly(error) {
  const status = error && error.status;
  if (status === 401) return '令牌无效或已过期，请重新输入。';
  if (status === 403) {
    const detail =
      error.message && !/^403\b/.test(error.message) ? `（GitHub：${error.message}）` : '';
    return `令牌权限不足，或触发了 GitHub 的频率限制。请确认令牌的 Contents 权限是 Read and write。${detail}`;
  }
  if (status === 404) return '无法访问仓库，请确认令牌已授权 wanli1145/pptshower。';
  if (status === 409 || status === 422) return '仓库在操作期间发生了变化，请重试。';
  const message = error && error.message ? error.message : '未知错误';
  if (/failed to fetch|networkerror/i.test(message)) return '网络请求失败，请检查网络连接。';
  return message;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function responseError(response) {
  let message = `${response.status} ${response.statusText}`;
  try {
    const data = await response.json();
    if (data && data.message) message = data.message;
  } catch {
    /* not JSON */
  }
  const error = new Error(message);
  error.status = response.status;
  return error;
}

async function github(path, options = {}) {
  const headers = new Headers();
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  headers.set('Accept', options.accept || 'application/vnd.github+json');
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(options.body);
  }
  return fetch(`${API}${path}`, init);
}

async function githubJson(path, options = {}) {
  const response = await github(path, options);
  if (!response.ok) throw await responseError(response);
  return response.json();
}

async function readFileBytes(path) {
  const response = await github(
    `/repos/${OWNER}/${REPO}/contents/${encodePath(path)}?ref=${BRANCH}&t=${Date.now()}`,
    { accept: 'application/vnd.github.raw' }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response);
  return new Uint8Array(await response.arrayBuffer());
}

async function createBlob(bytes) {
  const result = await githubJson(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: { content: b64encode(bytes), encoding: 'base64' },
  });
  return result.sha;
}

async function commit(message, entries) {
  const prepared = [];
  for (const entry of entries) {
    if (entry.delete) {
      prepared.push({ path: entry.path, remove: true });
    } else {
      prepared.push({ path: entry.path, sha: await createBlob(entry.bytes) });
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ref = await githubJson(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
      const parentSha = ref.object.sha;
      const parent = await githubJson(`/repos/${OWNER}/${REPO}/git/commits/${parentSha}`);
      const tree = await githubJson(`/repos/${OWNER}/${REPO}/git/trees`, {
        method: 'POST',
        body: {
          base_tree: parent.tree.sha,
          tree: prepared.map((item) =>
            item.remove
              ? { path: item.path, mode: '100644', type: 'blob', sha: null }
              : { path: item.path, mode: '100644', type: 'blob', sha: item.sha }
          ),
        },
      });
      const created = await githubJson(`/repos/${OWNER}/${REPO}/git/commits`, {
        method: 'POST',
        body: { message, tree: tree.sha, parents: [parentSha] },
      });
      await githubJson(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
        method: 'PATCH',
        body: { sha: created.sha },
      });
      return created;
    } catch (error) {
      lastError = error;
      if (error.status !== 409 && error.status !== 422) throw error;
    }
  }
  throw lastError;
}

async function connect() {
  if (state.busy) return;
  setBusy(true);
  setStatus('正在连接仓库…');
  try {
    if (!state.token) throw new Error('请先输入令牌');
    const repo = await githubJson(`/repos/${OWNER}/${REPO}`);
    if (repo.permissions && repo.permissions.push === false) {
      throw new Error('令牌没有本仓库的写入权限');
    }

    state.connected = true;
    el.tokenCard.hidden = true;
    el.disconnectButton.hidden = false;
    el.tokenInput.value = '';

    const siteBytes = await readFileBytes('site.json');
    if (!siteBytes) {
      el.initCard.hidden = false;
      el.authCard.hidden = true;
      el.manageCard.hidden = true;
      setStatus('仓库已连接，但站点尚未初始化。');
      return;
    }

    const site = JSON.parse(decoder.decode(siteBytes));
    const kdf = site && site.kdf;
    if (!kdf || typeof kdf.salt !== 'string') {
      throw new Error('site.json 格式不正确');
    }
    state.salt = kdf.salt;
    state.iterations = Number(kdf.iterations) || KDF_DEFAULT_ITERATIONS;
    el.initCard.hidden = true;
    el.authCard.hidden = false;
    el.manageCard.hidden = true;
    setStatus('仓库已连接。输入总口令以管理课件。', 'ok');
  } catch (error) {
    state.connected = false;
    el.tokenCard.hidden = false;
    el.disconnectButton.hidden = true;
    setStatus(`连接失败：${friendly(error)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

function disconnect() {
  storeToken('');
  state.token = '';
  state.connected = false;
  state.key = null;
  state.salt = null;
  state.decks = [];
  state.editId = null;
  state.replaceId = null;
  if (el.editDialog.open) el.editDialog.close();
  el.tokenInput.value = '';
  el.adminPassphrase.value = '';
  el.disconnectButton.hidden = true;
  el.authCard.hidden = true;
  el.initCard.hidden = true;
  el.manageCard.hidden = true;
  el.tokenCard.hidden = false;
  el.adminDeckList.replaceChildren();
  el.adminEmpty.hidden = true;
  setStatus('已断开连接。');
}

function parseIndex(index) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.decks)) {
    throw new Error('课件索引格式不正确');
  }
  return index.decks
    .filter((deck) => deck && /^[a-f0-9]{8}$/.test(deck.id))
    .map((deck) => ({
      id: deck.id,
      title: typeof deck.title === 'string' ? deck.title : '',
      date: typeof deck.date === 'string' ? deck.date : '',
      rev: Number(deck.rev) || 0,
    }));
}

function currentIndex() {
  return {
    version: 1,
    decks: state.decks.map((deck) => ({
      id: deck.id,
      title: deck.title,
      date: deck.date,
      rev: deck.rev,
    })),
  };
}

async function authenticate(event) {
  event.preventDefault();
  if (state.busy || !state.connected) return;
  const passphrase = el.adminPassphrase.value;
  if (!passphrase) {
    setStatus('请输入总口令。', 'bad');
    return;
  }

  setBusy(true);
  setStatus('正在解密课件索引…');
  await tick();
  try {
    const bytes = await readFileBytes('decks/index.enc');
    if (!bytes) throw new Error('课件索引不存在');
    const key = await deriveKey(passphrase, state.salt, state.iterations);
    let index;
    try {
      index = await decryptJson(key, bytes);
    } catch {
      throw new Error('总口令不正确');
    }
    state.key = key;
    state.decks = parseIndex(index);
    el.adminPassphrase.value = '';
    el.authCard.hidden = true;
    el.manageCard.hidden = false;
    renderDecks();
    setStatus('已解锁，可以管理课件。', 'ok');
  } catch (error) {
    setStatus(friendly(error), 'bad');
    el.adminPassphrase.select();
  } finally {
    setBusy(false);
  }
}

function showInitError(message) {
  el.initError.textContent = message;
  el.initError.hidden = false;
}

async function initialize(event) {
  event.preventDefault();
  if (state.busy) return;
  const passphrase = el.initPassphrase.value;
  const confirmation = el.initConfirm.value;
  el.initError.hidden = true;

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    showInitError(`总口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符。`);
    return;
  }
  if (passphrase !== confirmation) {
    showInitError('两次输入的总口令不一致。');
    return;
  }
  if (!window.confirm('请确认已牢记总口令。忘记后所有课件都无法恢复。')) return;

  setBusy(true);
  setStatus('正在初始化站点…');
  await tick();
  try {
    const salt = b64encode(randomBytes(SALT_BYTES));
    const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
    const site = {
      version: 1,
      kdf: {
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations: KDF_ITERATIONS,
        salt,
      },
    };
    const index = { version: 1, decks: [] };
    await commit('admin: initialize site', [
      {
        path: 'site.json',
        bytes: encoder.encode(`${JSON.stringify(site, null, 2)}\n`),
      },
      { path: 'decks/index.enc', bytes: await encryptJson(key, index) },
    ]);

    state.key = key;
    state.salt = salt;
    state.iterations = KDF_ITERATIONS;
    state.decks = [];
    el.initForm.reset();
    el.initCard.hidden = true;
    el.manageCard.hidden = false;
    renderDecks();
    setStatus('站点已初始化。请把总口令保存在安全的地方。', 'ok');
  } catch (error) {
    setStatus(`初始化失败：${friendly(error)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

function assertPdf(bytes) {
  const magic = decoder.decode(bytes.subarray(0, 5));
  if (magic !== '%PDF-') throw new Error('请选择 PDF 文件');
}

function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uniqueDeckId() {
  for (;;) {
    const id = Array.from(randomBytes(4), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!state.decks.some((deck) => deck.id === id)) return id;
  }
}

function todayIso() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function addDeck(event) {
  event.preventDefault();
  if (state.busy || !state.key) return;
  const title = el.addTitle.value.trim();
  const date = el.addDate.value;
  const file = el.addFile.files[0];

  if (!title) {
    setStatus('请输入标题。', 'bad');
    return;
  }
  if (!file) {
    setStatus('请选择 PDF 文件。', 'bad');
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus(`文件超过 ${formatSize(MAX_BYTES)} 的上限。`, 'bad');
    return;
  }
  if (
    file.size > WARN_BYTES &&
    !window.confirm(`文件约 ${formatSize(file.size)}，加密和上传可能需要一些时间。继续吗？`)
  ) {
    return;
  }

  setBusy(true);
  setStatus('正在加密并上传…');
  await tick();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertPdf(bytes);
    const id = uniqueDeckId();
    const index = currentIndex();
    index.decks.push({ id, title, date, rev: Date.now() });
    const encrypted = await encryptBytes(state.key, bytes);
    const indexBytes = await encryptJson(state.key, index);
    await commit(`admin: add deck ${id}`, [
      { path: `decks/${id}/slides.pdf.enc`, bytes: encrypted },
      { path: 'decks/index.enc', bytes: indexBytes },
    ]);
    state.decks = index.decks;
    el.addForm.reset();
    el.addDate.value = todayIso();
    renderDecks();
    setStatus(`已添加《${title}》。`, 'ok');
  } catch (error) {
    setStatus(`上传失败：${friendly(error)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

function requestReplace(id) {
  if (state.busy) return;
  state.replaceId = id;
  el.replaceFile.value = '';
  el.replaceFile.click();
}

async function replaceDeck(id, file) {
  const deck = state.decks.find((item) => item.id === id);
  if (!deck || !state.key) return;
  if (file.size > MAX_BYTES) {
    setStatus(`文件超过 ${formatSize(MAX_BYTES)} 的上限。`, 'bad');
    return;
  }
  if (
    file.size > WARN_BYTES &&
    !window.confirm(`文件约 ${formatSize(file.size)}，加密和上传可能需要一些时间。继续吗？`)
  ) {
    return;
  }

  setBusy(true);
  setStatus(`正在替换《${deck.title}》…`);
  await tick();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertPdf(bytes);
    const encrypted = await encryptBytes(state.key, bytes);
    const index = currentIndex();
    const target = index.decks.find((item) => item.id === id);
    if (!target) throw new Error('课件不在索引中');
    target.rev = Date.now();
    const indexBytes = await encryptJson(state.key, index);
    await commit(`admin: update deck ${id}`, [
      { path: `decks/${id}/slides.pdf.enc`, bytes: encrypted },
      { path: 'decks/index.enc', bytes: indexBytes },
    ]);
    state.decks = index.decks;
    renderDecks();
    setStatus(`已替换《${deck.title}》的 PDF。`, 'ok');
  } catch (error) {
    setStatus(`替换失败：${friendly(error)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

function openEdit(id) {
  if (state.busy) return;
  const deck = state.decks.find((item) => item.id === id);
  if (!deck) return;
  state.editId = id;
  el.editTitle.value = deck.title;
  el.editDate.value = deck.date;
  el.editDialog.showModal();
  el.editTitle.focus();
}

async function saveEdit(event) {
  event.preventDefault();
  if (state.busy || !state.key) return;
  const id = state.editId;
  const title = el.editTitle.value.trim();
  if (!id || !title) return;

  setBusy(true);
  setStatus('正在保存…');
  await tick();
  try {
    const index = currentIndex();
    const target = index.decks.find((item) => item.id === id);
    if (!target) throw new Error('课件不在索引中');
    target.title = title;
    target.date = el.editDate.value;
    const indexBytes = await encryptJson(state.key, index);
    await commit(`admin: update deck ${id}`, [
      { path: 'decks/index.enc', bytes: indexBytes },
    ]);
    state.decks = index.decks;
    state.editId = null;
    el.editDialog.close();
    renderDecks();
    setStatus(`已更新《${title}》。`, 'ok');
  } catch (error) {
    setStatus(`保存失败：${friendly(error)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

async function deleteDeck(id) {
  if (state.busy || !state.key) return;
  const deck = state.decks.find((item) => item.id === id);
  if (!deck) return;
  if (!window.confirm(`确定删除《${deck.title}》？删除后无法恢复。`)) return;

  setBusy(true);
  setStatus('正在删除…');
  await tick();
  try {
    const index = currentIndex();
    index.decks = index.decks.filter((item) => item.id !== id);
    const indexBytes = await encryptJson(state.key, index);
    await commit(`admin: delete deck ${id}`, [
      { path: 'decks/index.enc', bytes: indexBytes },
      { path: `decks/${id}/slides.pdf.enc`, delete: true },
    ]);
    state.decks = index.decks;
    renderDecks();
    setStatus(`已删除《${deck.title}》。`, 'ok');
  } catch (error) {
    setStatus(`删除失败：${friendly(error)}`, 'bad');
  } finally {
    setBusy(false);
  }
}

function makeButton(label, onClick, extra = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button ghost${extra ? ` ${extra}` : ''}`;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderDecks() {
  el.adminDeckList.replaceChildren();
  const decks = state.decks.slice().sort((a, b) => {
    const byDate = (b.date || '').localeCompare(a.date || '');
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });

  for (const deck of decks) {
    const row = document.createElement('div');
    row.className = 'deck-row';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = deck.title;
    title.title = deck.title;

    const date = document.createElement('div');
    date.className = 'date';
    date.textContent = deck.date || '';

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      makeButton('编辑', () => openEdit(deck.id)),
      makeButton('替换 PDF', () => requestReplace(deck.id)),
      makeButton('删除', () => deleteDeck(deck.id), 'danger')
    );

    row.append(title, date, actions);
    el.adminDeckList.appendChild(row);
  }

  el.adminEmpty.hidden = decks.length > 0;
}

function bindEvents() {
  el.tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = el.tokenInput.value.trim();
    if (!token) {
      setStatus('请输入令牌。', 'bad');
      return;
    }
    storeToken(token);
    state.token = token;
    connect();
  });
  el.authForm.addEventListener('submit', authenticate);
  el.initForm.addEventListener('submit', initialize);
  el.addForm.addEventListener('submit', addDeck);
  el.editForm.addEventListener('submit', saveEdit);
  el.editCancel.addEventListener('click', () => {
    state.editId = null;
    el.editDialog.close();
  });
  el.disconnectButton.addEventListener('click', disconnect);

  el.replaceFile.addEventListener('change', () => {
    const id = state.replaceId;
    const file = el.replaceFile.files[0];
    el.replaceFile.value = '';
    state.replaceId = null;
    if (id && file) replaceDeck(id, file);
  });
}

function boot() {
  bindEvents();
  el.addDate.value = todayIso();
  const token = loadStoredToken();
  if (token) {
    state.token = token;
    connect();
  } else {
    el.tokenCard.hidden = false;
  }
}

boot();
