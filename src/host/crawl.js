/**
 * 站点抓取：recent-posts（feed → sitemap → shallow 三级兜底）/ toc（目录前缀链接）/ shallow（首页+一级链接）。
 * 单页失败跳过不中断；候选超过 limit 时截断并标 truncated。
 * 与 reader.js 存在循环 import（reader 再导出 crawlSite），双方只用函数声明，提升后调用安全。
 */
import { fetchAndExtract, fetchText } from './reader.js';
import { parseHtml, walkElements, decodeEntities } from './sanitize.js';

/** 默认 feed 候选路径（同源）。 */
const FEED_PATHS = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/index.xml'];

// ---------------------------------------------------------------- XML 小工具（正则级，够用即可）

/** 剥 CDATA、去标签、解实体、折叠空白。 */
function xmlText(fragment, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(fragment);
  if (!m) return '';
  const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(raw.replace(/<[^>]+>/g, '')).trim();
}

/** Atom <link>：优先 rel="alternate"（或缺省 rel）的 href。 */
function atomLink(entry) {
  const links = [...entry.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const pick = links.find(t => /rel\s*=\s*["']alternate["']/i.test(t))
    ?? links.find(t => !/rel\s*=/i.test(t))
    ?? links[0];
  if (!pick) return '';
  const href = /\bhref\s*=\s*"([^"]*)"/i.exec(pick) ?? /\bhref\s*=\s*'([^']*)'/i.exec(pick);
  return decodeEntities(href?.[1] ?? '').trim();
}

/** 日期解析 → ISO；不可解析返回 ''。 */
function toIso(raw) {
  const t = Date.parse(String(raw ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** 解析 RSS2 / Atom 为条目列表 [{title, url, date}]（保持文档顺序）。 */
export function parseFeed(xml, feedUrl) {
  const text = String(xml ?? '');
  const entries = [];
  if (/<rss[\s>]/i.test(text) || /<rdf[\s>]/i.test(text)) {
    for (const m of text.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)) {
      const frag = m[0];
      const url = xmlText(frag, 'link') || xmlText(frag, 'guid');
      if (!url) continue;
      entries.push({
        title: xmlText(frag, 'title'),
        url: absolutize(url, feedUrl),
        date: toIso(xmlText(frag, 'pubDate') || xmlText(frag, 'dc:date') || xmlText(frag, 'updated')),
      });
    }
  } else if (/<feed[\s>]/i.test(text)) {
    for (const m of text.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)) {
      const frag = m[0];
      const url = atomLink(frag);
      if (!url) continue;
      entries.push({
        title: xmlText(frag, 'title'),
        url: absolutize(url, feedUrl),
        date: toIso(xmlText(frag, 'published') || xmlText(frag, 'updated')),
      });
    }
  }
  return entries;
}

/** 解析 sitemap <urlset>：[{url, lastmod}]（保持文档顺序）。 */
function parseSitemapUrls(xml, sitemapUrl) {
  const out = [];
  for (const m of String(xml).matchAll(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi)) {
    const loc = xmlText(m[0], 'loc');
    if (!loc) continue;
    out.push({ url: absolutize(loc, sitemapUrl), lastmod: toIso(xmlText(m[0], 'lastmod')) });
  }
  return out;
}

/** sitemapindex → 子 sitemap 地址列表。 */
function parseSitemapIndex(xml, sitemapUrl) {
  const out = [];
  for (const m of String(xml).matchAll(/<sitemap(?:\s[^>]*)?>[\s\S]*?<\/sitemap>/gi)) {
    const loc = xmlText(m[0], 'loc');
    if (loc) out.push(absolutize(loc, sitemapUrl));
  }
  return out;
}

/** 相对地址绝对化（失败返回原文）。 */
function absolutize(href, base) {
  try { return new URL(href, base).href; } catch { return String(href ?? ''); }
}

const sameOrigin = (a, b) => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

// ---------------------------------------------------------------- 策略实现

/** 逐条抓取并收集页面；单页失败跳过。pages 元素 {url,title,markdown,html,meta,publishedAt}。 */
async function harvest(candidates, options, dates = new Map()) {
  const pages = [];
  for (const url of candidates) {
    try {
      const r = await fetchAndExtract(url, options);
      pages.push({
        url: r.finalUrl ?? url,
        title: r.title,
        markdown: r.markdown,
        html: r.html,
        meta: r.meta,
        publishedAt: r.meta?.publishedAt || dates.get(url) || null,
      });
    } catch { /* 单页失败跳过，不中断整体 */ }
  }
  return pages;
}

/** 收集页面上的链接：同源 + 路径前缀匹配（可选）+ 去锚点 + 去重 + 保序。 */
function collectLinks(html, pageUrl, { pathPrefix = null, excludeSelf = true } = {}) {
  const tree = parseHtml(html);
  const base = new URL(pageUrl);
  const seen = new Set();
  const out = [];
  for (const el of walkElements(tree)) {
    if (el.tag !== 'a') continue;
    const href = (el.attrs.href ?? '').trim();
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    let u;
    try { u = new URL(href, pageUrl); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    if (u.origin !== base.origin) continue;
    if (pathPrefix !== null && !u.pathname.startsWith(pathPrefix)) continue;
    const key = u.href;
    if (excludeSelf && key === base.href) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 在 base 页面里找 <link rel=alternate type=application/rss+xml|atom+xml> 声明的 feed。 */
function discoverFeedLinks(html, pageUrl) {
  const tree = parseHtml(html);
  const out = [];
  for (const el of walkElements(tree)) {
    if (el.tag !== 'link') continue;
    const type = (el.attrs.type ?? '').toLowerCase();
    if (type !== 'application/rss+xml' && type !== 'application/atom+xml') continue;
    const href = (el.attrs.href ?? '').trim();
    if (href) out.push(absolutize(href, pageUrl));
  }
  return out;
}

/** recent-posts：feed（link 声明 → 默认路径）→ sitemap → shallow。 */
async function crawlRecentPosts(baseUrl, { sinceDays, limit, options }) {
  const origin = new URL(baseUrl).origin;
  const now = Date.now();
  const windowMs = sinceDays > 0 ? sinceDays * 86_400_000 : 0;
  const inWindow = iso => !windowMs || (now - Date.parse(iso)) <= windowMs;

  // 1) feed 候选：base 页 <link> 声明（可跨源，SSRF 仍生效）→ 同源默认路径
  let declared = [];
  try {
    const { text, finalUrl } = await fetchText(baseUrl, options, 'html');
    declared = discoverFeedLinks(text, finalUrl);
  } catch { /* base 页拿不到也继续试默认路径 */ }
  const feedCandidates = [...new Set([...declared, ...FEED_PATHS.map(p => origin + p)])];
  let entries = [];
  for (const feedUrl of feedCandidates) {
    try {
      const { text, finalUrl } = await fetchText(feedUrl, options, 'xml');
      const parsed = parseFeed(text, finalUrl);
      if (parsed.length) { entries = parsed; break; }
    } catch { /* 试下一个候选 */ }
  }

  if (entries.length) {
    // 有日期且 sinceDays>0 时按窗口过滤；无日期条目保留（受 limit 截断）
    const filtered = entries.filter(e => !e.date || inWindow(e.date));
    const chosen = filtered.slice(0, limit);
    const dates = new Map(entries.map(e => [e.url, e.date || null]));
    const pages = await harvest(chosen.map(e => e.url), options, dates);
    return { pages, truncated: filtered.length > limit };
  }

  // 2) sitemap 兜底：<url><loc>+<lastmod> 过滤，按 lastmod 倒序取 limit
  let urls = [];
  try {
    let { text, finalUrl } = await fetchText(origin + '/sitemap.xml', options, 'xml');
    if (/<sitemapindex[\s>]/i.test(text)) {
      const children = parseSitemapIndex(text, finalUrl).filter(u => sameOrigin(u, origin));
      if (!children.length) throw new Error('空 sitemapindex');
      ({ text, finalUrl } = await fetchText(children[0], options, 'xml'));
    }
    urls = parseSitemapUrls(text, finalUrl).filter(u => sameOrigin(u.url, origin));
  } catch { /* 无 sitemap */ }

  if (urls.length) {
    const filtered = urls.filter(u => !u.lastmod || inWindow(u.lastmod));
    // lastmod 倒序，无日期的排最后（保持原相对顺序）
    const dated = filtered.filter(u => u.lastmod).sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod));
    const undated = filtered.filter(u => !u.lastmod);
    const chosen = [...dated, ...undated].slice(0, limit);
    const pages = await harvest(chosen.map(u => u.url), options, new Map(chosen.map(u => [u.url, u.lastmod || null])));
    return { pages, truncated: filtered.length > chosen.length };
  }

  // 3) 再兜底退化为 shallow
  return crawlShallow(baseUrl, { limit, options });
}

/** toc：同源且路径以 base 路径开头的链接，保文档顺序。 */
async function crawlToc(baseUrl, { limit, options }) {
  const { text, finalUrl } = await fetchText(baseUrl, options, 'html');
  const pathPrefix = new URL(finalUrl).pathname;
  const links = collectLinks(text, finalUrl, { pathPrefix });
  const pages = await harvest(links.slice(0, limit), options);
  return { pages, truncated: links.length > limit };
}

/** shallow：base 页面本身 + 其同源一级链接（合计 ≤ limit）。 */
async function crawlShallow(baseUrl, { limit, options }) {
  const first = await fetchAndExtract(baseUrl, options); // base 抓不到则整体失败
  const pages = [{
    url: first.finalUrl ?? baseUrl,
    title: first.title,
    markdown: first.markdown,
    html: first.html,
    meta: first.meta,
    publishedAt: first.meta?.publishedAt || null,
  }];
  const { text, finalUrl } = await fetchText(baseUrl, options, 'html').catch(() => ({ text: '', finalUrl: baseUrl }));
  const links = text ? collectLinks(text, finalUrl, {}) : [];
  const room = Math.max(limit - 1, 0);
  pages.push(...await harvest(links.slice(0, room), options));
  return { pages, truncated: links.length > room };
}

// ---------------------------------------------------------------- 主入口

/**
 * crawlSite({baseUrl, strategy, sinceDays=0, limit=20, allowPrivateNetworks=false, fetchImpl})
 * → {pages, truncated}；pages 元素 {url,title,markdown,html,meta,publishedAt}（publishedAt 可 null）。
 */
export async function crawlSite({
  baseUrl,
  strategy = 'shallow',
  sinceDays = 0,
  limit = 20,
  allowPrivateNetworks = false,
  fetchImpl,
  lookupImpl,
} = {}) {
  const u = new URL(baseUrl); // 非法 URL 直接抛
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https URL');
  const options = { allowPrivateNetworks, fetchImpl, lookupImpl };
  const args = { sinceDays: Math.max(Number(sinceDays) || 0, 0), limit: Math.max(Number(limit) || 20, 1), options };
  if (strategy === 'recent-posts') return crawlRecentPosts(u.href, args);
  if (strategy === 'toc') return crawlToc(u.href, args);
  return crawlShallow(u.href, args);
}
