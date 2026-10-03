/**
 * host HTTP 路由：健康检查 + Forge 工具/站点卡片静态伺服。
 * 纯 Node ESM（webServer 由参数注入，可测）。
 * 契约：registerRoutes({webServer, root, store, logger}) → disposer（注销全部路由）
 *
 * 路由形态照 dsh-worktable 与宿主 webServer 契约：
 *   webServer.register({ kind: 'exact'|'prefix', path, handler }) → disposer
 *   handler 是 Node 原生 (req: IncomingMessage, res: ServerResponse) 风格
 *   （不是 Fetch 的 Request→Response；重复注册同 (kind, path) 会抛错，故逐条容错）。
 *
 * 安全：仅 GET/HEAD；id 过 isSafeId；resolveSafePath 真路径防 .. 穿越与符号链接逃逸；
 * 未知后缀 404；工具/卡片响应带 CSP 与 no-store。
 */
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { isSafeId } from '../shared/protocol.js';

const MAX_BYTES = 40 * 1024 * 1024;

/** 静态资源 MIME 表（照搬 dsh-worktable FILE_TYPES；未列出的后缀一律 404）。 */
const FILE_TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self' 'unsafe-inline' data: blob:",
  'cache-control': 'no-store',
};

const TOOL_PREFIX = '/api/launchpad/tool';
const CARD_PREFIX = '/api/launchpad/card';
const CARD_ALLOW = /^(cards|digests)(\/|$)/; // 卡片路由只伺服这两前缀

/** 文件名 → MIME；未列出的后缀返回 null（路由层据此 404）。 */
export function mimeOf(fileName) {
  const ext = extname(String(fileName ?? '')).slice(1).toLowerCase();
  return FILE_TYPES[ext] ?? null;
}

/**
 * 把 baseDir 内的相对路径解析为绝对路径；越界（.. 穿越、绝对路径注入、符号链接逃逸）抛错。
 * base 与目标都经 realpath 归一（macOS 上 /var→/private/var 之类也能正确判定）；
 * 目标尚不存在时退回词法路径（由路由层 404）。
 */
export function resolveSafePath(baseDir, relPath) {
  let base = resolve(String(baseDir));
  try { base = realpathSync(base); } catch { /* base 尚不存在：用词法路径，目标必然也 404 */ }
  const abs = resolve(base, String(relPath ?? ''));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`路径越界：${relPath}`);
  }
  let real = null;
  try { real = realpathSync(abs); } catch { /* 目标不存在 → 交由路由 404 */ }
  if (real) {
    if (real !== base && !real.startsWith(base + sep)) {
      throw new Error(`路径越界（符号链接）：${relPath}`);
    }
    return real;
  }
  return abs;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 解析 prefix 路由余量：'<prefix>/<seg1>/<seg2>…' → 逐段 decodeURIComponent 后的数组。 */
function tailSegments(req, prefix) {
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
  return pathname.slice(prefix.length).split('/').filter(Boolean)
    .map(seg => { try { return decodeURIComponent(seg); } catch { return seg; } });
}

/** 静态文件伺服：目录/空前缀 → index.html；未知后缀 404；CSP + no-store；支持 HEAD。 */
async function serveStatic(req, res, baseDir, rel) {
  let relPath = rel;
  if (!relPath || relPath.endsWith('/')) relPath += 'index.html';
  let abs;
  try {
    abs = resolveSafePath(baseDir, relPath);
  } catch {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  let info = await stat(abs).catch(() => null);
  if (info?.isDirectory()) {
    try {
      abs = resolveSafePath(baseDir, join(relPath, 'index.html'));
    } catch {
      json(res, 403, { error: 'forbidden' });
      return;
    }
    info = await stat(abs).catch(() => null);
  }
  if (!info || !info.isFile()) { json(res, 404, { error: 'not found' }); return; }
  if (info.size > MAX_BYTES) { json(res, 413, { error: 'file too large' }); return; }
  const mime = mimeOf(abs);
  if (!mime) { json(res, 404, { error: 'unknown file type' }); return; }
  const headers = { 'content-type': mime, 'content-length': info.size, ...SECURITY_HEADERS };
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  const data = await readFile(abs);
  res.writeHead(200, headers);
  res.end(data);
}

function methodNotAllowed(res) {
  res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS });
  res.end();
}

export function registerRoutes({ webServer, root, store, logger = console } = {}) {
  if (!webServer?.register) {
    logger?.warn?.('dsh-launchpad: webServer 服务不可用，路由未注册');
    return () => {};
  }
  const disposers = [];
  const add = (route) => {
    try {
      const dispose = webServer.register(route);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      // 重复 (kind,path) 等单条失败不拖垮其余路由
      logger?.warn?.(`dsh-launchpad: 路由 ${route.path} 注册失败：${error?.message ?? error}`);
    }
  };

  add({
    kind: 'exact',
    path: '/api/launchpad/health',
    handler: (_req, res) => {
      json(res, 200, { ok: true, plugin: 'dsh-launchpad', root, loadedFrom: store?.loadedFrom ?? null });
    },
  });

  // Forge 小工具静态伺服：<root>/tools/<id>/<path...>，默认 index.html
  add({
    kind: 'prefix',
    path: TOOL_PREFIX,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { methodNotAllowed(res); return; }
        const segs = tailSegments(req, TOOL_PREFIX);
        const toolId = segs.shift() ?? '';
        if (!isSafeId(toolId)) { json(res, 400, { error: 'invalid tool id' }); return; }
        await serveStatic(req, res, join(root, 'tools', toolId), segs.join('/'));
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
    },
  });

  // 站点卡片/周报预览：<root>/sites/<siteId>/{cards|digests}/<path...>
  add({
    kind: 'prefix',
    path: CARD_PREFIX,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { methodNotAllowed(res); return; }
        const segs = tailSegments(req, CARD_PREFIX);
        const siteId = segs.shift() ?? '';
        if (!isSafeId(siteId)) { json(res, 400, { error: 'invalid site id' }); return; }
        // 兼容两种形态：/card/<siteId>/cards|digests/<path> 与 /card/<siteId>/<name>（裸名默认 cards/ 下）
        let rel = segs.join('/');
        if (!CARD_ALLOW.test(rel)) rel = `cards/${rel}`;
        if (!CARD_ALLOW.test(rel)) { json(res, 403, { error: 'only cards/ and digests/ are served' }); return; }
        await serveStatic(req, res, join(root, 'sites', siteId), rel);
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
    },
  });

  return () => {
    for (const dispose of disposers.splice(0)) { try { dispose(); } catch {} }
  };
}
