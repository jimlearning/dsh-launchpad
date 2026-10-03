/** forge 工作流单元测试：ToolWatcher / resolveSafePath / mimeOf / registerRoutes 静态伺服（离线）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolWatcher } from '../src/host/forge.js';
import { mimeOf, registerRoutes, resolveSafePath } from '../src/host/routes.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** 轮询等待条件成立（fs.watch 时序不稳，一律带界重试，上限默认 5s）。 */
async function waitFor(cond, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await sleep(interval);
  }
}

/** 造一个工具目录：manifest 传对象写 JSON、传字符串写原文、传 null 不写；entry 传 null 不写。 */
async function makeTool(root, id, { manifest = { version: 1, id, title: 'T', icon: '🛠' }, entry = '<html>ok</html>' } = {}) {
  const dir = join(root, 'tools', id);
  await mkdir(dir, { recursive: true });
  if (manifest !== null) {
    const raw = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    await writeFile(join(dir, 'manifest.json'), raw, 'utf8');
  }
  if (entry !== null) await writeFile(join(dir, 'index.html'), entry, 'utf8');
  return dir;
}

test('ToolWatcher：启动全量回调 + 变更回调 + 坏 manifest + 非法目录名 + dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-forge-'));
  const calls = [];
  const watcher = new ToolWatcher({
    root: dir,
    logger: { warn: () => {} },
    onToolState: (toolId, state) => calls.push({ toolId, ...state }),
  });
  try {
    // 启动前：1 个完整工具 + 1 个非法目录名（isSafeId 不过，绝不应回调）
    await makeTool(dir, 'good-tool', { manifest: { version: 1, id: 'good-tool', title: '好工具', icon: '🛠' } });
    await makeTool(dir, 'UPPER', {});
    watcher.start();

    // ① 启动全量扫描 → 收到已存在工具的回调
    const first = await waitFor(() => calls.find(c => c.toolId === 'good-tool' && c.hasEntry));
    assert.equal(first.hasManifest, true);
    assert.equal(first.manifest.title, '好工具');

    // ② 新增工具目录 → debounce 后收到回调
    await makeTool(dir, 'new-tool', { manifest: { version: 1, id: 'new-tool', title: '新工具', icon: '⏱' } });
    const added = await waitFor(() => calls.find(c => c.toolId === 'new-tool' && c.hasManifest && c.hasEntry));
    assert.equal(added.manifest.title, '新工具');

    // ③ manifest 写坏 → hasManifest false / manifest null / hasEntry true
    await makeTool(dir, 'broken-tool', { manifest: '{broken' });
    const broken = await waitFor(() => calls.find(c => c.toolId === 'broken-tool' && c.hasEntry));
    assert.equal(broken.hasManifest, false);
    assert.equal(broken.manifest, null);

    // ④ 回调抛错不炸 watcher：换一个会抛错的回调，改动目录后仍能继续工作
    watcher.onToolState = () => { throw new Error('boom'); };
    await makeTool(dir, 'throw-tool', {});
    await sleep(1200); // 等 debounce + 扫描跑完（不应中断后续流程）
    watcher.onToolState = (toolId, state) => calls.push({ toolId, ...state });
    await makeTool(dir, 'still-works', {});
    await waitFor(() => calls.find(c => c.toolId === 'still-works' && c.hasEntry));

    // 非法目录名始终未被回调
    assert.equal(calls.some(c => c.toolId === 'UPPER'), false);

    // ⑤ dispose 后不再回调
    watcher.dispose();
    const count = calls.length;
    await makeTool(dir, 'after-dispose', {});
    await sleep(1600);
    assert.equal(calls.length, count);
  } finally {
    watcher.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveSafePath：正常解析 / .. 越界 / 绝对路径注入 / 符号链接逃逸', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-safe-'));
  try {
    const base = join(dir, 'tools', 'tl_abc');
    await mkdir(base, { recursive: true });
    const realBase = realpathSync(base);
    // 正常解析（目标不存在也返回 base 内的词法路径）
    assert.equal(resolveSafePath(base, 'index.html'), join(realBase, 'index.html'));
    assert.equal(resolveSafePath(base, 'sub/../app.js'), join(realBase, 'app.js'));
    // 存在的文件经 realpath 归一
    await writeFile(join(base, 'a.txt'), 'x', 'utf8');
    assert.equal(resolveSafePath(base, 'a.txt'), join(realBase, 'a.txt'));
    // .. 穿越与绝对路径注入抛错
    assert.throws(() => resolveSafePath(base, '../../etc/passwd'), /越界/);
    assert.throws(() => resolveSafePath(base, '/etc/passwd'), /越界/);
    if (process.platform === 'win32') {
      assert.throws(() => resolveSafePath(base, '..\\..\\win.ini'), /越界/);
    }
    // 符号链接逃逸抛错
    const outside = join(dir, 'secret.txt');
    await writeFile(outside, 's', 'utf8');
    await symlink(outside, join(base, 'link.txt'));
    assert.throws(() => resolveSafePath(base, 'link.txt'), /越界/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('mimeOf：常见后缀命中，未知后缀 null', () => {
  assert.equal(mimeOf('index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeOf('app.CSS'), 'text/css; charset=utf-8'); // 大小写不敏感
  assert.equal(mimeOf('data.json'), 'application/json; charset=utf-8');
  assert.equal(mimeOf('note.md'), 'text/markdown; charset=utf-8');
  assert.equal(mimeOf('font.woff2'), 'font/woff2');
  assert.equal(mimeOf('mod.wasm'), 'application/wasm');
  assert.equal(mimeOf('pic.png'), 'image/png');
  assert.equal(mimeOf('img.svg'), 'image/svg+xml');
  assert.equal(mimeOf('archive.tar.gz'), null);
  assert.equal(mimeOf('noext'), null);
  assert.equal(mimeOf(''), null);
});

/** 捕获式 mock ServerResponse。 */
function mockRes() {
  return {
    status: 0, headers: null, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; return this; },
    end(body) { this.body = body; },
  };
}

test('registerRoutes：health + tool/card 静态伺服 + 安全约束 + disposer 合并注销', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lp-routes-'));
  try {
    await makeTool(dir, 'tl_demo', { manifest: { version: 1, id: 'tl_demo', title: '演示', icon: '🛠' }, entry: '<html>demo</html>' });
    await mkdir(join(dir, 'sites', 'st_demo', 'cards'), { recursive: true });
    await writeFile(join(dir, 'sites', 'st_demo', 'cards', 'c1.md'), '# 卡片', 'utf8');
    await mkdir(join(dir, 'sites', 'st_demo', 'notebook'), { recursive: true });
    await writeFile(join(dir, 'sites', 'st_demo', 'notebook', 'n.md'), '私密笔记', 'utf8');

    const routes = new Map();
    const webServer = {
      register: (route) => {
        const key = `${route.kind}:${route.path}`;
        routes.set(key, route);
        return () => { routes.delete(key); };
      },
    };
    const dispose = registerRoutes({ webServer, root: dir, store: { loadedFrom: 'test' }, logger: { warn: () => {} } });
    assert.equal(routes.size, 3);

    const call = (key, url, method = 'GET') => {
      const route = routes.get(key);
      assert.ok(route, `路由未注册: ${key}`);
      const res = mockRes();
      return Promise.resolve(route.handler({ url, method }, res)).then(() => res);
    };

    // health（exact）
    const health = await call('exact:/api/launchpad/health', '/api/launchpad/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, plugin: 'dsh-launchpad', root: dir, loadedFrom: 'test' });

    // tool：空路径默认 index.html；CSP + no-store；内容正确
    const index = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.equal(index.headers['content-security-policy'], "default-src 'self' 'unsafe-inline' data: blob:");
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.match(String(index.body), /demo/);

    // manifest.json 也可伺服
    const mf = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/manifest.json');
    assert.equal(mf.status, 200);
    assert.match(mf.headers['content-type'], /application\/json/);

    // HEAD：有头无体
    const head = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/index.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);

    // 仅 GET/HEAD
    const post = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/index.html', 'POST');
    assert.equal(post.status, 405);

    // 非法 id（isSafeId 不过）
    const badId = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/UPPER/index.html');
    assert.equal(badId.status, 400);

    // 编码 .. 穿越 → 403；编码绝对路径注入 → 403
    const trav = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/..%2F..%2Fdata.json');
    assert.equal(trav.status, 403);
    const inj = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/%2Fetc%2Fpasswd');
    assert.equal(inj.status, 403);

    // 未知后缀 404；不存在文件 404
    await writeFile(join(dir, 'tools', 'tl_demo', 'x.xyz'), 'x', 'utf8');
    const unknown = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/x.xyz');
    assert.equal(unknown.status, 404);
    const missing = await call('prefix:/api/launchpad/tool', '/api/launchpad/tool/tl_demo/nope.html');
    assert.equal(missing.status, 404);

    // card：cards/ 内 .md → text/markdown
    const card = await call('prefix:/api/launchpad/card', '/api/launchpad/card/st_demo/cards/c1.md');
    assert.equal(card.status, 200);
    assert.match(card.headers['content-type'], /text\/markdown/);
    assert.match(String(card.body), /卡片/);

    // card：裸文件名默认落到 cards/（客户端拼接形态）；notebook 路径被改写到 cards/ 下而非越权伺服 → 404
    const bare = await call('prefix:/api/launchpad/card', '/api/launchpad/card/st_demo/c1.md');
    assert.equal(bare.status, 200);
    assert.match(String(bare.body), /卡片/);
    const nb = await call('prefix:/api/launchpad/card', '/api/launchpad/card/st_demo/notebook/n.md');
    assert.equal(nb.status, 404);

    // disposer 合并注销全部路由
    dispose();
    assert.equal(routes.size, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registerRoutes：webServer 缺失时降级为空 disposer', () => {
  const warnings = [];
  const dispose = registerRoutes({ webServer: null, root: '/tmp/x', logger: { warn: (m) => warnings.push(m) } });
  assert.equal(typeof dispose, 'function');
  assert.equal(warnings.length, 1);
  dispose(); // 不抛
});
