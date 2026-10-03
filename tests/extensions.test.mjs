/** 扩展注册表 + AI 直出 + 内置种子 单元测试（node:test，离线）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ExtensionRegistry } from '../src/host/extensions.js';
import { complete, createCompletionGuard } from '../src/host/ai.js';
import { validateExtensionManifest } from '../src/shared/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const silentLogger = { info() {}, warn() {}, error() {} };

/** 造一个含 2 个 builtin 种子的假 seedDir。 */
async function makeSeedDir(base) {
  const seedDir = join(base, 'seed');
  const seeds = [
    { id: 'alpha-ext', name: '阿尔法', prompt: 'alpha prompt v1' },
    { id: 'beta-ext', name: '贝塔', prompt: 'beta prompt v1' },
  ];
  for (const seed of seeds) {
    const dir = join(seedDir, seed.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'extension.json'), JSON.stringify({
      id: seed.id, name: seed.name, icon: '🧪', version: 1, source: 'builtin',
      description: '测试种子', scopes: ['page'], kind: 'chat-task',
    }, null, 2), 'utf8');
    await writeFile(join(dir, 'prompt.md'), seed.prompt, 'utf8');
  }
  return seedDir;
}

async function makeRegistry(t) {
  const base = await mkdtemp(join(tmpdir(), 'lp-ext-'));
  const seedDir = await makeSeedDir(base);
  const root = join(base, 'data');
  const registry = new ExtensionRegistry(root, silentLogger, { seedDir });
  t.after(async () => {
    registry.dispose();
    await rm(base, { recursive: true, force: true });
  });
  return { registry, root, seedDir, base };
}

test('播种：首启复制 2 个种子且全部 valid', async (t) => {
  const { registry, root } = await makeRegistry(t);
  await registry.start();
  const list = registry.list();
  assert.equal(list.length, 2);
  assert.ok(list.every(entry => entry.valid));
  const alpha = registry.get('alpha-ext');
  assert.equal(alpha.manifest.name, '阿尔法');
  assert.equal(alpha.prompt, 'alpha prompt v1');
  // .seedhash 已写入
  const seedhash = await readFile(join(root, 'extensions', 'alpha-ext', '.seedhash'), 'utf8');
  assert.match(seedhash.trim(), /^[0-9a-f]{64}$/);
});

test('播种升级：用户未改 → 被官方新版覆盖；用户改过 → 保留', async (t) => {
  const { registry, root, seedDir } = await makeRegistry(t);
  await registry.start();

  // 用户修改 beta-ext 的 prompt（哈希偏离 .seedhash）
  await writeFile(join(root, 'extensions', 'beta-ext', 'prompt.md'), 'user edited prompt', 'utf8');
  // 官方升级两个种子
  await writeFile(join(seedDir, 'alpha-ext', 'prompt.md'), 'alpha prompt v2', 'utf8');
  await writeFile(join(seedDir, 'beta-ext', 'prompt.md'), 'beta prompt v2', 'utf8');

  // 重新起一个 registry（模拟重启）触发播种
  const registry2 = new ExtensionRegistry(root, silentLogger, { seedDir });
  t.after(() => registry2.dispose());
  await registry2.start();

  assert.equal(registry2.get('alpha-ext').prompt, 'alpha prompt v2'); // 未改 → 覆盖
  assert.equal(registry2.get('beta-ext').prompt, 'user edited prompt'); // 改过 → 保留
});

test('扫描：坏 manifest 不 throw，entry.valid=false + errors', async (t) => {
  const { registry, root } = await makeRegistry(t);
  await mkdir(join(root, 'extensions', 'broken-ext'), { recursive: true });
  await writeFile(join(root, 'extensions', 'broken-ext', 'extension.json'), '{oops', 'utf8');
  await mkdir(join(root, 'extensions', 'bad-scope'), { recursive: true });
  await writeFile(join(root, 'extensions', 'bad-scope', 'extension.json'), JSON.stringify({
    id: 'bad-scope', name: 'x', version: 1, scopes: ['mars'], kind: 'chat-task',
  }), 'utf8');
  await registry.start();
  const broken = registry.get('broken-ext');
  assert.equal(broken.valid, false);
  assert.match(broken.errors[0], /解析失败/);
  const badScope = registry.get('bad-scope');
  assert.equal(badScope.valid, false);
  assert.ok(badScope.errors.length > 0);
  assert.equal(registry.list().filter(e => e.valid).length, 2); // 两个好种子不受影响
});

test('save：坏 manifest 拒绝；好 manifest 落盘可取', async (t) => {
  const { registry, root } = await makeRegistry(t);
  await registry.start();
  await assert.rejects(
    () => registry.save({ manifest: { id: 'BAD ID', name: 'x', version: 1, scopes: ['page'], kind: 'chat-task' }, prompt: '' }),
    /校验失败/,
  );
  const result = await registry.save({
    manifest: { id: 'my-ext', name: '我的扩展', version: 1, scopes: ['page'], kind: 'chat-task' },
    prompt: '你好 {{material.title}}',
  });
  assert.equal(result.id, 'my-ext');
  assert.equal(result.manifest.source, 'user'); // 归一化默认值
  const saved = JSON.parse(await readFile(join(root, 'extensions', 'my-ext', 'extension.json'), 'utf8'));
  assert.equal(saved.name, '我的扩展');
  assert.equal(registry.get('my-ext').prompt, '你好 {{material.title}}');
});

test('remove：目录消失；非法 id 拒绝', async (t) => {
  const { registry, root } = await makeRegistry(t);
  await registry.start();
  await assert.rejects(() => registry.remove('../evil'), /无效扩展 id/);
  await registry.remove('alpha-ext');
  assert.equal(registry.get('alpha-ext'), null);
  await assert.rejects(() => readdir(join(root, 'extensions', 'alpha-ext')), /ENOENT/);
  assert.equal(registry.list().length, 1);
});

// ---------------------------------------------------------------------------
// ai.complete
// ---------------------------------------------------------------------------

function mockCtx(chunks) {
  return {
    get(name) {
      assert.equal(name, 'agentDefaultModel');
      return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
    },
    llm: {
      stream(opts) {
        assert.equal(opts.provider, 'p');
        assert.equal(opts.model, 'm');
        assert.ok(Array.isArray(opts.messages) && opts.messages.length === 2);
        return (async function* () { for (const chunk of chunks) yield chunk; })();
      },
    },
  };
}

test('ai.complete：拼接 text-delta 并去外层代码围栏', async () => {
  const text = await complete(mockCtx([
    { type: 'text-delta', text: '```html\n<ht' },
    { type: 'text-delta', text: 'ml>ok</html>\n```' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), { system: 's', user: 'u' });
  assert.equal(text, '<html>ok</html>');
});

test('ai.complete：finish reason error → 抛错', async () => {
  await assert.rejects(
    () => complete(mockCtx([
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } },
    ]), { system: 's', user: 'u' }),
    /boom/,
  );
});

test('ai.complete：空输出 → 抛错', async () => {
  await assert.rejects(
    () => complete(mockCtx([{ type: 'finish', reason: { kind: 'stop' } }]), { system: 's', user: 'u' }),
    /没有产出|为空/,
  );
});

test('ai guard：同 key 串行复用 promise', async () => {
  const guard = createCompletionGuard();
  let calls = 0;
  const run = () => { calls++; return Promise.resolve('done'); };
  const [a, b] = await Promise.all([guard('k', run), guard('k', run)]);
  assert.equal(a, 'done');
  assert.equal(b, 'done');
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// 包内 12 个真实种子
// ---------------------------------------------------------------------------

test('内置 12 个扩展种子全部过校验且 prompt.md 非空', async () => {
  const seedsDir = join(packageRoot, 'extensions');
  const dirs = (await readdir(seedsDir, { withFileTypes: true }))
    .filter(d => d.isDirectory()).map(d => d.name).sort();
  assert.deepEqual(dirs, [
    'bilingual-card', 'deep-questions', 'learning-path', 'mindmap-card',
    'page-summary', 'quiz-cards', 'selection-explain', 'selection-note',
    'selection-translate', 'share-card', 'site-guide', 'weekly-digest',
  ]);
  for (const name of dirs) {
    const raw = JSON.parse(await readFile(join(seedsDir, name, 'extension.json'), 'utf8'));
    const { ok, manifest, errors } = validateExtensionManifest(raw);
    assert.ok(ok, `${name}: ${errors.join('；')}`);
    assert.equal(manifest.id, name, `${name}: manifest.id 须与目录名一致`);
    assert.equal(manifest.source, 'builtin');
    const prompt = await readFile(join(seedsDir, name, 'prompt.md'), 'utf8');
    assert.ok(prompt.trim().length > 0, `${name}: prompt.md 为空`);
  }
});
