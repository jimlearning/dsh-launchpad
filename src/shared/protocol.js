/**
 * dsh-launchpad 共享协议 —— host/client/扩展/工具 的唯一契约来源。
 * 纯 Node 模块（无 @deepseek-ai 依赖），可被单元测试直接 import。
 *
 * 分层原则：
 *  - 本文件：枚举、默认值、id 生成与校验、模板渲染、manifest 校验、URL/siteId 归一
 *  - 任何跨文件引用一律使用本文件生成的 id 指针（悬空指针由 UI 降级处理）
 */

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

export const ITEM_KINDS = ['link', 'panel', 'tool'];
export const SCOPES = ['site', 'page', 'selection'];
export const EXT_KINDS = ['chat-task', 'material-card', 'local-tool', 'direct-action'];
export const EXT_ACTIONS = ['append-highlight'];
export const TOOL_STATUS = ['forging', 'ready', 'failed', 'missing'];
export const CRAWL_STRATEGIES = ['recent-posts', 'toc', 'shallow'];
export const EXT_SOURCES = ['builtin', 'user', 'agent'];
export const FORGE_KINDS = ['tool', 'extension'];

export const PANEL_ID = 'launchpad';
export const PLUGIN_ID = 'dsh-launchpad';
export const PLUGIN_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export function defaultSettings() {
  return {
    openLinksIn: 'reader',        // reader | live | browser —— 收藏网址的默认打开方式
    chatSendMode: 'auto',         // auto | draft —— selection/page 级 chat-task 默认直发
    bigTaskSendMode: 'draft',     // auto | draft —— site 级大任务默认填草稿待确认
    aiAssist: true,               // material-card 类扩展允许调 LLM
    cardModel: '',                // 生成类扩展的模型覆盖 "provider/model"，空=跟随默认（配快模型可显著提速）
    updateCheck: true,
    allowPrivateNetworks: false,  // SSRF 防护：放行内网段
    workspaceId: null,            // 「🚀 发射台」专属工作区 id（client 创建后回写）
    locale: 'zh',
  };
}

export function defaultData() {
  return {
    version: 1,
    settings: defaultSettings(),
    groups: [],                   // [{id, name, order}]
    items: [],                    // [{id, kind, title, url, icon, groupId, order, pinned, siteId, createdAt, lastOpenedAt}]
    sites: {},                    // siteId → {id, baseUrl, title, iconUrl, chatSessionId, createdAt, lastVisitedAt}
    tools: {},                    // toolId → {id, title, icon, status, sessionId, entry, oneLiner, error, createdAt, updatedAt}
    extensions: {},               // extId → {enabled, order}（定义本体在 extensions/<id>/extension.json）
    companionContexts: {},        // sessionId → {text, updatedAt}（伴读注入，上限 200 条 LRU）
    crawlJobs: {},                // jobId → {siteId, strategy, status, pages, startedAt, doneAt, error}
  };
}

// ---------------------------------------------------------------------------
// id 生成与校验
// ---------------------------------------------------------------------------

/** 路径安全 id：小写字母/数字/连字符/下划线，禁止路径穿越。 */
export function isSafeId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,60}$/.test(id);
}

export function newId(prefix) {
  const rand = globalThis.crypto?.randomUUID?.()
    ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  return `${prefix}_${String(rand).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase()}`;
}

/** 由 URL 生成稳定的 12 位十六进制散列（FNV-1a ×2 拼接，无 crypto 依赖）。 */
export function urlHash(url) {
  const text = String(url);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// URL 归一与 site/page 归属
// ---------------------------------------------------------------------------

/** 归一化 URL：小写 scheme/host、去默认端口、去 hash、去末尾斜杠（保留路径与 query）。 */
export function normalizeUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  let text = url.toString();
  if (text.endsWith('/') && url.pathname === '/' && !url.search) text = text.slice(0, -1);
  return text;
}

/**
 * 站点基址：一个收藏页归属的"站点"。
 * 默认 = origin；github.com 特判为 /owner/repo（教程仓库是天然的学习单元）。
 */
export function siteBaseOf(url) {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  const u = new URL(norm);
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length >= 2) return `${u.origin}/${seg[0]}/${seg[1]}`;
  }
  return u.origin;
}

export function siteIdOf(url) {
  const base = siteBaseOf(url);
  return base ? `st_${urlHash(base)}` : null;
}

export function pageIdOf(url) {
  const norm = normalizeUrl(url);
  return norm ? `pg_${urlHash(norm)}` : null;
}

// ---------------------------------------------------------------------------
// 限制常量
// ---------------------------------------------------------------------------

export const LIMITS = {
  selectionChars: 6000,
  questionChars: 2000,
  materialInlineChars: 24000,   // Bundle.markdown 内联上限，超出落盘 spill
  fetchBytes: 4 * 1024 * 1024,
  fetchTimeoutMs: 20000,
  fetchRedirects: 5,
  crawlPagesDefault: 20,
  crawlPagesMax: 60,
  companionContextsMax: 200,
  siteFileReadChars: 200000,
  noteChars: 100000,
};

// ---------------------------------------------------------------------------
// 模板渲染（{{dot.path}} 变量，缺值→空串；不支持逻辑——保持模板对 AI/用户都简单）
// ---------------------------------------------------------------------------

export function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, path) => {
    let value = vars;
    for (const key of path.split('.')) {
      value = value?.[key];
      if (value === undefined || value === null) return '';
    }
    return String(value);
  });
}

export function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 扩展 manifest 校验（schema v1）
// ---------------------------------------------------------------------------

/**
 * 校验并归一化扩展 manifest。返回 {ok, manifest, errors[]}。
 * 宽松策略：未知字段保留（前向兼容），缺失字段补默认，类型错误才报错。
 */
export function validateExtensionManifest(input) {
  const errors = [];
  const m = (input && typeof input === 'object' && !Array.isArray(input)) ? { ...input } : null;
  if (!m) return { ok: false, manifest: null, errors: ['manifest 必须是对象'] };

  if (!isSafeId(m.id)) errors.push('id 缺失或非法（须为 [a-z0-9_-]，≤61 字符）');
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('name 缺失');
  if (m.version !== 1) errors.push('version 须为 1');
  if (!Array.isArray(m.scopes) || m.scopes.length === 0 || m.scopes.some(s => !SCOPES.includes(s))) {
    errors.push(`scopes 须为 ${SCOPES.join('/')} 的非空子集`);
  }
  if (!EXT_KINDS.includes(m.kind)) errors.push(`kind 须为 ${EXT_KINDS.join(' | ')}`);
  if (m.source !== undefined && !EXT_SOURCES.includes(m.source)) errors.push(`source 须为 ${EXT_SOURCES.join(' | ')}`);
  if (m.icon !== undefined && typeof m.icon !== 'string') errors.push('icon 须为字符串（emoji）');
  if (m.when !== undefined && (typeof m.when !== 'object' || m.when === null)) errors.push('when 须为对象');
  if (m.materials !== undefined && (typeof m.materials !== 'object' || m.materials === null)) errors.push('materials 须为对象');
  if (m.materials?.crawl !== undefined) {
    const c = m.materials.crawl;
    if (!CRAWL_STRATEGIES.includes(c.strategy)) errors.push(`materials.crawl.strategy 须为 ${CRAWL_STRATEGIES.join(' | ')}`);
  }
  if (m.prompt !== undefined && typeof m.prompt !== 'string') errors.push('prompt 须为模板文件相对路径');
  if (m.output !== undefined && (typeof m.output !== 'object' || m.output === null)) errors.push('output 须为对象');
  if (m.kind === 'local-tool' && !isSafeId(m.toolId ?? '')) errors.push('local-tool 扩展须声明 toolId');
  if (m.kind === 'direct-action' && !EXT_ACTIONS.includes(m.action)) errors.push(`direct-action 扩展须声明 action（${EXT_ACTIONS.join(' | ')}）`);

  if (errors.length) return { ok: false, manifest: null, errors };
  return {
    ok: true,
    manifest: {
      icon: '✨',
      description: '',
      source: 'user',
      when: {},
      materials: {},
      prompt: 'prompt.md',
      output: {},
      ...m,
    },
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// 目标（runExtension 的 target）校验
// ---------------------------------------------------------------------------

export function validateRunTarget(input) {
  const t = (input && typeof input === 'object') ? input : {};
  if (!SCOPES.includes(t.scope)) return { ok: false, error: `target.scope 须为 ${SCOPES.join(' | ')}` };
  if (t.scope !== 'selection' && !isSafeId(t.siteId ?? '') && !normalizeUrl(t.url ?? '')) {
    return { ok: false, error: 'site/page 目标须要 siteId 或 url' };
  }
  if (t.scope === 'selection') {
    const quote = t.selection?.quote;
    if (typeof quote !== 'string' || !quote.trim()) return { ok: false, error: 'selection 目标须要 selection.quote' };
  }
  return { ok: true, target: t };
}

// ---------------------------------------------------------------------------
// 站点相对路径防护（notebook/ 写入与 site 文件读取共用）
// ---------------------------------------------------------------------------

const WRITE_ALLOW = /^notebook\//;
const READ_ALLOW = /^(notebook\/|digests\/|cards\/|runs\/|site\.json$|cache\/pages\/)/;

export function allowSiteWrite(relPath) {
  return typeof relPath === 'string' && relPath.length < 300 && !relPath.includes('..')
    && !relPath.startsWith('/') && WRITE_ALLOW.test(relPath);
}

export function allowSiteRead(relPath) {
  return typeof relPath === 'string' && relPath.length < 300 && !relPath.includes('..')
    && !relPath.startsWith('/') && READ_ALLOW.test(relPath);
}
