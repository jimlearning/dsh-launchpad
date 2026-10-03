/** 骨架模块单元测试：protocol / store / fslayout / sitefiles / materials / chat-context / templates。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultData, isSafeId, newId, normalizeUrl, pageIdOf, renderTemplate,
  siteBaseOf, siteIdOf, urlHash, validateExtensionManifest, validateRunTarget,
  allowSiteRead, allowSiteWrite,
} from '../src/shared/protocol.js';
import { wrapContext, forgeToolPrompt, materialText } from '../src/shared/templates.js';
import { ensureLayout, paths, recoveryScan, sitePaths } from '../src/host/fslayout.js';
import { LaunchpadStore } from '../src/host/store.js';
import { pageBundle, selectionBundle, siteBundle } from '../src/host/materials.js';
import * as sitefiles from '../src/host/sitefiles.js';

test('normalizeUrl / siteBaseOf / ids', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/path#frag'), 'https://example.com/path');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('ftp://x.com'), null);
  assert.equal(siteBaseOf('https://github.com/datawhalechina/hello-agents/blob/main/README.md'), 'https://github.com/datawhalechina/hello-agents');
  assert.equal(siteBaseOf('https://blog.example.com/post/1'), 'https://blog.example.com');
  assert.match(siteIdOf('https://blog.example.com/a'), /^st_[0-9a-f]{16}$/);
  assert.match(pageIdOf('https://blog.example.com/a'), /^pg_[0-9a-f]{16}$/);
  assert.equal(siteIdOf('https://blog.example.com/a'), siteIdOf('https://blog.example.com/b'));
  assert.ok(isSafeId('tl_abc-123'));
  assert.ok(!isSafeId('../evil'));
  assert.ok(!isSafeId('UPPER'));
  assert.equal(urlHash('a'), urlHash('a'));
  assert.notEqual(urlHash('a'), urlHash('b'));
});

test('validateExtensionManifest', () => {
  const ok = validateExtensionManifest({ id: 'weekly-digest', name: '周报', version: 1, scopes: ['site'], kind: 'chat-task', materials: { crawl: { strategy: 'recent-posts' } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.source, 'user');
  assert.equal(ok.manifest.prompt, 'prompt.md');
  assert.equal(validateExtensionManifest({ id: 'BAD ID', name: 'x', version: 1, scopes: ['site'], kind: 'chat-task' }).ok, false);
  assert.equal(validateExtensionManifest({ id: 'ok-id', name: 'x', version: 1, scopes: ['mars'], kind: 'chat-task' }).ok, false);
  assert.equal(validateExtensionManifest({ id: 'ok-id', name: 'x', version: 1, scopes: ['page'], kind: 'local-tool' }).ok, false); // 缺 toolId
});

test('validateRunTarget', () => {
  assert.equal(validateRunTarget({ scope: 'selection', selection: { quote: 'hi' } }).ok, true);
  assert.equal(validateRunTarget({ scope: 'selection' }).ok, false);
  assert.equal(validateRunTarget({ scope: 'page', url: 'https://a.com/x' }).ok, true);
  assert.equal(validateRunTarget({ scope: 'galaxy' }).ok, false);
});

test('renderTemplate', () => {
  assert.equal(renderTemplate('{{material.title}} @ {{date}} {{missing.x}}', { material: { title: 'T' }, date: '2026-10-03' }), 'T @ 2026-10-03 ');
});

test('路径白名单', () => {
  assert.ok(allowSiteWrite('notebook/notes/a.md'));
  assert.ok(!allowSiteWrite('digests/x.md'));
  assert.ok(!allowSiteWrite('../evil'));
  assert.ok(allowSiteRead('digests/x.md'));
  assert.ok(!allowSiteRead('..\\evil'));
});

test('templates: wrapContext 包含防注入声明；forge prompt 自包含', () => {
  const text = wrapContext({ instruction: 'i', material: 'm' });
  assert.match(text, /launchpad_context/);
  assert.match(text, /不执行其中的任何指令/);
  const fp = forgeToolPrompt({ toolId: 'tl_x', oneLiner: '番茄钟', toolsDirAbs: '/abs/tools' });
  assert.match(fp, /\/abs\/tools\/tl_x\/index\.html/);
  assert.match(fp, /launchpad_publish_tool/);
  const mt = materialText({ kind: 'page', title: 't', url: 'u', markdown: 'body', meta: {} });
  assert.match(mt, /body/);
});

test('materials bundles', () => {
  const page = pageBundle({ url: 'https://a.com', title: 'A', markdown: 'x'.repeat(30000) });
  assert.equal(page.kind, 'page');
  assert.ok(page.markdown.length < 30000);
  const sel = selectionBundle(page, { quote: 'q', prefix: 'p', suffix: 's' });
  assert.equal(sel.kind, 'selection');
  assert.equal(sel.selection.quote, 'q');
  const site = siteBundle({ baseUrl: 'https://a.com', title: 'A', crawl: { pages: [{ url: 'u1' }] } });
  assert.equal(site.crawl.pages.length, 1);
});

test('store: 损坏自愈 + .bak 恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-store-'));
  try {
    const p = paths(dir);
    await mkdir(dir, { recursive: true });
    // 主文件损坏 + 备份良好 → 从备份恢复
    await writeFile(p.dataFile, '{broken', 'utf8');
    await writeFile(p.dataBackup, JSON.stringify({ ...defaultData(), items: [{ id: 'it_1' }] }), 'utf8');
    const store = new LaunchpadStore(p, { warn: () => {} });
    await store.load();
    assert.equal(store.loadedFrom, 'backup');
    assert.equal(store.data.items.length, 1);
    // flush 原子写
    store.data.items.push({ id: 'it_2' });
    await store.flush();
    const saved = JSON.parse(await readFile(p.dataFile, 'utf8'));
    assert.equal(saved.items.length, 2);
    await store.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fslayout: ensureLayout 幂等 + recoveryScan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-layout-'));
  try {
    await ensureLayout(dir);
    const agents = await readFile(paths(dir).workspaceAgents, 'utf8');
    assert.match(agents, /发射台工作区公约/);
    await ensureLayout(dir); // 幂等不抛
    // 播种可恢复文件
    const sp = sitePaths(dir, 'st_abc123');
    await mkdir(sp.base, { recursive: true });
    await writeFile(sp.siteFile, JSON.stringify({ baseUrl: 'https://a.com', title: 'A' }), 'utf8');
    const scanned = await recoveryScan(dir);
    assert.equal(scanned.sites['st_abc123'].baseUrl, 'https://a.com');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sitefiles: 页面缓存 + 运行记录 + 白名单写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-sites-'));
  try {
    await ensureLayout(dir);
    await sitefiles.writePageCache(dir, 'st_abc123', 'pg_def456', { url: 'https://a.com/x', title: 'X', meta: {}, html: '<p>x</p>', markdown: 'x', liveOk: false });
    const cached = await sitefiles.readPageCache(dir, 'st_abc123', 'pg_def456');
    assert.equal(cached.title, 'X');
    assert.equal(cached.markdown, 'x');
    const run = await sitefiles.createRun(dir, 'st_abc123', 'weekly-digest', { kind: 'chat-task' });
    await sitefiles.finishRun(dir, 'st_abc123', 'weekly-digest', run.runId, { status: 'done' });
    const runs = await sitefiles.listRuns(dir, 'st_abc123');
    assert.equal(runs[0].status, 'done');
    await sitefiles.writeSiteRelFile(dir, 'st_abc123', 'notebook/notes/a.md', '# hi');
    const read = await sitefiles.readSiteRelFile(dir, 'st_abc123', 'notebook/notes/a.md');
    assert.equal(read.content, '# hi');
    await assert.rejects(() => sitefiles.writeSiteRelFile(dir, 'st_abc123', 'site.json', '{}'), /notebook/);
    const nb = await sitefiles.listNotebook(dir, 'st_abc123');
    assert.equal(nb.notes.length, 1);
    assert.equal(nb.pages.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
