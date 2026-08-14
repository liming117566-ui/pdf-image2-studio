import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(process.env.DATA_DIR || './data');
const publicDir = path.resolve('public');
const port = Number(process.env.PORT || 3000);
const appOrigin = String(process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
const appPassword = String(process.env.APP_PASSWORD || process.env.ADMIN_PASSWORD || '');
const maxUploadMb = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 120));
const generationConcurrency = Math.min(20, Math.max(1, Number(process.env.GENERATION_CONCURRENCY || 2)));
const retentionDays = Math.max(1, Number(process.env.RETENTION_DAYS || 7));
const upstreamBase = String(process.env.SUB2API_BASE_URL || '').replace(/\/$/, '');
const upstreamModel = String(process.env.SUB2API_MODEL || 'image2');
const upstreamKey = String(process.env.SUB2API_API_KEY || '');
const upstreamTimeoutMs = Math.max(30_000, Number(process.env.UPSTREAM_TIMEOUT_MS || 300_000));

if (!appPassword) throw new Error('APP_PASSWORD or ADMIN_PASSWORD is required');
if (!upstreamBase) throw new Error('SUB2API_BASE_URL is required');

await fs.mkdir(rootDir, { recursive: true });
const db = new Database(path.join(rootDir, 'pdf-image2.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    thumb_path TEXT NOT NULL,
    UNIQUE(project_id, page_number)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    fidelity TEXT NOT NULL,
    size TEXT NOT NULL,
    status TEXT NOT NULL,
    result_path TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generation_requests (
    request_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project_id, page_number);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, created_at);
`);
db.prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'processing'").run(Date.now());

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const extractionLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const generationLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false });
const upload = multer({
  dest: path.join(rootDir, 'uploads'),
  limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf'),
});
await fs.mkdir(path.join(rootDir, 'uploads'), { recursive: true });

function now() { return Date.now(); }
function id() { return crypto.randomUUID(); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function safeRelative(filePath) {
  const resolved = path.resolve(rootDir, filePath);
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) throw new Error('非法文件路径');
  return resolved;
}
function cookieValue(header = '', name) {
  const entry = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (process.env.NODE_ENV === 'production' && origin && origin !== appOrigin) return res.status(403).json({ error: '请求来源无效' });
  next();
}
function auth(req, res, next) {
  const token = cookieValue(req.headers.cookie, 'pdf_image2_session');
  if (!token) return res.status(401).json({ error: '请先登录' });
  const session = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!session || session.expires_at < now()) return res.status(401).json({ error: '登录已过期' });
  req.authenticated = true;
  next();
}
function setSession(res) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run(hashToken(token), now() + 14 * 24 * 60 * 60_000);
  res.cookie('pdf_image2_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 14 * 24 * 60 * 60_000 });
}
function clearSession(req, res) {
  const token = cookieValue(req.headers.cookie, 'pdf_image2_session');
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie('pdf_image2_session', { path: '/' });
}
function sendError(res, error, fallback = '操作失败') {
  console.error(error);
  res.status(Number.isInteger(error?.status) ? error.status : 400).json({ error: String(error?.message || fallback).slice(0, 500) });
}
function publicPage(row) {
  return {
    id: row.id,
    pageNumber: row.page_number,
    imageUrl: `/api/pages/${row.id}/image`,
    thumbUrl: `/api/pages/${row.id}/image?thumb=1`,
  };
}
function publicTask(row) {
  return {
    id: row.id,
    pageId: row.page_id,
    pageNumber: row.page_number,
    prompt: row.prompt,
    fidelity: row.fidelity,
    size: row.size,
    status: row.status,
    error: row.error || null,
    resultUrl: row.result_path ? `/api/tasks/${row.id}/result` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function projectFor(idValue) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(idValue);
  if (!project) return null;
  const pages = db.prepare('SELECT * FROM pages WHERE project_id = ? ORDER BY page_number').all(idValue).map(publicPage);
  const tasks = db.prepare(`SELECT t.*, p.page_number FROM tasks t JOIN pages p ON p.id = t.page_id WHERE t.project_id = ? ORDER BY t.created_at, p.page_number`).all(idValue).map(publicTask);
  return { id: project.id, originalName: project.original_name, pageCount: project.page_count, createdAt: project.created_at, pages, tasks };
}
function ensureProject(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) { const error = new Error('项目不存在'); error.status = 404; throw error; }
  return project;
}

async function pdfPageCount(pdfPath) {
  const { stdout } = await execFileAsync('pdfinfo', [pdfPath], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const match = stdout.match(/^Pages:\s+(\d+)/mi);
  const pages = Number(match?.[1] || 0);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('无法读取 PDF 页数');
  return pages;
}

function parsePageSelection(value, pageCount) {
  const input = String(value || '').replace(/[，、]/g, ',').replace(/[－—–]/g, '-').trim();
  if (!input) throw new Error('请输入要提取的页码或范围');
  if (input.length > 100_000) throw new Error('页码范围输入过长');
  const pages = new Set();
  for (const rawPart of input.split(',')) {
    const part = rawPart.trim();
    if (!part) throw new Error('页码范围格式无效');
    const range = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!range) throw new Error(`页码范围格式无效：${part}`);
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new Error(`页码必须在 1-${pageCount} 之间，且范围起止顺序正确`);
    }
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

function contiguousRanges(pages) {
  const ranges = [];
  for (const page of pages) {
    const previous = ranges[ranges.length - 1];
    if (previous && page === previous[1] + 1) previous[1] = page;
    else ranges.push([page, page]);
  }
  return ranges;
}

async function extractPages(pdfPath, projectId, pages) {
  const projectDir = path.join(rootDir, 'projects', projectId);
  const pageDir = path.join(projectDir, 'pages');
  await fs.mkdir(pageDir, { recursive: true });
  const missingPages = pages.filter((pageNumber) => !db.prepare('SELECT 1 FROM pages WHERE project_id = ? AND page_number = ?').get(projectId, pageNumber));
  if (!missingPages.length) return 0;
  const tempDir = path.join(pageDir, `.extract-${id()}`);
  await fs.mkdir(tempDir, { recursive: true });
  const rendered = new Map();
  const pageSet = new Set(missingPages);
  try {
    for (const [start, end] of contiguousRanges(missingPages)) {
      const prefix = path.join(tempDir, `render-${start}-${end}`);
      await execFileAsync('pdftoppm', ['-jpeg', '-r', '120', '-jpegopt', 'quality=90', '-f', String(start), '-l', String(end), pdfPath, prefix], { timeout: 300_000, maxBuffer: 1024 * 1024 });
      const files = (await fs.readdir(tempDir)).filter((file) => file.startsWith(`render-${start}-${end}-`) && /\.jpg$/i.test(file));
      for (const file of files) {
        const pageNumber = Number(file.match(/-(\d+)\.jpg$/i)?.[1]);
        if (pageSet.has(pageNumber)) rendered.set(pageNumber, path.join(tempDir, file));
      }
    }
    if (rendered.size !== missingPages.length) throw new Error('PDF 页面渲染数量不匹配');
    const extracted = [];
    for (const pageNumber of missingPages) {
      const source = rendered.get(pageNumber);
      const target = path.join(pageDir, `page-${pageNumber}.jpg`);
      const thumb = path.join(pageDir, `thumb-${pageNumber}.webp`);
      await fs.rename(source, target);
      await sharp(target).resize(300, 420, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(thumb);
      extracted.push({ pageNumber, target, thumb });
    }
    const insertPage = db.prepare('INSERT OR IGNORE INTO pages(id, project_id, page_number, image_path, thumb_path) VALUES (?, ?, ?, ?, ?)');
    const transaction = db.transaction(() => {
      for (const page of extracted) insertPage.run(id(), projectId, page.pageNumber, path.relative(rootDir, page.target), path.relative(rootDir, page.thumb));
    });
    transaction();
    return extracted.length;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function upstreamEndpoint() {
  const base = /\/v1$/i.test(upstreamBase) ? upstreamBase : `${upstreamBase}/v1`;
  return `${base}/images/edits`;
}
function extractImage(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const data = value.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (data) return Buffer.from(data[1], 'base64');
    if (/^https?:\/\//.test(value)) return { url: value };
    return null;
  }
  if (Array.isArray(value)) { for (const item of value) { const found = extractImage(item, depth + 1); if (found) return found; } return null; }
  if (typeof value === 'object') {
    for (const key of ['b64_json', 'image_base64']) if (typeof value[key] === 'string') return Buffer.from(value[key], 'base64');
    for (const key of ['data', 'images', 'output', 'choices', 'content', 'message', 'url']) if (key in value) { const found = extractImage(value[key], depth + 1); if (found) return found; }
  }
  return null;
}
async function callImage2(inputPath, prompt, size) {
  if (!upstreamKey) throw new Error('image2 接口密钥未配置');
  const input = await fs.readFile(inputPath);
  const form = new FormData();
  form.set('model', upstreamModel);
  form.set('prompt', prompt);
  form.set('n', '1');
  const outputSize = { portrait: '1024x1536', 'three-four': '1152x1536', landscape: '1536x1024', square: '1024x1024' }[size] || '1024x1536';
  form.set('size', outputSize);
  form.set('response_format', 'b64_json');
  form.append('image', new Blob([input], { type: 'image/jpeg' }), 'page.jpg');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  try {
    const response = await fetch(upstreamEndpoint(), { method: 'POST', headers: { Authorization: `Bearer ${upstreamKey}` }, body: form, signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `image2 返回 HTTP ${response.status}`);
    const found = extractImage(payload);
    if (Buffer.isBuffer(found)) return found;
    if (found?.url) {
      const imageResponse = await fetch(found.url, { signal: controller.signal });
      if (!imageResponse.ok) throw new Error(`生成图片下载失败 (${imageResponse.status})`);
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    throw new Error('image2 未返回可识别的图片');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('image2 生成超时');
    throw error;
  } finally { clearTimeout(timer); }
}
async function saveResult(taskId, buffer, size) {
  const dir = path.join(rootDir, 'projects', db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId).project_id, 'results');
  await fs.mkdir(dir, { recursive: true });
  const output = path.join(dir, `${taskId}.jpg`);
  const dimensions = {
    portrait: { width: 1024, height: 1536 },
    'three-four': { width: 1152, height: 1536 },
    landscape: { width: 1536, height: 1024 },
    square: { width: 1024, height: 1024 },
  }[size] || { width: 1024, height: 1536 };
  // The upstream may normalize unsupported custom sizes; enforce the selected canvas locally.
  await sharp(buffer, { limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ ...dimensions, fit: 'cover', position: 'centre' })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toFile(output);
  return path.relative(rootDir, output);
}
function effectivePrompt(task) {
  const preservation = task.fidelity === 'safe'
    ? 'Preserve the original page layout, printed text, headings, page numbers, illustrations, crop, and reading order exactly. Do not rewrite, erase, translate, or invent the printed content. Add the requested visual treatment as a restrained edit layered over the page.'
    : 'Use the uploaded page as the main visual reference. Keep the page structure and subject recognizable while applying the requested visual treatment.';
  return `${preservation}\nUser instruction: ${task.prompt}\nThe output must be one complete flat front-facing vertical book page, with no watermark, no border, and no extra alternatives.`;
}

let active = 0;
function claimNextTask() {
  const row = db.prepare("SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
  if (!row) return null;
  const changed = db.prepare("UPDATE tasks SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'").run(now(), row.id);
  return changed.changes ? db.prepare('SELECT t.*, p.image_path, p.page_number FROM tasks t JOIN pages p ON p.id = t.page_id WHERE t.id = ?').get(row.id) : null;
}
async function processTask(task) {
  try {
    const result = await callImage2(safeRelative(task.image_path), effectivePrompt(task), task.size);
    const resultPath = await saveResult(task.id, result, task.size);
    db.prepare("UPDATE tasks SET status = 'completed', result_path = ?, error = NULL, updated_at = ? WHERE id = ?").run(resultPath, now(), task.id);
  } catch (error) {
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(String(error?.message || '生成失败').slice(0, 500), now(), task.id);
  }
}
async function pump() {
  while (active < generationConcurrency) {
    const task = claimNextTask();
    if (!task) return;
    active += 1;
    processTask(task).finally(() => { active -= 1; void pump(); });
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, upstreamConfigured: Boolean(upstreamKey), model: upstreamModel, queueConcurrency: generationConcurrency }));
app.post('/api/auth/login', authLimiter, sameOrigin, (req, res) => {
  const supplied = String(req.body?.password || '');
  const a = Buffer.from(supplied); const b = Buffer.from(appPassword);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return res.status(401).json({ error: '密码错误' });
  setSession(res); res.json({ ok: true });
});
app.get('/api/auth/me', auth, (_req, res) => res.json({ ok: true }));
app.post('/api/auth/logout', auth, sameOrigin, (req, res) => { clearSession(req, res); res.json({ ok: true }); });

app.post('/api/projects', auth, sameOrigin, uploadLimiter, (req, res) => {
  upload.single('pdf')(req, res, async (error) => {
    if (error) return sendError(res, error, 'PDF 上传失败');
    if (!req.file) return res.status(400).json({ error: '请选择 PDF 文件' });
    const projectId = id();
    try {
      const pages = await pdfPageCount(req.file.path);
      const sourceDir = path.join(rootDir, 'projects', projectId);
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePath = path.join(sourceDir, 'source.pdf');
      await fs.rename(req.file.path, sourcePath);
      db.prepare('INSERT INTO projects(id, original_name, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(projectId, req.file.originalname.slice(0, 240), pages, now(), now());
      res.json({ project: projectFor(projectId) });
    } catch (uploadError) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      await fs.rm(path.join(rootDir, 'projects', projectId), { recursive: true, force: true }).catch(() => {});
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      sendError(res, uploadError, 'PDF 处理失败');
    }
  });
});
app.get('/api/projects/:id', auth, (req, res) => {
  const project = projectFor(req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  res.json({ project });
});
app.post('/api/projects/:id/extract', auth, sameOrigin, extractionLimiter, async (req, res) => {
  try {
    const project = ensureProject(req.params.id);
    const pages = parsePageSelection(req.body?.pages ?? req.body?.pageRange, project.page_count);
    const sourcePath = path.join(rootDir, 'projects', project.id, 'source.pdf');
    const extractedCount = await extractPages(sourcePath, project.id, pages);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), project.id);
    res.json({ project: projectFor(project.id), extractedCount, requestedPages: pages });
  } catch (error) { sendError(res, error, 'PDF 页面提取失败'); }
});
app.get('/api/pages/:id/image', auth, async (req, res) => {
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).end();
  const filePath = safeRelative(req.query.thumb === '1' ? page.thumb_path : page.image_path);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', 'inline');
  res.type(req.query.thumb === '1' ? 'webp' : 'jpg');
  res.sendFile(filePath);
});
app.get('/api/tasks/:id/result', auth, (req, res) => {
  const task = db.prepare('SELECT result_path FROM tasks WHERE id = ?').get(req.params.id);
  if (!task?.result_path) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Disposition', req.query.download === '1' ? `attachment; filename="page-${req.params.id}.jpg"` : 'inline');
  res.sendFile(safeRelative(task.result_path));
});
app.post('/api/projects/:id/generate', auth, sameOrigin, generationLimiter, (req, res) => {
  try {
    const project = ensureProject(req.params.id);
    const requestId = String(req.get('x-generation-request-id') || '').trim();
    if (!/^[a-zA-Z0-9._:-]{12,128}$/.test(requestId)) return res.status(400).json({ error: '生成请求 ID 无效' });
    const duplicate = db.prepare('SELECT task_ids FROM generation_requests WHERE request_id = ?').get(requestId);
    if (duplicate) return res.json({ project: projectFor(project.id), replayed: true });
    const rawPages = Array.isArray(req.body?.pageNumbers) ? req.body.pageNumbers : [];
    const pageNumbers = [...new Set(rawPages.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= project.page_count))];
    if (!pageNumbers.length) throw new Error('请选择至少一页');
    const prompt = String(req.body?.prompt || '').trim();
    if (prompt.length < 2 || prompt.length > 4000) throw new Error('提示词长度需为 2-4000 字符');
    const fidelity = req.body?.fidelity === 'free' ? 'free' : 'safe';
    const size = ['portrait', 'three-four', 'landscape', 'square'].includes(req.body?.size) ? req.body.size : 'portrait';
    const pageRows = db.prepare(`SELECT * FROM pages WHERE project_id = ? AND page_number IN (${pageNumbers.map(() => '?').join(',')})`).all(project.id, ...pageNumbers);
    if (pageRows.length !== pageNumbers.length) throw new Error('请先提取所选页面');
    const taskIds = pageRows.sort((a, b) => a.page_number - b.page_number).map((page) => {
      const taskId = id();
      db.prepare('INSERT INTO tasks(id, project_id, page_id, prompt, fidelity, size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(taskId, project.id, page.id, prompt, fidelity, size, 'queued', now(), now());
      return taskId;
    });
    db.prepare('INSERT INTO generation_requests(request_id, project_id, task_ids, created_at) VALUES (?, ?, ?, ?)').run(requestId, project.id, JSON.stringify(taskIds), now());
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), project.id);
    void pump();
    res.json({ project: projectFor(project.id), requestId });
  } catch (error) { sendError(res, error, '创建生成任务失败'); }
});
app.post('/api/tasks/:id/retry', auth, sameOrigin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  db.prepare("UPDATE tasks SET status = 'queued', error = NULL, result_path = NULL, updated_at = ? WHERE id = ?").run(now(), task.id);
  void pump();
  res.json({ project: projectFor(task.project_id) });
});
app.use(express.static(publicDir, { extensions: ['html'] }));
app.use((error, _req, res, _next) => sendError(res, error));

setInterval(() => {
  const cutoff = now() - retentionDays * 24 * 60 * 60_000;
  const old = db.prepare('SELECT id FROM projects WHERE updated_at < ?').all(cutoff);
  const remove = db.transaction((ids) => { for (const row of ids) db.prepare('DELETE FROM projects WHERE id = ?').run(row.id); });
  remove(old);
  for (const row of old) void fs.rm(path.join(rootDir, 'projects', row.id), { recursive: true, force: true });
}, 24 * 60 * 60_000).unref();

app.listen(port, '0.0.0.0', () => {
  console.log(`pdf-image2 listening on ${port}; upstream=${upstreamEndpoint()}; model=${upstreamModel}`);
  void pump();
});
