/**
 * Forge 端到端测试（host 级，真实 service 代码）：
 * 「一句话 → prepareForge → 模拟 agent 写产物 → 上架 → 状态流转 → 扩展注册运行」全链路。
 *
 * 原理：把 src/ 复制到临时目录，仅将 service.js/tools.js 里的 @deepseek-ai/*
 * 导入改写为本地桩（TypertRemoteService/Remote/resolveDshHome/defineTool），
 * 其余代码 1:1 为生产实现——测试覆盖的是真实 service 编排逻辑。
 *
 * 运行：node scripts/forge-e2e.mjs
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = await mkdtemp(join(tmpdir(), 'lp-e2e-src-'));
const DATA_HOME = await mkdtemp(join(tmpdir(), 'lp-forge-e2e-'));
process.env.DSH_HOME = DATA_HOME; // 先于服务 import 设置（桩 resolveDshHome 读它）

// ---- 复制 src 并改写 @deepseek-ai 导入为桩 ---------------------------------
await cp(join(PKG, 'src'), join(WORK, 'src'), { recursive: true });
await writeFile(join(WORK, 'src/host/__stubs__.js'), `
export class TypertRemoteService { constructor(ctx, ns) { this.__ns = ns; } }
export const Remote = () => () => {};
export const resolveDshHome = () => process.env.DSH_HOME;
export const defineTool = (def) => def;
`, 'utf8');

async function rewrite(rel, replacements) {
  const file = join(WORK, rel);
  let text = await readFile(file, 'utf8');
  for (const [from, to] of replacements) text = text.replace(from, to);
  await writeFile(file, text, 'utf8');
}
await rewrite('src/host/service.js', [
  [`import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';`,
   `import { TypertRemoteService, Remote } from './__stubs__.js';`],
  [`import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';`,
   `import { resolveDshHome } from './__stubs__.js';`],
]);
await rewrite('src/host/tools.js', [
  [`import { defineTool } from '@deepseek-ai/dsh-tools';`,
   `import { defineTool } from './__stubs__.js';`],
]);

const { LaunchpadService } = await import(join(WORK, 'src/host/service.js'));

const registeredTools = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  inject: () => () => {},
  tools: { register: (t) => registeredTools.push(t) },
  timeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
  effect: (fn) => fn,
  get: () => undefined,
  webServer: { register: () => () => {} },
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
const check = (ok, message) => { assert.ok(ok, message); passed++; console.log(`  ✓ ${message}`); };

const service = new LaunchpadService(ctx, {});
await service.ready;
const root = join(DATA_HOME, 'storages', 'dsh-launchpad');
console.log(`数据根: ${root}`);

async function waitToolStatus(id, status, rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await sleep(400);
    const tool = (await service.listTools()).tools[id];
    if (tool?.status === status) return tool;
  }
  return (await service.listTools()).tools[id];
}

// ---- 1. 造工具 · 目录监视兜底通道（agent 只写文件，不调 publish）-----------
console.log('\n[1] 造工具 · ToolWatcher 兜底上架');
const forge1 = await service.prepareForge({ kind: 'tool', oneLiner: '一个番茄钟', sessionId: null });
check(/^tl_/.test(forge1.id), `prepareForge 返回工具 id ${forge1.id}`);
check(forge1.prompt.includes(`${forge1.id}/index.html`) && forge1.prompt.includes('launchpad_publish_tool'), '锻造提示词自包含（产物路径+publish 协议）');
check((await service.listTools()).tools[forge1.id]?.status === 'forging', '初始状态 forging');
const toolDir = join(root, 'tools', forge1.id);
await mkdir(toolDir, { recursive: true });
await writeFile(join(toolDir, 'index.html'), '<html><body>🍅</body></html>', 'utf8');
await writeFile(join(toolDir, 'manifest.json'), JSON.stringify({ version: 1, id: forge1.id, title: '番茄钟', icon: '🍅', entry: 'index.html' }), 'utf8');
let tool = await waitToolStatus(forge1.id, 'ready');
check(tool?.status === 'ready', 'ToolWatcher 发现产物并自动上架 ready');
check(tool?.title === '番茄钟' && tool?.icon === '🍅', '标题/图标取自 manifest');
check((await service.listState()).items.some(item => item.kind === 'tool' && item.toolId === forge1.id), '导航里出现工具卡片（工具即收藏）');

console.log('\n[2] 产物目录被删 → missing；重新生成 → ready');
await rm(toolDir, { recursive: true, force: true });
tool = await waitToolStatus(forge1.id, 'missing');
check(tool?.status === 'missing', '目录删除后状态 missing（索引保留）');
await mkdir(toolDir, { recursive: true });
await writeFile(join(toolDir, 'index.html'), '<html><body>🍅 v2</body></html>', 'utf8');
await writeFile(join(toolDir, 'manifest.json'), JSON.stringify({ version: 1, id: forge1.id, title: '番茄钟', icon: '🍅' }), 'utf8');
tool = await waitToolStatus(forge1.id, 'ready');
check(tool?.status === 'ready', '重新生成后恢复 ready');

console.log('\n[3] 主通道 publishTool + 失败上报 + 重试 + 删除');
const forge2 = await service.prepareForge({ kind: 'tool', oneLiner: '汇率换算', sessionId: 'sess-1' });
await assert.rejects(() => service.publishTool({ id: forge2.id }), /index\.html/, '产物缺失时 publishTool 拒绝');
const dir2 = join(root, 'tools', forge2.id);
await mkdir(dir2, { recursive: true });
await writeFile(join(dir2, 'index.html'), '<html>fx</html>', 'utf8');
check((await service.publishTool({ id: forge2.id, title: '汇率换算', icon: '💱' })).tool.status === 'ready', 'publishTool 主通道上架');
await service.reportForge({ id: forge2.id, status: 'failed', error: '测试失败' });
check((await service.listTools()).tools[forge2.id].status === 'failed', 'reportForge 标记 failed');
const retry = await service.retryTool({ id: forge2.id });
check(retry.prompt.includes(forge2.id) && (await service.listTools()).tools[forge2.id].status === 'forging', 'retryTool 回到 forging 并返回提示词');
await service.removeTool({ id: forge2.id });
check(!(await service.listTools()).tools[forge2.id], 'removeTool 删除索引');
check(!(await service.listState()).items.some(item => item.toolId === forge2.id), 'removeTool 同步移除导航卡片');

console.log('\n[4] 加扩展：prepareForge → saveExtension → 运行 → 移除');
const forgeExt = await service.prepareForge({ kind: 'extension', oneLiner: '把文章变成播客稿' });
check(forgeExt.prompt.includes('extension.json') && forgeExt.prompt.includes(forgeExt.id), '扩展锻造提示词包含 manifest 规约与目录');
await assert.rejects(() => service.saveExtension({ manifest: { id: 'BAD ID!!', version: 1 }, prompt: 'x' }), undefined, '坏 manifest 被拒绝');
const saved = await service.saveExtension({
  manifest: {
    id: 'podcast-draft', name: '播客稿', icon: '🎙', version: 1, source: 'agent',
    scopes: ['page', 'selection'], kind: 'chat-task', description: '把文章改写成播客口播稿', prompt: 'prompt.md',
  },
  prompt: '把 {{material.title}} 改写成播客口播稿：口语化、有串场、控制在 800 字。选中段落：{{selection.quote}}',
});
check(saved.id === 'podcast-draft', 'saveExtension 落盘');
check((await service.listExtensions()).extensions.some(e => e.id === 'podcast-draft' && e.valid), 'listExtensions 可见新扩展');
const run = await service.runExtension({
  id: 'podcast-draft',
  target: { scope: 'selection', url: 'https://example.com/article', title: '示例', selection: { quote: '人工智能正在改变软件开发。' } },
});
check(run.kind === 'chat-task' && run.prompt.includes('播客口播稿') && run.prompt.includes('人工智能'), 'runExtension 渲染模板（含选区变量）返回 prompt');
check(run.bundle.selection.quote.includes('人工智能'), '材料包带选区');
await service.removeExtension({ id: 'podcast-draft' });
check(!(await service.listExtensions()).extensions.some(e => e.id === 'podcast-draft'), 'removeExtension 移除');

console.log('\n[5] agent 工具面（launchpad_*）注册与执行');
const toolNames = registeredTools.map(t => t.name).sort();
for (const name of ['launchpad_list_items', 'launchpad_add_item', 'launchpad_remove_item', 'launchpad_run_extension',
  'launchpad_save_extension', 'launchpad_remove_extension', 'launchpad_publish_tool', 'launchpad_report_forge',
  'launchpad_add_note', 'launchpad_list_tools']) {
  check(toolNames.includes(name), `工具注册：${name}`);
}
const publishToolDef = registeredTools.find(t => t.name === 'launchpad_publish_tool');
const forge3 = await service.prepareForge({ kind: 'tool', oneLiner: '倒计时', sessionId: null });
const dir3 = join(root, 'tools', forge3.id);
await mkdir(dir3, { recursive: true });
await writeFile(join(dir3, 'index.html'), '<html>⏳</html>', 'utf8');
await publishToolDef.execute({ id: forge3.id, title: '倒计时', icon: '⏳' }, { signal: new AbortController().signal });
check((await service.listTools()).tools[forge3.id]?.status === 'ready', 'agent 工具通路上架成功');
const addItemDef = registeredTools.find(t => t.name === 'launchpad_add_item');
await addItemDef.execute({ title: '少数派', url: 'https://sspai.com' }, { signal: new AbortController().signal });
check((await service.listState()).items.some(item => item.url === 'https://sspai.com'), 'agent 工具加收藏成功');

console.log(`\n✅ Forge e2e 全部通过：${passed} 项断言`);
service.watcher?.dispose?.();
service.extensions?.dispose?.();
await rm(WORK, { recursive: true, force: true });
await rm(DATA_HOME, { recursive: true, force: true });
process.exit(0);
