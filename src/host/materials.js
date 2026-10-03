/**
 * MaterialBundle 构建：把页面/站点抓取/选区组装成统一材料对象。
 * 大正文落盘 spill（sites/<id>/cache/pages/ 已天然是 spill），Bundle 内只持有界内联。
 */
import { LIMITS, newId } from '../shared/protocol.js';

export function truncateInline(markdown, maxChars = LIMITS.materialInlineChars) {
  if (typeof markdown !== 'string') return { inline: '', truncated: false };
  if (markdown.length <= maxChars) return { inline: markdown, truncated: false };
  return { inline: markdown.slice(0, maxChars) + '\n\n…[已截断]', truncated: true };
}

/** page 材料。page = {url,title,markdown,meta}，spillFile 为完整正文相对插件根的路径（可选）。 */
export function pageBundle({ url, title, markdown, meta = {}, spillFile = '' }) {
  const { inline, truncated } = truncateInline(markdown);
  return {
    id: newId('mb'),
    kind: 'page',
    title: title ?? url,
    url,
    capturedAt: new Date().toISOString(),
    markdown: inline,
    spillFile: truncated ? spillFile : '',
    meta,
  };
}

/** selection 材料：在 page 材料基础上叠加选区。 */
export function selectionBundle(base, selection) {
  return {
    ...base,
    id: newId('mb'),
    kind: 'selection',
    selection: {
      quote: String(selection?.quote ?? '').slice(0, LIMITS.selectionChars),
      prefix: String(selection?.prefix ?? '').slice(0, 80),
      suffix: String(selection?.suffix ?? '').slice(0, 80),
    },
  };
}

/** site 材料：crawl 页列表 + 代表正文（首页或空）。 */
export function siteBundle({ baseUrl, title, crawl }) {
  return {
    id: newId('mb'),
    kind: 'site',
    title: title ?? baseUrl,
    url: baseUrl,
    capturedAt: new Date().toISOString(),
    markdown: '',
    spillFile: '',
    meta: { site: baseUrl },
    crawl: {
      strategy: crawl?.strategy ?? 'shallow',
      sinceDays: crawl?.sinceDays ?? 0,
      pages: (crawl?.pages ?? []).map(p => ({
        url: p.url, title: p.title ?? p.url, publishedAt: p.publishedAt ?? null, ref: p.ref ?? '',
      })),
    },
  };
}
