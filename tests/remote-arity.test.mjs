/** 契约回归：client Remote 描述符元数 必须等于 host 方法签名元数（网关按 host 签名推导）。
 *  此类 bug 两次线上爆出（0 参调用 1 参描述符 / 1 参调用 0 参描述符），以源码静态分析防复发。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function remoteExports() {
  const src = await readFile(join(root, 'src/host/service.js'), 'utf8');
  const block = src.match(/const names = \[([\s\S]*?)\];/);
  assert.ok(block, 'service.js 缺 Remote 导出名单');
  return [...block[1].matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
}

async function zeroArgMethods() {
  const src = await readFile(join(root, 'src/host/service.js'), 'utf8');
  return [...src.matchAll(/async ([a-zA-Z]+)\(\) \{/g)].map(m => m[1]);
}

async function clientDescriptors() {
  const src = await readFile(join(root, 'src/client/index.jsx'), 'utf8');
  const descriptorNoArg = [];
  const descriptorParam = [];
  // 逐段匹配 ...[...].map(name => method(name)) 与 ...[...].map(name => method(name, false))
  for (const match of src.matchAll(/\.\.\.\[([\s\S]*?)\]\s*\.map\(name => method\(name(, false)?\)\)/g)) {
    const names = [...match[1].matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
    if (match[2]) descriptorNoArg.push(...names); else descriptorParam.push(...names);
  }
  assert.ok(descriptorNoArg.length > 0 && descriptorParam.length > 0, 'index.jsx 描述符清单解析失败');
  const noargSet = src.match(/NOARG = new Set\(\[([^\]]+)\]\)/);
  assert.ok(noargSet, 'index.jsx 缺 NOARG 集合');
  const callNoArg = [...noargSet[1].matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
  return { descriptorNoArg, callNoArg, descriptorParam };
}

test('Remote 元数三方对齐：host 签名 ↔ client 描述符 ↔ 调用兜底', async () => {
  const exported = await remoteExports();
  const zeroArg = (await zeroArgMethods()).filter(name => exported.includes(name));
  const { descriptorNoArg, callNoArg, descriptorParam } = await clientDescriptors();

  assert.deepEqual([...zeroArg].sort(), [...descriptorNoArg].sort(), '零参 host 方法 ≠ 零参 client 描述符');
  assert.deepEqual([...descriptorNoArg].sort(), [...callNoArg].sort(), '零参描述符 ≠ NOARG 调用兜底集合');

  const all = [...descriptorNoArg, ...descriptorParam].sort();
  assert.deepEqual(all, [...exported].sort(), 'client 描述符未覆盖全部 Remote 方法，或有多余');
});
