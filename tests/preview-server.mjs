// Local-only, in-memory fixtures. Never contacts GitHub or writes course data.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deriveKey, encryptJson, encryptBytes, b64encode, randomBytes } from '../assets/crypto.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const salt = b64encode(randomBytes(16));
const key = await deriveKey('preview-only-2026', salt, 1000);
const site = { version: 1, kdf: { algorithm: 'PBKDF2', hash: 'SHA-256', iterations: 1000, salt } };
const titles = ['设计思维：从观察到洞察', '人工智能与未来课堂', '信息可视化基础', '摄影中的光与构图', '让表达更有力量', '计算机网络 · 第三讲'];
function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
  ];
  for (let page = 1; page <= 3; page++) {
    const stream = `q 0.08 0.18 0.15 rg 0 0 960 540 re f 0.82 0.94 0.87 rg 60 90 840 3 re f Q\nBT /F1 17 Tf 0.7 0.82 0.75 rg 60 470 Td (PPTSHOWER / LOCAL PREVIEW) Tj ET\nBT /F1 44 Tf 0.88 0.96 0.91 rg 60 280 Td (Ready for your next class.) Tj ET\nBT /F1 20 Tf 0.7 0.82 0.75 rg 60 220 Td (Slide ${page} of 3 - keyboard, overview and fullscreen) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 9 0 R >> >> /Contents ${page * 2 + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
const decks = titles.map((title, i) => ({ id: (i + 1).toString(16).padStart(8, '0'), title, date: `2026-10-${String(18 - i * 2).padStart(2, '0')}`, rev: 1 }));
const pdf = samplePdf();
const encryptedPdf = Buffer.from(await encryptBytes(key, pdf));
let files = new Map([
  ['site.json', Buffer.from(JSON.stringify(site))],
  ['decks/index.enc', Buffer.from(await encryptJson(key, { version: 1, decks }))],
  ...decks.map((deck) => [`decks/${deck.id}/slides.pdf.enc`, encryptedPdf]),
]);
let head = 'initial';
const snapshots = new Map([[head, new Map(files)]]);
const blobs = new Map(), trees = new Map(), commits = new Map([[head, { tree: { sha: head }, parents: [] }]]);
trees.set(head, new Map(files));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8788');
  const path = decodeURIComponent(url.pathname);
  const send = (status, value, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(Buffer.isBuffer(value) ? value : type === 'application/json' ? JSON.stringify(value) : value); };
  try {
    if (path === '/__fixture/config.js') return send(200, `window.PPTSHOWER_API_BASE = location.origin + '/__fixture/api';\nwindow.PPTSHOWER_KDF_ITERATIONS = 1000;`, 'text/javascript');
    if (path === '/__fixture/sample.pdf') return send(200, pdf, 'application/pdf');
    if (path.startsWith('/__fixture/api/')) {
      const api = path.slice('/__fixture/api'.length);
      const repo = '/repos/wanli1145/pptshower';
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      if (req.headers.authorization !== 'Bearer preview-token') return send(401, { message: 'Use preview-token for the local fixture.' });
      if (api === repo) return send(200, { permissions: { push: true } });
      if (api.startsWith(`${repo}/contents/`)) {
        const data = (snapshots.get(url.searchParams.get('ref')) || files).get(api.slice(`${repo}/contents/`.length));
        return data ? send(200, data, 'application/octet-stream') : send(404, { message: 'Not found' });
      }
      if (api === `${repo}/git/ref/heads/main`) return send(200, { object: { sha: head } });
      if (api.startsWith(`${repo}/git/commits/`)) return send(200, commits.get(api.split('/').at(-1)));
      if (api.endsWith('/git/blobs')) { const sha = randomUUID(); blobs.set(sha, Buffer.from(body.content, 'base64')); return send(201, { sha }); }
      if (api.endsWith('/git/trees')) {
        const tree = new Map(trees.get(body.base_tree));
        for (const entry of body.tree) { if (entry.sha === null) tree.delete(entry.path); else tree.set(entry.path, blobs.get(entry.sha)); }
        const sha = randomUUID(); trees.set(sha, tree); return send(201, { sha });
      }
      if (api.endsWith('/git/commits')) { const sha = randomUUID(); commits.set(sha, { tree: { sha: body.tree }, parents: body.parents }); return send(201, { sha }); }
      if (api.endsWith('/git/refs/heads/main')) {
        const commit = commits.get(body.sha);
        if (body.force !== false || commit.parents[0] !== head) return send(422, { message: 'Not a fast forward' });
        head = body.sha; files = new Map(trees.get(commit.tree.sha)); snapshots.set(head, new Map(files)); return send(200, { object: { sha: head } });
      }
      return send(404, { message: 'Unknown fixture route' });
    }
    const relative = path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
    if (files.has(relative)) return send(200, files.get(relative), mime[extname(relative)] || 'application/octet-stream');
    const full = resolve(root, relative);
    if (!full.startsWith(root) || relative.split('/').some((part) => part.startsWith('.'))) return send(403, { message: 'Forbidden' });
    let data = await readFile(full);
    if (relative === 'admin/index.html') data = Buffer.from(data.toString().replace('<script type="module"', '<script src="/__fixture/config.js"></script>\n<script type="module"'));
    return send(200, data, mime[extname(full)] || 'application/octet-stream');
  } catch (error) { return send(error.code === 'ENOENT' ? 404 : 500, { message: error.message }); }
});
server.listen(8788, '127.0.0.1', () => console.log('Local fixtures: http://127.0.0.1:8788 | passphrase: preview-only-2026 | token: preview-token'));
