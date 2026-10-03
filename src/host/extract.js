/**
 * 正文提取：元数据（JSON-LD > og/twitter > meta > title）+ 正文候选打分（段落文本密度 × 链接密度倒数）。
 * 纯函数、零依赖，树操作复用 sanitize.js 的容错解析器。
 */
import { parseHtml, walkElements, textOf, serializeChildren, sanitizeHtml, htmlToMarkdown } from './sanitize.js';

/** 正文过短阈值：选中子树纯文本低于此长度时降级用 body 全文。 */
const MIN_ARTICLE_CHARS = 200;

/** id/class 命中正文候选的关键词。 */
const CANDIDATE_RE = /post|article|content|entry|main/i;

/** JSON-LD 中视为文章节点的 @type。 */
const ARTICLE_TYPES = new Set(['article', 'blogposting', 'newsarticle']);

// ---------------------------------------------------------------- 元数据

/** 收集 <meta> 键值：property(og 系) 与 name(twitter 系 / author / description) 两本账。 */
function collectMeta(tree) {
  const byProperty = {};
  const byName = {};
  for (const el of walkElements(tree)) {
    if (el.tag !== 'meta') continue;
    const content = (el.attrs.content ?? '').trim();
    if (!content) continue;
    const property = (el.attrs.property ?? '').trim().toLowerCase();
    const name = (el.attrs.name ?? '').trim().toLowerCase();
    if (property && !(property in byProperty)) byProperty[property] = content;
    if (name && !(name in byName)) byName[name] = content;
  }
  return { byProperty, byName };
}

/** 展开 JSON-LD 候选节点：顶层数组、@graph、单对象都拍平成列表。 */
function flattenJsonLd(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
  } else if (node && typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenJsonLd(node['@graph'], out);
  }
  return out;
}

/** 从 JSON-LD 脚本中提取文章元数据（headline/author.name/datePublished）。 */
function jsonLdArticle(tree) {
  for (const el of walkElements(tree)) {
    if (el.tag !== 'script') continue;
    const type = (el.attrs.type ?? '').trim().toLowerCase();
    if (!type.startsWith('application/ld+json')) continue;
    let parsed;
    try { parsed = JSON.parse(textOf(el, { skipHidden: false })); } catch { continue; }
    for (const node of flattenJsonLd(parsed)) {
      const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']])
        .map(t => String(t ?? '').toLowerCase());
      if (!types.some(t => ARTICLE_TYPES.has(t))) continue;
      const title = node.headline ?? node.name ?? '';
      let author = '';
      const authors = Array.isArray(node.author) ? node.author : [node.author];
      for (const a of authors) {
        if (typeof a === 'string' && a.trim()) { author = a.trim(); break; }
        if (a && typeof a === 'object' && String(a.name ?? '').trim()) { author = String(a.name).trim(); break; }
      }
      return {
        title: String(title ?? '').trim(),
        author,
        publishedAt: String(node.datePublished ?? node.dateCreated ?? '').trim(),
      };
    }
  }
  return null;
}

/** 取 <title> 文本，并去掉 " - 站点名" 类后缀（仅当后缀与已知站点名匹配时）。 */
function titleOf(tree, siteName) {
  for (const el of walkElements(tree)) {
    if (el.tag !== 'title') continue;
    let title = textOf(el, { skipHidden: false }).replace(/\s+/g, ' ').trim();
    if (title && siteName) {
      const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = title.replace(new RegExp(`\\s*[-–—|·:]\\s*${esc}\\s*$`, 'i'), '').trim();
      if (stripped) title = stripped;
    }
    return title;
  }
  return '';
}

/** publishedAt 兜底：第一个带 datetime 的 <time>。 */
function timeDatetime(tree) {
  for (const el of walkElements(tree)) {
    if (el.tag !== 'time') continue;
    const dt = (el.attrs.datetime ?? '').trim();
    if (dt) return dt;
  }
  return '';
}

/** 日期规范化：可解析则转 ISO，否则保留原文裁断。 */
function normalizeDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    try { return new Date(t).toISOString(); } catch { /* 保留原文 */ }
  }
  return s.slice(0, 64);
}

// ---------------------------------------------------------------- 正文候选打分

/** 子树内 <p> 文本总长（段落文本密度的分子）。 */
function paragraphTextLen(el) {
  let len = 0;
  for (const node of walkElements(el)) {
    if (node.tag === 'p') len += textOf(node).replace(/\s+/g, '').length;
  }
  return len;
}

/** 子树内 <a> 文本总长（链接密度分子）。 */
function linkTextLen(el) {
  let len = 0;
  for (const node of walkElements(el)) {
    if (node.tag === 'a') len += textOf(node).replace(/\s+/g, '').length;
  }
  return len;
}

/** 打分：段落文本量 × (1 - 链接密度)；<article>/<main> 略加权。 */
function scoreCandidate(el) {
  const total = textOf(el).replace(/\s+/g, '').length;
  if (total < 40) return 0; // 太短的块不参与竞争
  const para = paragraphTextLen(el);
  const linkDensity = Math.min(linkTextLen(el) / total, 1);
  const tagBonus = el.tag === 'article' || el.tag === 'main' ? 1.2 : 1;
  return (para + total * 0.2) * (1 - linkDensity) * tagBonus;
}

/** 选出正文子树：<article>/<main>/[role=main]/id|class 含关键词的块，按密度打分取最优，兜底 body。 */
function pickArticleRoot(tree) {
  let body = null;
  let best = null;
  let bestScore = 0;
  for (const el of walkElements(tree)) {
    if (el.tag === 'body' && !body) body = el;
    const isCandidate =
      el.tag === 'article' || el.tag === 'main' ||
      (el.attrs.role ?? '').trim().toLowerCase() === 'main' ||
      CANDIDATE_RE.test(`${el.attrs.id ?? ''} ${el.attrs.class ?? ''}`);
    if (!isCandidate) continue;
    const score = scoreCandidate(el);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  const fallback = body ?? tree;
  if (!best) return fallback;
  // 正文过短（<200 字）时降级用 body 全文
  const chosenLen = textOf(best).replace(/\s+/g, '').length;
  if (chosenLen < MIN_ARTICLE_CHARS && body && best !== body) {
    const bodyLen = textOf(body).replace(/\s+/g, '').length;
    if (bodyLen > chosenLen) return body;
  }
  return best;
}

// ---------------------------------------------------------------- 主入口

/**
 * 从完整 HTML 提取文章：{title, html, markdown, meta}。
 * meta = {siteName, author, publishedAt, lang, excerpt}（缺省均为空串）。
 */
export function extractArticle(html, url = '') {
  const tree = parseHtml(html);
  const { byProperty, byName } = collectMeta(tree);
  const ld = jsonLdArticle(tree);

  const siteName = (byProperty['og:site_name'] ?? '').trim();
  const title =
    (ld?.title ?? '') ||
    (byProperty['og:title'] ?? byName['twitter:title'] ?? '').trim() ||
    titleOf(tree, siteName);

  const author = (ld?.author ?? '') || (byName['author'] ?? '').trim();
  const publishedAt = normalizeDate(
    ld?.publishedAt || byProperty['article:published_time'] || byName['date'] || timeDatetime(tree),
  );

  let lang = '';
  for (const el of walkElements(tree)) {
    if (el.tag === 'html') { lang = (el.attrs.lang ?? '').trim(); break; }
  }

  const root = pickArticleRoot(tree);
  const cleanHtml = sanitizeHtml(serializeChildren(root));
  const markdown = htmlToMarkdown(cleanHtml);

  const excerpt =
    (byProperty['og:description'] ?? byName['twitter:description'] ?? byName['description'] ?? '').trim() ||
    textOf(root).replace(/\s+/g, ' ').trim().slice(0, 160);

  return {
    title: title.slice(0, 300),
    html: cleanHtml,
    markdown,
    meta: {
      siteName: siteName.slice(0, 120),
      author: author.slice(0, 120),
      publishedAt,
      lang: lang.slice(0, 32),
      excerpt: excerpt.slice(0, 300),
    },
  };
}
