/**
 * 打包完整性门禁：发布前跑 `node scripts/verify-package.mjs`。
 * 校验：lib 产物存在且比 src 新、入口可解析、内置扩展全部合法、manifest 字段齐全。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExtensionManifest } from '../src/shared/protocol.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 缺 dsh.bundle.patch');
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'package.json 缺 dsh.client.inject');
check(pkg.files?.includes('extensions'), 'package.json files 须包含 extensions/');

for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'dsh.plugin.json']) {
  check(statSync(join(root, file), { throwIfNoEntry: false })?.isFile(), `缺少 ${file}（先 npm run build）`);
}

const newest = (dir) => {
  let max = 0;
  for (const name of readdirSync(dir, { recursive: true })) {
    try { max = Math.max(max, statSync(join(dir, name)).mtimeMs); } catch {}
  }
  return max;
};
if (statSync(join(root, 'lib/index.js'), { throwIfNoEntry: false })) {
  check(statSync(join(root, 'lib/index.js')).mtimeMs >= newest(join(root, 'src')) - 1000, 'lib/index.js 比 src 旧——重新构建');
}

const clientBundle = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(clientBundle.includes('window.__ModuleLoader__.load'), 'client bundle 缺 __ModuleLoader__ 握手');
check(clientBundle.includes('sidebar.panellist'), 'client bundle 缺 panellist 注册');

let extCount = 0;
for (const name of readdirSync(join(root, 'extensions'))) {
  const dir = join(root, 'extensions', name);
  if (!statSync(dir).isDirectory()) continue;
  extCount++;
  const manifest = JSON.parse(readFileSync(join(dir, 'extension.json'), 'utf8'));
  const { ok, errors } = validateExtensionManifest(manifest);
  check(ok, `内置扩展 ${name} 非法: ${errors?.join('; ')}`);
  check(readFileSync(join(dir, 'prompt.md'), 'utf8').trim().length > 0, `内置扩展 ${name} 缺 prompt.md`);
}
check(extCount === 12, `内置扩展应为 12 个，实际 ${extCount}`);

if (failures.length) {
  console.error('verify-package 失败:');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`verify-package 通过（内置扩展 ${extCount} 个）`);
