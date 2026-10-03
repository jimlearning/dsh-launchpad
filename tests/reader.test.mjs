/**
 * reader 栈离线测试：sanitize / extract / reader(SSRF+重定向) / crawl(三策略)。
 * 全部走 fake fetchImpl + lookupImpl，不触网。node --test tests/reader.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, htmlToMarkdown, htmlToText } from '../src/host/sanitize.js';
import { extractArticle } from '../src/host/extract.js';
import { fetchAndExtract, checkLiveOk, liveOkFromHeaders, crawlSite } from '../src/host/reader.js';
import { parseFeed } from '../src/host/crawl.js';

// ---------------------------------------------------------------- fixtures

const TEXT = '事件循环是 JavaScript 并发模型的核心，宏任务与微任务交替执行。'.repeat(6); // >200 字

const TIDY_HTML = `<!doctype html><html lang="zh-CN"><head>
<title>深入理解事件循环 - 示例博客</title>
<meta name="author" content="元数据作者">
<meta name="description" content="文章摘要描述">
<meta property="og:site_name" content="示例博客">
<meta property="og:title" content="OG 标题">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"深入理解事件循环","author":{"@type":"Person","name":"王小明"},"datePublished":"2026-09-20T08:00:00+08:00"}</script>
</head><body>
<nav>站点导航 <a href="/a">栏目</a></nav>
<article><h1>深入理解事件循环</h1><p>${TEXT}</p><p>小结：先看调用栈，再看微任务队列。</p></article>
</body></html>`;

const SOUP_HTML = `<html><head>
<title>杂乱页面 - 汤站点</title>
<meta property="og:site_name" content="汤站点">
</head><body>
<div class="container">
  <div class="header">头部横幅</div>
  <div class="post-content"><p>${TEXT}</p><p>第二段落在这里，<strong>加粗</strong>强调。</p></div>
  <div class="sidebar"><a href="/1">链接一</a><a href="/2">链接二</a><a href="/3">链接三</a></div>
</div>
</body></html>`;

/** 造一篇足够长的简单文章页。 */
const page = (title, extraHeaders) => ({
  body: `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${'正文内容，用于通过最短长度门槛。'.repeat(12)}</p></article></body></html>`,
  headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
});

const RSS_XML = ({ fresh, old }) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>示例博客</title>
<item><title>新文一</title><link>https://blog.example.com/p1</link><pubDate>${fresh}</pubDate></item>
<item><title>旧文</title><link>https://blog.example.com/p2</link><pubDate>${old}</pubDate></item>
<item><title>无日期文</title><link>https://blog.example.com/p3</link></item>
</channel></rss>`;

const SITEMAP_XML = ({ d1, d2, d3 }) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://nofeed.example.com/u1</loc><lastmod>${d1}</lastmod></url>
<url><loc>https://nofeed.example.com/u2</loc><lastmod>${d2}</lastmod></url>
<url><loc>https://nofeed.example.com/u3</loc><lastmod>${d3}</lastmod></url>
<url><loc>https://nofeed.example.com/u4</loc></url>
<url><loc>https://other.example.com/u5</loc><lastmod>${d1}</lastmod></url>
</urlset>`;

// ---------------------------------------------------------------- fake 基础设施

/** url → Response 映射表；entry 可为 {status, headers, body} 或函数。未命中返回 404。 */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = String(url);
    calls.push(key);
    const entry = typeof routes === 'function' ? await routes(key, init) : routes[key];
    if (!entry) return new Response('not found', { status: 404 });
    const r = typeof entry === 'function' ? await entry(key, init) : entry;
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'text/html; charset=utf-8' } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 公网 DNS 存根：所有域名解析到 93.184.216.34。 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

const OPTS = { lookupImpl: publicLookup };

// ---------------------------------------------------------------- sanitize

test('sanitizeHtml：剔除 script/事件属性/危险协议，解包非白名单标签', () => {
  const dirty = `<p onclick="x()">hi<script>alert(1)</script><style>.a{}</style>
<a href="javascript:alert(1)" onmouseover="x">bad</a><a href="https://ok.example" title="t">ok</a>
<a href="java\tscript:alert(2)">tab</a><img src="data:image/png;base64,AAA" onerror="x" alt="p">
<img src="data:text/html;base64,AAA"><iframe src="https://evil.example">inner</iframe>
<div style="color:red">text</div><custom>c<unknown>u</unknown></custom><form>f<input value="v"></form></p>`;
  const out = sanitizeHtml(dirty);
  assert.ok(!out.includes('<script') && !out.includes('alert(1)</script>'), 'script 剔除');
  assert.ok(!out.includes('<style') && !out.includes('.a{'), 'style 剔除');
  assert.ok(!/on\w+=/i.test(out), '事件属性剔除');
  assert.ok(!out.includes('javascript:'), 'javascript: 协议剔除');
  assert.ok(out.includes('<a href="https://ok.example" title="t">ok</a>'), '合法链接保留');
  assert.ok(out.includes('<img src="data:image/png;base64,AAA" alt="p">'), 'img data:image 保留');
  assert.ok(!out.includes('data:text/html'), '其他 data: 剔除');
  assert.ok(!out.includes('<iframe') && !out.includes('inner'), 'iframe 连内容剔除');
  assert.ok(out.includes('<div>text</div>'), 'style 属性剔除、div 保留');
  assert.ok(out.includes('cu'), '非白名单标签解包保留文本');
  assert.ok(!out.includes('f<input') && !out.includes('>f<'), 'form 连内容剔除');
});

test('sanitizeHtml：未闭合标签自动补齐，注释与 doctype 丢弃', () => {
  const out = sanitizeHtml('<!doctype html><!-- c --><div><p>one<p>two<ul><li>a<li>b</ul>');
  assert.equal(out, '<div><p>one</p><p>two</p><ul><li>a</li><li>b</li></ul></div>');
});

test('htmlToMarkdown：标题/段落/强调/链接/列表/引用/代码/表格/空行折叠', () => {
  const md = htmlToMarkdown(`<h1>T</h1><p>a <strong>b</strong> <a href="/x">l</a></p>
<ul><li>one</li><li>two</li></ul><blockquote><p>q</p></blockquote>
<pre><code>code\nline</code></pre><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<p>x</p>\n\n\n\n<p>y</p>`);
  assert.ok(md.includes('# T'));
  assert.ok(md.includes('a **b** [l](/x)'));
  assert.ok(md.includes('- one\n- two'));
  assert.ok(md.includes('> q'));
  assert.ok(md.includes('```\ncode\nline\n```'));
  assert.ok(md.includes('| A | B |\n| --- | --- |\n| 1 | 2 |'));
  assert.ok(!/\n{3,}/.test(md), '3+ 空行折叠为 2');
});

test('htmlToText：去标签、解实体、折叠空白', () => {
  assert.equal(htmlToText('<p>a &amp; b<br>c</p><script>x</script> <b>d</b>'), 'a & b c d');
});

// ---------------------------------------------------------------- extract

test('extractArticle：规整 article + JSON-LD 元数据优先', () => {
  const r = extractArticle(TIDY_HTML, 'https://blog.example.com/p/1');
  assert.equal(r.title, '深入理解事件循环', 'JSON-LD headline 优先于 og:title 与 <title>');
  assert.equal(r.meta.author, '王小明', 'JSON-LD author.name 优先于 meta author');
  assert.equal(r.meta.publishedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(r.meta.siteName, '示例博客');
  assert.equal(r.meta.lang, 'zh-CN');
  assert.equal(r.meta.excerpt, '文章摘要描述');
  assert.ok(r.markdown.includes('# 深入理解事件循环'));
  assert.ok(!r.html.includes('站点导航'), '选中 article 子树，不含 nav');
  assert.ok(r.html.includes('事件循环'));
});

test('extractArticle：div 汤按密度打分选中正文块，title 去站点后缀', () => {
  const r = extractArticle(SOUP_HTML, 'https://soup.example.com/x');
  assert.equal(r.title, '杂乱页面', '去掉 " - 汤站点" 后缀');
  assert.equal(r.meta.author, '');
  assert.equal(r.meta.publishedAt, '');
  assert.ok(r.html.includes('第二段落'));
  assert.ok(!r.html.includes('链接一'), '不选高链接密度的侧栏');
  assert.ok(!r.html.includes('头部横幅'), '不选整个 body');
});

test('extractArticle：正文过短降级 body 全文', () => {
  const html = `<html><body><article><p>短正文。</p></article><div class="comments"><p>${TEXT}</p></div></body></html>`;
  const r = extractArticle(html, 'https://x.example/');
  assert.ok(r.html.includes(TEXT.slice(0, 20)), 'article 过短时降级用 body');
});

test('extractArticle：meta 全缺省时给空串', () => {
  const r = extractArticle('<html><body><p>hi</p></body></html>');
  assert.deepEqual(Object.keys(r.meta).sort(), ['author', 'excerpt', 'lang', 'publishedAt', 'siteName']);
  assert.equal(r.meta.siteName, '');
  assert.equal(typeof r.markdown, 'string');
});

// ---------------------------------------------------------------- reader：SSRF / 重定向 / 抓取

test('SSRF：字面内网 IP 与危险主机名直接拒绝', async () => {
  const fetchImpl = makeFetch({});
  for (const url of [
    'http://192.168.1.1/', 'http://10.0.0.9/', 'http://172.16.5.5/', 'http://127.0.0.1/',
    'http://169.254.1.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fd00::1]/',
    'http://localhost/', 'http://printer.local/', 'http://nas.internal/',
  ]) {
    await assert.rejects(fetchAndExtract(url, { ...OPTS, fetchImpl }), /拒绝访问/, url);
  }
  assert.equal(fetchImpl.calls.length, 0, '拒绝时不应发起任何请求');
});

test('SSRF：DNS 解析到内网的域名拒绝；非 http 协议拒绝', async () => {
  const fetchImpl = makeFetch({});
  const evilLookup = async () => [{ address: '10.0.0.5', family: 4 }];
  await assert.rejects(
    fetchAndExtract('http://evil.example.com/', { fetchImpl, lookupImpl: evilLookup }),
    /解析到内网/,
  );
  await assert.rejects(fetchAndExtract('ftp://example.com/x', { ...OPTS, fetchImpl }), /http\/https/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('SSRF：allowPrivateNetworks 放行内网字面地址', async () => {
  const fetchImpl = makeFetch({ 'http://192.168.1.1/': page('内网页') });
  const r = await fetchAndExtract('http://192.168.1.1/', { allowPrivateNetworks: true, fetchImpl });
  assert.equal(r.title, '内网页');
});

test('重定向：跟随到最终页；重定向进内网被拒；超过 5 次报错', async () => {
  const fetchImpl = makeFetch({
    'https://a.example/start': { status: 302, headers: { location: '/final' } },
    'https://a.example/final': page('最终页'),
    'https://a.example/to-evil': { status: 302, headers: { location: 'http://192.168.1.1/' } },
    'https://a.example/loop': { status: 302, headers: { location: '/loop' } },
  });
  const ok = await fetchAndExtract('https://a.example/start', { ...OPTS, fetchImpl });
  assert.equal(ok.finalUrl, 'https://a.example/final');
  assert.equal(ok.title, '最终页');
  await assert.rejects(fetchAndExtract('https://a.example/to-evil', { ...OPTS, fetchImpl }), /内网/);
  await assert.rejects(fetchAndExtract('https://a.example/loop', { ...OPTS, fetchImpl }), /重定向次数过多/);
});

test('content-type：非 HTML 拒绝；缺失时容错接受', async () => {
  const fetchImpl = makeFetch({
    'https://a.example/doc': { body: '%PDF-1.4', headers: { 'content-type': 'application/pdf' } },
  });
  await assert.rejects(fetchAndExtract('https://a.example/doc', { ...OPTS, fetchImpl }), /内容类型/);
  // new Response(string) 会自动补 text/plain，改用裸对象模拟真正缺失 content-type 的响应
  const bareFetch = async () => ({
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => '<html><body><p>无 content-type 也接受</p></body></html>',
  });
  const r = await fetchAndExtract('https://a.example/plain', { ...OPTS, fetchImpl: bareFetch });
  assert.ok(r.html.includes('无 content-type'));
});

test('fetchAndExtract：返回契约字段，liveOk 复用本次响应头', async () => {
  const fetchImpl = makeFetch({ 'https://blog.example.com/tidy': { body: TIDY_HTML } });
  const r = await fetchAndExtract('https://blog.example.com/tidy', { ...OPTS, fetchImpl });
  assert.equal(r.url, 'https://blog.example.com/tidy');
  assert.equal(r.finalUrl, 'https://blog.example.com/tidy');
  assert.equal(r.title, '深入理解事件循环');
  assert.equal(r.liveOk, true);
  assert.ok(r.markdown.length > 200);
  assert.equal(fetchImpl.calls.length, 1, 'liveOk 不产生二次请求');
});

test('liveOk 响应头判定：XFO 与 CSP frame-ancestors', async () => {
  const h = obj => new Headers(obj);
  assert.equal(liveOkFromHeaders(h({})), true);
  assert.equal(liveOkFromHeaders(h({ 'x-frame-options': 'DENY' })), false);
  assert.equal(liveOkFromHeaders(h({ 'x-frame-options': 'SAMEORIGIN' })), false);
  assert.equal(liveOkFromHeaders(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })), false);
  assert.equal(liveOkFromHeaders(h({ 'content-security-policy': "frame-ancestors 'self'" })), false);
  assert.equal(liveOkFromHeaders(h({ 'content-security-policy': 'frame-ancestors https://a.example' })), false);
  assert.equal(liveOkFromHeaders(h({ 'content-security-policy': "frame-ancestors *; default-src 'self'" })), true);
  assert.equal(liveOkFromHeaders(h({ 'content-security-policy': "default-src 'self'" })), true);
});

test('checkLiveOk：网络出错返回 false；正常按响应头判定', async () => {
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await checkLiveOk('https://down.example/', { ...OPTS, fetchImpl: down }), false);
  const fetchImpl = makeFetch({
    'https://a.example/framed': page('x', { 'x-frame-options': 'DENY' }),
    'https://a.example/open': page('x'),
  });
  assert.equal(await checkLiveOk('https://a.example/framed', { ...OPTS, fetchImpl }), false);
  assert.equal(await checkLiveOk('https://a.example/open', { ...OPTS, fetchImpl }), true);
});

// ---------------------------------------------------------------- crawl：feed 解析单测

test('parseFeed：RSS2 与 Atom 均可解析', () => {
  const rss = parseFeed(RSS_XML({ fresh: 'Wed, 01 Oct 2026 08:00:00 GMT', old: 'Mon, 01 Jan 2020 00:00:00 GMT' }), 'https://blog.example.com/feed');
  assert.equal(rss.length, 3);
  assert.equal(rss[0].title, '新文一');
  assert.equal(rss[0].date, '2026-10-01T08:00:00.000Z');
  assert.equal(rss[2].date, '');
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title><![CDATA[甲]]></title><link rel="alternate" href="/a1"/><published>2026-09-01T00:00:00Z</published></entry>
<entry><title>乙</title><link href="/a2"/><updated>2026-09-02T00:00:00Z</updated></entry>
</feed>`, 'https://a.example/atom');
  assert.deepEqual(atom.map(e => [e.title, e.url]), [
    ['甲', 'https://a.example/a1'],
    ['乙', 'https://a.example/a2'],
  ]);
});

// ---------------------------------------------------------------- crawl：recent-posts

test('crawl recent-posts：RSS + sinceDays 过滤 + publishedAt 回填', async () => {
  const fresh = new Date(Date.now() - 2 * 86_400_000).toUTCString();
  const old = new Date(Date.now() - 200 * 86_400_000).toUTCString();
  const fetchImpl = makeFetch({
    'https://blog.example.com/': {
      body: '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>home</body></html>',
    },
    'https://blog.example.com/feed.xml': { body: RSS_XML({ fresh, old }), headers: { 'content-type': 'application/rss+xml' } },
    'https://blog.example.com/p1': page('新文一'),
    'https://blog.example.com/p2': page('旧文'),
    'https://blog.example.com/p3': page('无日期文'),
  });
  const r = await crawlSite({ baseUrl: 'https://blog.example.com/', strategy: 'recent-posts', sinceDays: 7, limit: 20, ...OPTS, fetchImpl });
  assert.deepEqual(r.pages.map(p => p.url), ['https://blog.example.com/p1', 'https://blog.example.com/p3'], '旧文被 sinceDays 过滤');
  assert.equal(r.pages[0].title, '新文一');
  assert.equal(r.pages[0].publishedAt, new Date(Date.parse(fresh)).toISOString(), 'feed 日期回填');
  assert.equal(r.pages[1].publishedAt, null, '无日期条目 publishedAt 为 null');
  assert.equal(r.truncated, false);

  const r2 = await crawlSite({ baseUrl: 'https://blog.example.com/', strategy: 'recent-posts', sinceDays: 0, limit: 1, ...OPTS, fetchImpl });
  assert.equal(r2.pages.length, 1, 'limit 生效');
  assert.equal(r2.truncated, true, '候选超 limit 时 truncated=true');
});

test('crawl recent-posts：无 feed 时退化 sitemap（lastmod 倒序+过滤+截断）', async () => {
  const d1 = new Date(Date.now() - 1 * 86_400_000).toISOString();
  const d2 = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const d3 = new Date(Date.now() - 100 * 86_400_000).toISOString();
  const fetchImpl = makeFetch({
    'https://nofeed.example.com/': { body: '<html><body>home</body></html>' },
    'https://nofeed.example.com/sitemap.xml': { body: SITEMAP_XML({ d1, d2, d3 }), headers: { 'content-type': 'application/xml' } },
    'https://nofeed.example.com/u1': page('U1'),
    'https://nofeed.example.com/u2': page('U2'),
    'https://nofeed.example.com/u3': page('U3'),
    'https://nofeed.example.com/u4': page('U4'),
  });
  const r = await crawlSite({ baseUrl: 'https://nofeed.example.com/', strategy: 'recent-posts', sinceDays: 30, limit: 20, ...OPTS, fetchImpl });
  assert.deepEqual(r.pages.map(p => p.url), [
    'https://nofeed.example.com/u1',
    'https://nofeed.example.com/u2',
    'https://nofeed.example.com/u4',
  ], 'u3 过期被滤、u5 跨源被滤、无日期 u4 排最后');
  assert.equal(r.pages[0].publishedAt, d1);
  const r2 = await crawlSite({ baseUrl: 'https://nofeed.example.com/', strategy: 'recent-posts', sinceDays: 30, limit: 2, ...OPTS, fetchImpl });
  assert.deepEqual(r2.pages.map(p => p.url), ['https://nofeed.example.com/u1', 'https://nofeed.example.com/u2']);
  assert.equal(r2.truncated, true);
});

test('crawl recent-posts：feed 与 sitemap 全灭时兜底 shallow', async () => {
  const fetchImpl = makeFetch({
    'https://bare.example.com/': {
      body: `<html><body><article><p>${'首页正文。'.repeat(40)}</p><a href="/x">x</a><a href="https://else.example.com/y">y</a></article></body></html>`,
    },
    'https://bare.example.com/x': page('X 页'),
  });
  const r = await crawlSite({ baseUrl: 'https://bare.example.com/', strategy: 'recent-posts', sinceDays: 0, limit: 20, ...OPTS, fetchImpl });
  assert.deepEqual(r.pages.map(p => p.url), ['https://bare.example.com/', 'https://bare.example.com/x'], '兜底 shallow：首页+同源一级链接');
});

// ---------------------------------------------------------------- crawl：toc / shallow

test('crawl toc：同源+路径前缀+保序+去锚点去重+limit+单页失败跳过', async () => {
  const fetchImpl = makeFetch({
    'https://docs.example.com/guide/': {
      body: `<html><body>
<a href="/guide/a">A</a><a href="/guide/b">B</a><a href="/other/c">C</a>
<a href="https://else.example.com/guide/d">D</a><a href="/guide/a#sec">A 锚点重复</a>
<a href="/guide/">自身</a><a href="/guide/broken">坏页</a>
</body></html>`,
    },
    'https://docs.example.com/guide/a': page('章节 A'),
    'https://docs.example.com/guide/b': page('章节 B'),
    'https://docs.example.com/guide/broken': { status: 500, body: 'boom' },
  });
  const r = await crawlSite({ baseUrl: 'https://docs.example.com/guide/', strategy: 'toc', limit: 10, ...OPTS, fetchImpl });
  assert.deepEqual(r.pages.map(p => p.title), ['章节 A', '章节 B'], '保文档顺序、去重去锚点、坏页跳过');
  assert.equal(r.truncated, false);
  const r2 = await crawlSite({ baseUrl: 'https://docs.example.com/guide/', strategy: 'toc', limit: 2, ...OPTS, fetchImpl });
  assert.equal(r2.pages.length, 2);
  assert.equal(r2.truncated, true, '候选 4 条（A/B/坏页/）超 limit=2');
});

test('crawl shallow：base 页面本身 + 同源一级链接', async () => {
  const fetchImpl = makeFetch({
    'https://s.example.com/': {
      body: `<html><body><article><p>${'首页。'.repeat(60)}</p>
<a href="/l1">1</a><a href="/l2">2</a><a href="https://out.example.com/x">外</a><a href="/l1#top">重</a></article></body></html>`,
    },
    'https://s.example.com/l1': page('L1'),
    'https://s.example.com/l2': page('L2'),
  });
  const r = await crawlSite({ baseUrl: 'https://s.example.com/', strategy: 'shallow', limit: 20, ...OPTS, fetchImpl });
  assert.deepEqual(r.pages.map(p => p.url), ['https://s.example.com/', 'https://s.example.com/l1', 'https://s.example.com/l2']);
  const r2 = await crawlSite({ baseUrl: 'https://s.example.com/', strategy: 'shallow', limit: 2, ...OPTS, fetchImpl });
  assert.deepEqual(r2.pages.map(p => p.url), ['https://s.example.com/', 'https://s.example.com/l1']);
  assert.equal(r2.truncated, true);
});
