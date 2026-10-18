import {
  KDF_DEFAULT_ITERATIONS,
  decryptBytes,
  decryptJson,
  deriveKey,
} from './crypto.js';

let pdfLibraryPromise;
function loadPdfLibrary() {
  if (!pdfLibraryPromise) {
    pdfLibraryPromise = import('./vendor/pdfjs/pdf.min.mjs').then((library) => {
      library.GlobalWorkerOptions.workerSrc = new URL(
        './vendor/pdfjs/pdf.worker.min.mjs', import.meta.url
      ).toString();
      return library;
    }).catch((error) => {
      pdfLibraryPromise = null;
      throw error;
    });
  }
  return pdfLibraryPromise;
}

const PDF_OPTIONS = {
  cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).toString(),
  cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).toString(),
  wasmUrl: new URL('./vendor/pdfjs/wasm/', import.meta.url).toString(),
  isEvalSupported: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  unlockView: $('unlock-view'),
  unlockForm: $('unlock-form'),
  unlockMessage: $('unlock-message'),
  unlockError: $('unlock-error'),
  unlockButton: $('unlock-button'),
  passphrase: $('passphrase'),
  uninitializedNote: $('uninitialized-note'),
  listView: $('list-view'),
  search: $('deck-search'),
  sort: $('deck-sort'),
  noResults: $('no-results'),
  clearSearch: $('clear-search'),
  navCount: $('nav-count'),
  gridView: $('grid-view'),
  rowsView: $('rows-view'),
  togglePassphrase: $('toggle-passphrase'),
  listSubtitle: $('list-subtitle'),
  deckList: $('deck-list'),
  emptyList: $('empty-list'),
  lockButton: $('lock-button'),
  viewer: $('viewer-view'),
  viewerView: $('viewer-view'),
  stage: $('viewer-stage'),
  pageWrap: $('page-wrap'),
  canvas: $('page-canvas'),
  overlay: $('annotation-overlay'),
  viewerLoading: $('viewer-loading'),
  viewerError: $('viewer-error'),
  backButton: $('back-button'),
  viewerTitle: $('viewer-title'),
  prevButton: $('prev-button'),
  nextButton: $('next-button'),
  pageInput: $('page-input'),
  pageTotal: $('page-total'),
  overviewButton: $('overview-button'),
  fullscreenButton: $('fullscreen-button'),
  overview: $('overview'),
  overviewClose: $('overview-close'),
  thumbGrid: $('thumb-grid'),
};

const state = {
  salt: null,
  iterations: KDF_DEFAULT_ITERATIONS,
  key: null,
  decks: [],
  deck: null,
  page: 1,
  pendingPage: 1,
  total: 0,
  pdf: null,
  loadingTask: null,
  deckToken: 0,
  renderToken: 0,
  renderTask: null,
  overviewOpen: false,
  thumbGeneration: 0,
  thumbObserver: null,
  thumbItems: [],
  thumbPending: [],
  thumbActive: 0,
  resizeTimer: null,
  idleTimer: null,
  suppressClick: false,
  initialized: false,
};

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function fetchFresh(path) {
  return fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
}

function showOnly(view) {
  const changed = view.hidden;
  el.unlockView.hidden = view !== el.unlockView;
  el.listView.hidden = view !== el.listView;
  el.viewerView.hidden = view !== el.viewerView;
  if (changed) window.scrollTo(0, 0);
}

function clearUnlockError() {
  el.unlockError.hidden = true;
  el.unlockError.textContent = '';
}

function showUnlockError(message) {
  el.unlockError.textContent = message;
  el.unlockError.hidden = false;
}

function setUnlockBusy(busy) {
  el.unlockButton.disabled = busy;
  el.passphrase.disabled = busy;
  el.unlockButton.textContent = busy ? '正在解锁…' : '解锁课件库';
}

function showUnlock() {
  showOnly(el.unlockView);
  el.unlockMessage.textContent = '输入总口令，开启今天的课堂。';
  el.uninitializedNote.hidden = true;
  el.passphrase.disabled = false;
  el.unlockButton.disabled = false;
  el.unlockButton.textContent = '解锁课件库';
  clearUnlockError();
  document.title = 'pptshower';
}

function showUninitialized() {
  showUnlock();
  el.unlockMessage.textContent = '欢迎使用！先设置总口令，再添加你的第一套课件。';
  el.passphrase.disabled = true;
  el.unlockButton.disabled = true;
  el.uninitializedNote.hidden = false;
}

function showList() {
  showOnly(el.listView);
  renderDeckList();
  document.title = 'pptshower';
  armIdle();
}

function renderDeckList() {
  const query = el.search.value.trim().toLocaleLowerCase();
  const sort = el.sort.value;
  const decks = state.decks.filter((deck) => deck.title.toLocaleLowerCase().includes(query));
  decks.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id);
    const byDate = (b.date || '').localeCompare(a.date || '');
    return (sort === 'oldest' ? -byDate : byDate) || a.id.localeCompare(b.id);
  });
  const fragment = document.createDocumentFragment();
  for (const [index, deck] of decks.entries()) {
    const link = document.createElement('a');
    link.className = 'deck';
    link.href = `#/deck/${deck.id}/1`;
    link.setAttribute('aria-label', `展示课件：${deck.title || '未命名课件'}`);
    const cover = document.createElement('div');
    cover.className = 'deck-cover';
    cover.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'cover-label';
    label.textContent = `CLASSROOM / ${String(index + 1).padStart(2, '0')}`;
    const coverTitle = document.createElement('span');
    coverTitle.className = 'cover-title';
    coverTitle.textContent = deck.title || '未命名课件';
    const rule = document.createElement('span');
    rule.className = 'cover-rule';
    cover.append(label, coverTitle, rule);
    const info = document.createElement('div');
    info.className = 'deck-info';
    const title = document.createElement('h2');
    title.textContent = deck.title || '未命名课件';
    title.title = title.textContent;
    const meta = document.createElement('div');
    meta.className = 'deck-meta';
    const date = document.createElement('span');
    date.className = 'deck-date';
    date.textContent = deck.date || '未设置日期';
    const action = document.createElement('span');
    action.className = 'deck-action';
    action.textContent = '开始展示 ↗';
    meta.append(date, action);
    info.append(title, meta);
    link.append(cover, info);
    fragment.appendChild(link);
  }
  el.deckList.replaceChildren(fragment);
  el.emptyList.hidden = state.decks.length > 0;
  el.noResults.hidden = state.decks.length === 0 || decks.length > 0;
  el.navCount.textContent = String(state.decks.length);
  el.listSubtitle.textContent = query
    ? `找到 ${decks.length} 套课件，共 ${state.decks.length} 套`
    : `共 ${state.decks.length} 套课件，准备好开始下一次分享。`;
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

async function boot() {
  bindEvents();
  try {
    const response = await fetchFresh('site.json');
    if (response.status === 404) {
      showUninitialized();
      return;
    }
    if (!response.ok) throw new Error('无法读取站点配置');
    const site = await response.json();
    const kdf = site && site.kdf;
    if (!kdf || typeof kdf.salt !== 'string') {
      throw new Error('站点配置格式不正确');
    }
    state.salt = kdf.salt;
    state.iterations = Number(kdf.iterations) || KDF_DEFAULT_ITERATIONS;
    state.initialized = true;
    showUnlock();
    if (location.hash) route();
  } catch (error) {
    showUnlock();
    showUnlockError(`站点配置读取失败：${error.message}`);
  }
}

async function unlock(event) {
  event.preventDefault();
  if (!state.initialized) return;
  const passphrase = el.passphrase.value;
  if (!passphrase) {
    showUnlockError('请输入总口令');
    return;
  }

  setUnlockBusy(true);
  await tick();
  try {
    const key = await deriveKey(passphrase, state.salt, state.iterations);
    const response = await fetchFresh('decks/index.enc');
    if (!response.ok) {
      throw new Error(
        response.status === 404 ? '课件索引不存在，请先到管理台初始化。' : '无法读取课件索引'
      );
    }
    const encrypted = new Uint8Array(await response.arrayBuffer());
    let index;
    try {
      index = await decryptJson(key, encrypted);
    } catch {
      throw new Error('总口令不正确');
    }
    state.decks = parseIndex(index);
    state.key = key;
    el.passphrase.value = '';
    clearUnlockError();
    route();
  } catch (error) {
    showUnlockError(error.message || '解锁失败');
    el.passphrase.select();
  } finally {
    setUnlockBusy(false);
  }
}

function lock() {
  state.key = null;
  state.decks = [];
  el.search.value = '';
  el.deckList.replaceChildren();
  el.navCount.textContent = '0';
  el.passphrase.type = 'password';
  el.togglePassphrase.textContent = '显示';
  el.togglePassphrase.setAttribute('aria-label', '显示总口令');
  el.togglePassphrase.setAttribute('aria-pressed', 'false');
  teardownViewer();
  history.replaceState(null, '', location.pathname + location.search);
  showUnlock();
  el.passphrase.value = '';
  el.passphrase.focus();
}

function route() {
  if (!state.key) {
    if (!state.initialized) { showUninitialized(); return; }
    showUnlock();
    return;
  }
  const match = /^#\/deck\/([a-f0-9]{8})(?:\/(\d+))?$/.exec(location.hash);
  if (match) {
    openDeck(match[1], Number(match[2] || 1));
    return;
  }
  teardownViewer();
  showList();
}

async function openDeck(id, pageNumber) {
  const deck = state.decks.find((item) => item.id === id);
  if (!deck) {
    history.replaceState(null, '', location.pathname + location.search);
    teardownViewer();
    showList();
    return;
  }

  showOnly(el.viewerView);
  if (state.deck && state.deck.id === id) {
    if (state.pdf) {
      await setPage(pageNumber);
    } else {
      state.pendingPage = pageNumber;
    }
    return;
  }

  await loadDeck(deck, pageNumber);
}

async function loadDeck(deck, startPage) {
  teardownPdf();
  state.deck = deck;
  state.page = 1;
  state.pendingPage = startPage;
  state.total = 0;
  el.viewerTitle.textContent = deck.title;
  document.title = `${deck.title} · pptshower`;
  setViewerError(null);
  setLoading(true, '正在解密课件…');
  el.pageWrap.hidden = true;
  updatePageUi();

  const token = ++state.deckToken;
  try {
    const response = await fetch(`decks/${deck.id}/slides.pdf.enc?v=${deck.rev}`);
    if (!response.ok) throw new Error('无法读取课件文件');
    const encrypted = new Uint8Array(await response.arrayBuffer());
    const bytes = await decryptBytes(state.key, encrypted);
    if (token !== state.deckToken) return;

    setLoading(true, '正在打开课件…');
    const pdfjsLib = await loadPdfLibrary();
    if (token !== state.deckToken) return;
    const task = pdfjsLib.getDocument({ data: bytes, ...PDF_OPTIONS });
    state.loadingTask = task;
    const pdf = await task.promise;
    if (token !== state.deckToken) {
      task.destroy();
      return;
    }

    state.pdf = pdf;
    state.total = pdf.numPages;
    setLoading(false);
    updatePageUi();
    await setPage(state.pendingPage || 1);
  } catch (error) {
    if (token !== state.deckToken) return;
    setLoading(false);
    setViewerError(`课件加载失败：${error.message || '未知错误'}`);
  }
}

function teardownPdf() {
  state.deckToken += 1;
  state.renderToken += 1;
  closeOverview();
  if (state.renderTask) {
    try {
      state.renderTask.cancel();
    } catch {
      /* already finished */
    }
    state.renderTask = null;
  }
  const document = state.pdf;
  state.pdf = null;
  if (state.loadingTask) {
    state.loadingTask.destroy();
    state.loadingTask = null;
  } else if (document && document.loadingTask) {
    document.loadingTask.destroy();
  }
  state.total = 0;
  state.page = 1;
  state.pendingPage = 1;
  state.thumbGeneration += 1;
  state.thumbPending = [];
  el.overlay.replaceChildren();
  el.canvas.width = 0;
  el.canvas.height = 0;
}

function teardownViewer() {
  teardownPdf();
  state.deck = null;
  clearTimeout(state.idleTimer);
  el.viewer.classList.remove('controls-hidden');
  el.viewerView.hidden = true;
  el.overview.hidden = true;
  state.overviewOpen = false;
}

function setLoading(show, text) {
  el.viewerLoading.hidden = !show;
  if (text) el.viewerLoading.textContent = text;
}

function setViewerError(message) {
  el.viewerError.hidden = !message;
  el.viewerError.textContent = message || '';
}

function updatePageUi() {
  const total = state.total;
  el.pageTotal.textContent = `/ ${total || 0}`;
  el.pageInput.max = String(total || 1);
  if (document.activeElement !== el.pageInput) {
    el.pageInput.value = String(state.page || 1);
  }
  el.prevButton.disabled = !total || state.page <= 1;
  el.nextButton.disabled = !total || state.page >= total;
  el.overviewButton.disabled = !total;
}

async function setPage(number) {
  if (!state.pdf) {
    state.pendingPage = number;
    return;
  }
  const page = Math.min(Math.max(1, Math.round(number) || 1), state.total);
  state.page = page;
  updatePageUi();
  if (state.deck) {
    history.replaceState(null, '', `#/deck/${state.deck.id}/${page}`);
  }
  await renderPage(page);
}

function go(delta) {
  if (!state.pdf) return;
  const next = state.page + delta;
  if (next < 1 || next > state.total) return;
  setPage(next);
  armIdle();
}

async function renderPage(number) {
  if (!state.pdf) return;
  const token = ++state.renderToken;
  if (state.renderTask) {
    try {
      state.renderTask.cancel();
    } catch {
      /* already finished */
    }
    state.renderTask = null;
  }

  try {
    const page = await state.pdf.getPage(number);
    if (token !== state.renderToken) return;
    setViewerError(null);

    const stageRect = el.stage.getBoundingClientRect();
    const base = page.getViewport({ scale: 1 });
    const padding = 16;
    const scale = Math.max(
      0.05,
      Math.min(
        (stageRect.width - padding * 2) / base.width,
        (stageRect.height - padding * 2) / base.height,
        4
      )
    );
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const context = el.canvas.getContext('2d', { alpha: false });

    el.canvas.width = Math.floor(viewport.width * dpr);
    el.canvas.height = Math.floor(viewport.height * dpr);
    el.canvas.style.width = `${viewport.width}px`;
    el.canvas.style.height = `${viewport.height}px`;
    el.pageWrap.hidden = false;
    el.pageWrap.style.width = `${viewport.width}px`;
    el.pageWrap.style.height = `${viewport.height}px`;
    el.overlay.replaceChildren();

    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
    });
    state.renderTask = renderTask;
    await renderTask.promise;
    if (state.renderTask === renderTask) state.renderTask = null;
    if (token !== state.renderToken) return;

    await renderAnnotations(page, viewport, token);
    updateCurrentThumb();
  } catch (error) {
    if (error && error.name === 'RenderingCancelledException') return;
    if (token !== state.renderToken) return;
    setViewerError(`幻灯片渲染失败：${error.message || '未知错误'}`);
  }
}

async function renderAnnotations(page, viewport, token) {
  let annotations;
  try {
    annotations = await page.getAnnotations({ intent: 'display' });
  } catch {
    return;
  }
  if (token !== state.renderToken) return;

  for (const annotation of annotations) {
    if (
      annotation.subtype !== 'Link' ||
      !annotation.rect ||
      annotation.rect.length < 4
    ) {
      continue;
    }
    const [x1, y1] = viewport.convertToViewportPoint(
      annotation.rect[0],
      annotation.rect[1]
    );
    const [x2, y2] = viewport.convertToViewportPoint(
      annotation.rect[2],
      annotation.rect[3]
    );
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    if (width < 2 || height < 2) continue;

    if (annotation.url) {
      const href = safeExternalUrl(annotation.url);
      if (!href) continue;
      const link = document.createElement('a');
      link.className = 'pdf-link';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = href;
      placeOverlayItem(link, left, top, width, height);
      link.addEventListener('click', (event) => event.stopPropagation());
      el.overlay.appendChild(link);
    } else if (annotation.dest) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pdf-link';
      button.title = '跳转到链接目标';
      placeOverlayItem(button, left, top, width, height);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        followDestination(annotation.dest);
      });
      el.overlay.appendChild(button);
    }
  }
}

function placeOverlayItem(node, left, top, width, height) {
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
}

function safeExternalUrl(raw) {
  try {
    const url = new URL(raw, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return url.href;
    }
  } catch {
    /* invalid */
  }
  return null;
}

async function followDestination(dest) {
  if (!state.pdf) return;
  try {
    const resolved = typeof dest === 'string' ? await state.pdf.getDestination(dest) : dest;
    if (!resolved || !resolved.length) return;
    const ref = resolved[0];
    let index = null;
    if (typeof ref === 'number') index = ref;
    else if (ref && typeof ref === 'object') index = await state.pdf.getPageIndex(ref);
    if (Number.isInteger(index)) await setPage(index + 1);
  } catch {
    /* destination could not be resolved */
  }
}

function openOverview() {
  if (!state.pdf || state.overviewOpen) return;
  state.overviewOpen = true;
  el.stage.inert = true;
  el.overview.hidden = false;
  el.viewer.classList.add('overview-open');
  el.viewer.classList.remove('controls-hidden');
  clearTimeout(state.idleTimer);
  el.thumbGrid.replaceChildren();
  state.thumbPending = [];
  state.thumbActive = 0;
  const generation = ++state.thumbGeneration;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = state.thumbItems.find((candidate) => candidate.canvas === entry.target);
        if (!item || item.queued) continue;
        item.queued = true;
        observer.unobserve(entry.target);
        state.thumbPending.push(item);
        pumpThumbs(generation);
      }
    },
    { root: el.thumbGrid, rootMargin: '400px' }
  );
  state.thumbObserver = observer;
  state.thumbItems = [];

  for (let number = 1; number <= state.total; number += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = number === state.page ? 'thumb current' : 'thumb';
    button.dataset.page = String(number);
    button.setAttribute('aria-label', `第 ${number} 页`);

    const canvas = document.createElement('canvas');
    canvas.dataset.page = String(number);

    const label = document.createElement('span');
    label.textContent = String(number);

    button.append(canvas, label);
    button.addEventListener('click', () => {
      closeOverview();
      setPage(number);
    });
    el.thumbGrid.appendChild(button);

    const item = { number, canvas, queued: false };
    state.thumbItems.push(item);
    observer.observe(canvas);
  }

  requestAnimationFrame(() => {
    const current = el.thumbGrid.querySelector('.thumb.current');
    if (current) { current.scrollIntoView({ block: 'center' }); current.focus(); }
  });
}

async function pumpThumbs(generation) {
  while (state.thumbActive < 2 && state.thumbPending.length) {
    const item = state.thumbPending.shift();
    state.thumbActive += 1;
    renderThumb(item, generation)
      .catch(() => {})
      .finally(() => {
        if (generation !== state.thumbGeneration) return;
        state.thumbActive -= 1;
        pumpThumbs(generation);
      });
  }
}

async function renderThumb(item, generation) {
  if (generation !== state.thumbGeneration || !state.pdf) return;
  const page = await state.pdf.getPage(item.number);
  if (generation !== state.thumbGeneration) return;
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(200 / base.width, 130 / base.height);
  const viewport = page.getViewport({ scale });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  item.canvas.width = Math.floor(viewport.width * dpr);
  item.canvas.height = Math.floor(viewport.height * dpr);
  const context = item.canvas.getContext('2d', { alpha: false });
  await page.render({
    canvasContext: context,
    viewport,
    transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
  }).promise;
}

function updateCurrentThumb() {
  if (!state.overviewOpen) return;
  for (const thumb of el.thumbGrid.querySelectorAll('.thumb')) {
    thumb.classList.toggle('current', Number(thumb.dataset.page) === state.page);
  }
}

function closeOverview() {
  if (!state.overviewOpen && el.overview.hidden) return;
  state.overviewOpen = false;
  el.stage.inert = false;
  state.thumbGeneration += 1;
  state.thumbPending = [];
  state.thumbActive = 0;
  if (state.thumbObserver) {
    state.thumbObserver.disconnect();
    state.thumbObserver = null;
  }
  state.thumbItems = [];
  el.overview.hidden = true;
  el.viewer.classList.remove('overview-open');
  if (!el.viewerView.hidden) el.overviewButton.focus();
  el.thumbGrid.replaceChildren();
  armIdle();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (el.viewerView.requestFullscreen) {
      await el.viewerView.requestFullscreen();
    }
  } catch {
    /* fullscreen may be rejected by the browser */
  }
}

function armIdle() {
  clearTimeout(state.idleTimer);
  if (el.viewerView.hidden) return;
  el.viewer.classList.remove('controls-hidden');
  state.idleTimer = setTimeout(() => {
    if (!el.viewerView.hidden && !state.overviewOpen) {
      el.viewer.classList.add('controls-hidden');
    }
  }, 3000);
}

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (el.viewerView.hidden) return;
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (state.overviewOpen) {
    if (event.key === 'Tab') {
      const items = [el.overviewClose, ...el.thumbGrid.querySelectorAll('button')];
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key === 'Escape' || event.key === 'g' || event.key === 'G') {
      event.preventDefault();
      closeOverview();
    }
    return;
  }

  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      event.preventDefault();
      go(1);
      break;
    case ' ':
      event.preventDefault();
      go(event.shiftKey ? -1 : 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      event.preventDefault();
      go(-1);
      break;
    case 'Home':
      event.preventDefault();
      setPage(1);
      armIdle();
      break;
    case 'End':
      event.preventDefault();
      setPage(state.total);
      armIdle();
      break;
    case 'f':
    case 'F':
      event.preventDefault();
      toggleFullscreen();
      break;
    case 'g':
    case 'G':
      event.preventDefault();
      openOverview();
      break;
    default:
      return;
  }
}

let touchStart = null;

function bindEvents() {
  el.search.addEventListener('input', renderDeckList);
  el.sort.addEventListener('change', renderDeckList);
  el.clearSearch.addEventListener('click', () => { el.search.value = ''; renderDeckList(); el.search.focus(); });
  for (const [button, rows] of [[el.gridView, false], [el.rowsView, true]]) {
    button.addEventListener('click', () => {
      el.deckList.classList.toggle('rows', rows);
      el.gridView.setAttribute('aria-pressed', String(!rows));
      el.rowsView.setAttribute('aria-pressed', String(rows));
    });
  }
  el.togglePassphrase.addEventListener('click', () => {
    const show = el.passphrase.type === 'password';
    el.passphrase.type = show ? 'text' : 'password';
    el.togglePassphrase.textContent = show ? '隐藏' : '显示';
    el.togglePassphrase.setAttribute('aria-label', show ? '隐藏总口令' : '显示总口令');
    el.togglePassphrase.setAttribute('aria-pressed', String(show));
  });
  el.unlockForm.addEventListener('submit', unlock);
  el.lockButton.addEventListener('click', lock);
  el.backButton.addEventListener('click', () => {
    location.hash = '#/';
  });

  el.prevButton.addEventListener('click', () => go(-1));
  el.nextButton.addEventListener('click', () => go(1));
  el.overviewButton.addEventListener('click', openOverview);
  el.overviewClose.addEventListener('click', closeOverview);
  el.fullscreenButton.addEventListener('click', toggleFullscreen);

  el.pageInput.addEventListener('change', () => {
    setPage(Number(el.pageInput.value));
    armIdle();
  });
  el.pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      setPage(Number(el.pageInput.value));
      el.pageInput.blur();
    } else if (event.key === 'Escape') {
      el.pageInput.value = String(state.page);
      el.pageInput.blur();
    }
  });

  el.stage.addEventListener('click', (event) => {
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    if (event.button !== 0) return;
    if (event.target.closest('button, a, input, .controls, .viewer-top')) return;
    const rect = el.stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    go(x < rect.width / 2 ? -1 : 1);
  });

  el.stage.addEventListener(
    'touchstart',
    (event) => {
      armIdle();
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      touchStart = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        target: event.target,
      };
    },
    { passive: true }
  );

  el.stage.addEventListener(
    'touchend',
    (event) => {
      if (!touchStart) return;
      const start = touchStart;
      touchStart = null;
      const touch = event.changedTouches[0];
      if (!touch) return;
      if (start.target.closest && start.target.closest('button, a, input')) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        state.suppressClick = true;
        setTimeout(() => {
          state.suppressClick = false;
        }, 400);
        go(dx < 0 ? 1 : -1);
      }
    },
    { passive: true }
  );

  el.viewer.addEventListener('pointermove', armIdle);
  el.viewer.addEventListener('touchstart', armIdle, { passive: true });
  document.addEventListener('keydown', onKeyDown);
  el.viewer.addEventListener('focusin', armIdle);
  document.addEventListener('fullscreenchange', () => {
    el.fullscreenButton.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
    setTimeout(() => {
      if (state.pdf && !el.viewerView.hidden) renderPage(state.page);
    }, 120);
  });

  window.addEventListener('resize', () => {
    if (el.viewerView.hidden || !state.pdf) return;
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => renderPage(state.page), 150);
  });

  window.addEventListener('hashchange', route);
}

boot();
