/**
 * 网页抓取阅读器：SSRF 防护 + 手动重定向 + 限时限量抓取 + 正文提取。
 *  - fetchAndExtract：抓页面 → extractArticle → 附带 iframe 可嵌入判定 liveOk
 *  - checkLiveOk：仅凭响应头判断能否 iframe 嵌入（X-Frame-Options / CSP frame-ancestors）
 *  - crawlSite 由 crawl.js 实现，此处再导出以保持对外入口单一
 * fetch 通过 options.fetchImpl 注入（默认 globalThis.fetch），DNS 通过 options.lookupImpl 注入（默认 node:dns），便于离线测试。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { extractArticle } from './extract.js';
export { crawlSite } from './crawl.js';

const UA = 'Mozilla/5.0 (compatible; dsh-launchpad/0.1)';
const MAX_BYTES = 4 * 1024 * 1024; // 响应上限 4MB
const TIMEOUT_MS = 20_000;         // 整条重定向链的总预算
const MAX_REDIRECTS = 5;

/** content-type 验收表：缺失时容错接受。 */
const ACCEPT_RES = {
  html: /text\/html|application\/xhtml\+xml/i,
  xml: /xml|rss|atom|text\/html|text\/plain/i,
};

// ---------------------------------------------------------------- SSRF 防护

/** 解析 IPv6 为 8 组 16 位整数（处理 :: 压缩与内嵌 IPv4）。失败返回 null。 */
function expandIpv6(ip) {
  let s = ip.toLowerCase();
  // 内嵌 IPv4：::ffff:1.2.3.4 → 补成两组十六进制
  const v4tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4tail) {
    const [_, a, b, c, d] = v4tail.map(Number);
    if ([a, b, c, d].some(x => x > 255)) return null;
    s = `${s.slice(0, v4tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return null;
  const nums = groups.map(g => Number.parseInt(g || '0', 16));
  return nums.some(x => !Number.isFinite(x) || x < 0 || x > 0xFFFF) ? null : nums;
}

/** 私网/保留地址判定：命中即不可直连。 */
function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const g = expandIpv6(ip);
    if (!g) return true; // 解析不了的 IPv6 一律按私网拒
    if (g.every(x => x === 0)) return true;                          // :: 未指定
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true; // ::1 回环
    if ((g[0] & 0xFE00) === 0xFC00) return true;                     // fc00::/7 ULA
    if ((g[0] & 0xFFC0) === 0xFE80) return true;                     // fe80::/10 链路本地
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xFFFF) {      // ::ffff:a.b.c.d 映射
      return isPrivateV4((g[6] >> 8) & 0xFF, g[6] & 0xFF, (g[7] >> 8) & 0xFF, g[7] & 0xFF);
    }
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  return isPrivateV4(...parts);
}

function isPrivateV4(a, b) {
  if (a === 0) return true;                    // 0.0.0.0/8
  if (a === 10) return true;                   // RFC1918
  if (a === 127) return true;                  // 回环
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;     // RFC1918
  if (a === 169 && b === 254) return true;     // 链路本地
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                   // 组播/保留/广播
  return false;
}

const isIpv4Literal = host => /^(\d{1,3}\.){3}\d{1,3}$/.test(host);

/**
 * SSRF 校验：仅 http/https；禁 localhost/*.local/*.internal 与私网 IP（字面或 DNS 解析结果）。
 * allowPrivateNetworks 为 true 时全部放行（用户设置项）。
 */
async function assertPublicUrl(url, { allowPrivateNetworks = false, lookupImpl = dnsLookup } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('无效 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https URL');
  if (allowPrivateNetworks) return u;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`拒绝访问内网主机名：${host}`);
  }
  if (isIpv4Literal(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error(`拒绝访问内网地址：${host}`);
    return u;
  }
  let records;
  try { records = await lookupImpl(host, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`DNS 解析失败：${host}（${error.message}）`); }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw new Error(`DNS 无结果：${host}`);
  for (const record of list) {
    if (isPrivateIp(record.address)) throw new Error(`拒绝访问解析到内网的域名：${host} → ${record.address}`);
  }
  return u;
}

// ---------------------------------------------------------------- 抓取链

/** 流式读取响应体，超 MAX_BYTES 截断并取消后续读取。 */
async function readBodyCapped(res, max = MAX_BYTES) {
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength ?? value.length ?? 0;
        chunks.push(Buffer.from(value));
        if (size > max) { try { await reader.cancel(); } catch { /* 忽略 */ } break; }
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* 忽略 */ }
    }
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
  }
  const text = await res.text();
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 手动跟随重定向（≤5 跳，每跳重新 SSRF 校验），整条链共享 20s 超时预算。
 * 返回 {res, finalUrl}——响应体未消费，由调用方读取或取消。
 */
async function fetchChain(url, options = {}, { accept = 'html', extraHeaders = {} } = {}) {
  const { fetchImpl = globalThis.fetch } = options;
  if (typeof fetchImpl !== 'function') throw new Error('无可用 fetch 实现');
  let current = String(url);
  await assertPublicUrl(current, options);
  const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  const acceptRe = ACCEPT_RES[accept] ?? ACCEPT_RES.html;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...extraHeaders,
      },
    });
    const status = res.status ?? 0;
    if (status >= 300 && status < 400) {
      const location = res.headers?.get?.('location');
      try { await res.body?.cancel?.(); } catch { /* 忽略 */ }
      if (!location) throw new Error(`HTTP ${status} 缺少 Location`);
      if (hop >= MAX_REDIRECTS) throw new Error('重定向次数过多（>5）');
      current = new URL(location, current).href;
      await assertPublicUrl(current, options); // 每跳重新校验，防重定向进内网
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase();
    if (contentType && !acceptRe.test(contentType)) throw new Error(`不支持的内容类型：${contentType}`);
    return { res, finalUrl: current };
  }
}

/** 抓取并读回文本（crawl.js 复用：base 页面 / feed / sitemap）。 */
export async function fetchText(url, options = {}, accept = 'html') {
  const { res, finalUrl } = await fetchChain(url, options, { accept });
  const text = await readBodyCapped(res);
  return { text, finalUrl, headers: res.headers };
}

// ---------------------------------------------------------------- liveOk 判定

/**
 * 由响应头判断页面能否被 iframe 嵌入：
 *  - X-Frame-Options: DENY / SAMEORIGIN → false
 *  - CSP frame-ancestors 出现且不含 * → false（面板 origin 无法预知，'self'/'none'/指定域都按不可嵌入）
 */
export function liveOkFromHeaders(headers) {
  const get = name => String(headers?.get?.(name) ?? '');
  const xfo = get('x-frame-options').toLowerCase();
  if (/\b(deny|sameorigin)\b/.test(xfo)) return false;
  const csp = get('content-security-policy');
  const m = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp);
  if (m && !/(^|\s)\*(\s|$|;)/.test(m[1])) return false;
  return true;
}

// ---------------------------------------------------------------- 对外接口

/**
 * 抓取 URL 并提取正文。
 * 返回 {url, finalUrl, title, html, markdown, meta, liveOk}；SSRF/协议/状态错误一律抛异常。
 */
export async function fetchAndExtract(url, options = {}) {
  const { res, finalUrl } = await fetchChain(url, options, { accept: 'html' });
  const liveOk = liveOkFromHeaders(res.headers); // 复用本次响应头，不二次请求
  const html = await readBodyCapped(res);
  const article = extractArticle(html, finalUrl);
  return { url: String(url), finalUrl, title: article.title, html: article.html, markdown: article.markdown, meta: article.meta, liveOk };
}

/**
 * 轻量探测页面是否允许 iframe 嵌入（Range: bytes=0-0，读头后即中断）。
 * 网络或校验出错一律 false。
 */
export async function checkLiveOk(url, options = {}) {
  try {
    const { res } = await fetchChain(url, options, { accept: 'html', extraHeaders: { range: 'bytes=0-0' } });
    const ok = liveOkFromHeaders(res.headers);
    try { await res.body?.cancel?.(); } catch { /* 忽略 */ }
    return ok;
  } catch {
    return false;
  }
}
