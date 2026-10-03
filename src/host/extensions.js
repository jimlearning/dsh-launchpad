/**
 * 扩展注册表：extensions/<extId>/ 目录为权威（extension.json + prompt.md）。
 * 纯 Node ESM（无 @deepseek-ai 依赖），可被单元测试直接 import。
 *
 * 职责：
 *  ① 内置扩展播种（source:builtin；用户未改 + 官方升级 → 覆盖；用户改过 → 保留）
 *  ② 全量扫描（坏 manifest → entry.valid=false + errors，绝不 throw）
 *  ③ 目录热加载（fs.watch recursive；平台不支持时降级 4s 轮询；300ms 防抖）
 *
 * 接口契约：new ExtensionRegistry(root, logger, options)
 *   .start() .list() .get(id) .save({manifest, prompt}) .remove(id) .onChange(fn) .dispose()
 */
import { existsSync, watch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSafeId, validateExtensionManifest } from '../shared/protocol.js';

const DEBOUNCE_MS = 300;
const POLL_MS = 4000;

/**
 * 内置扩展种子目录。源码布局（src/host/extensions.js）下 ../../extensions/ 即包根
 * extensions/；esbuild 打包成 lib/index.js 后 import.meta.url 上移一层（lib/../extensions）。
 * 逐个候选探测，取第一个真实存在的目录。
 */
function defaultSeedDir() {
  for (const rel of ['../../extensions/', '../extensions/']) {
    try {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(dir)) return dir;
    } catch { /* 继续下一个候选 */ }
  }
  return fileURLToPath(new URL('../../extensions/', import.meta.url));
}

/** extension.json + prompt.md 拼接内容的 sha256（种子指纹）。 */
function hashFiles(...contents) {
  const hash = createHash('sha256');
  for (const content of contents) hash.update(content);
  return hash.digest('hex');
}

async function readOr(file, fallback = '') {
  try { return await readFile(file, 'utf8'); } catch { return fallback; }
}

/** 相对路径安全校验：拒绝路径穿越与绝对路径。 */
function safeRel(rel, fallback = 'prompt.md') {
  return (typeof rel === 'string' && rel && !rel.includes('..') && !rel.startsWith('/')) ? rel : fallback;
}

export class ExtensionRegistry {
  constructor(root, logger = null, options = {}) {
    this.root = root;
    this.logger = logger;
    this.dir = join(root, 'extensions');
    this.seedDir = options.seedDir ?? defaultSeedDir();
    this.entries = new Map();      // entry.id → {id, manifest, prompt, valid, errors}
    this.listeners = new Set();
    this._chain = Promise.resolve(); // start/扫描/save/remove 全排队
    this._started = null;
    this._watcher = null;
    this._pollTimer = null;
    this._debounce = null;
    this._disposed = false;
  }

  _warn(line) { this.logger?.warn?.(`dsh-launchpad: ${line}`); }

  _enqueue(task) {
    const run = this._chain.then(() => task());
    this._chain = run.catch(() => {}); // 前序失败不阻塞后续任务
    return run;
  }

  /** 启动：①播种 ②全量扫描 ③起监视。幂等（重复调用返回同一 promise）。 */
  start() {
    this._started ??= this._enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      await this._seedBuiltins();
      await this._rescan();
      this._watch();
    });
    return this._started;
  }

  // ------------------------------------------------------------------ 播种

  async _seedBuiltins() {
    let dirents;
    try { dirents = await readdir(this.seedDir, { withFileTypes: true }); }
    catch { return; } // 无种子目录（裁剪安装）——不是错误
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isSafeId(dirent.name)) continue;
      try { await this._seedOne(dirent.name); }
      catch (error) { this._warn(`播种扩展 ${dirent.name} 失败：${error.message}`); }
    }
  }

  async _seedOne(name) {
    const src = join(this.seedDir, name);
    const manifestText = await readOr(join(src, 'extension.json'), null);
    if (manifestText === null) return; // 只处理含 extension.json 的目录
    let raw;
    try { raw = JSON.parse(manifestText); }
    catch { this._warn(`种子 ${name} 的 extension.json 无法解析，跳过`); return; }
    if (raw?.source !== 'builtin') return;
    const promptText = await readOr(join(src, 'prompt.md'));
    const seedHash = hashFiles(manifestText, promptText);

    const dest = join(this.dir, name);
    const seedHashFile = join(dest, '.seedhash');
    const destStat = await stat(dest).catch(() => null);
    if (!destStat) {
      // 目标不存在 → 整体复制并记录种子指纹
      await cp(src, dest, { recursive: true });
      await writeFile(seedHashFile, `${seedHash}\n`, 'utf8');
      return;
    }
    const recorded = (await readOr(seedHashFile, '')).trim();
    if (!recorded) return; // 用户自建同名目录（非播种产物）→ 不动
    const currentHash = hashFiles(
      await readOr(join(dest, 'extension.json')),
      await readOr(join(dest, 'prompt.md')),
    );
    if (currentHash === recorded && seedHash !== recorded) {
      // 用户未改 + 官方升级 → 覆盖并更新指纹；用户改过（哈希不符）→ 保留
      await rm(dest, { recursive: true, force: true });
      await cp(src, dest, { recursive: true });
      await writeFile(seedHashFile, `${seedHash}\n`, 'utf8');
    }
  }

  // ------------------------------------------------------------------ 扫描

  async _rescan() {
    const next = new Map();
    let dirents = [];
    try { dirents = await readdir(this.dir, { withFileTypes: true }); }
    catch { /* extensions 目录缺失 → 空表 */ }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isSafeId(dirent.name)) continue;
      const entry = await this._readEntry(dirent.name);
      next.set(entry.id, entry); // manifest.id 与目录名冲突时后者覆盖前者
    }
    this.entries = next;
  }

  async _readEntry(dirName) {
    const base = join(this.dir, dirName);
    const text = await readOr(join(base, 'extension.json'), null);
    if (text === null) {
      return { id: dirName, manifest: null, prompt: '', valid: false, errors: ['缺少 extension.json'] };
    }
    let raw;
    try { raw = JSON.parse(text); }
    catch (error) {
      return { id: dirName, manifest: null, prompt: '', valid: false, errors: [`extension.json 解析失败：${error.message}`] };
    }
    const { ok, manifest, errors } = validateExtensionManifest(raw);
    const promptRel = safeRel(ok ? manifest.prompt : raw?.prompt);
    const prompt = await readOr(join(base, promptRel)); // 缺省 ''
    if (!ok) return { id: dirName, manifest: raw, prompt, valid: false, errors };
    return { id: manifest.id, manifest, prompt, valid: true, errors: [] };
  }

  // ------------------------------------------------------------------ 查询

  list() {
    return [...this.entries.values()]
      .map(entry => ({ id: entry.id, manifest: entry.manifest, prompt: entry.prompt, valid: entry.valid, errors: [...entry.errors] }))
      .sort((a, b) => {
        // 按 manifest.name 排序；坏条目（无有效 manifest）按 id 排在最后
        const an = a.valid ? a.manifest.name : `￿${a.id}`;
        const bn = b.valid ? b.manifest.name : `￿${b.id}`;
        return an.localeCompare(bn, 'zh-Hans-CN');
      });
  }

  get(id) { return this.entries.get(id) ?? null; }

  // ------------------------------------------------------------------ 写入

  save({ manifest, prompt } = {}) {
    return this._enqueue(async () => {
      const { ok, manifest: normalized, errors } = validateExtensionManifest(manifest);
      if (!ok) throw new Error(`扩展清单校验失败：${errors.join('；')}`);
      const base = join(this.dir, normalized.id);
      await mkdir(base, { recursive: true });
      await this._atomicWrite(join(base, 'extension.json'), `${JSON.stringify(normalized, null, 2)}\n`);
      await this._atomicWrite(join(base, safeRel(normalized.prompt)), String(prompt ?? ''));
      await this._rescan();
      this._notify();
      return { id: normalized.id, manifest: normalized };
    });
  }

  async remove(id) {
    return this._enqueue(async () => {
      if (!isSafeId(id ?? '')) throw new Error('无效扩展 id');
      await rm(join(this.dir, id), { recursive: true, force: true });
      await this._rescan();
      this._notify();
      return { ok: true };
    });
  }

  /** 原子写：tmp + rename，避免监视者读到半截文件。 */
  async _atomicWrite(file, content) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }

  // ------------------------------------------------------------------ 监视

  _watch() {
    if (this._disposed) return;
    try {
      this._watcher = watch(this.dir, { recursive: true }, () => this._scheduleRescan());
      this._watcher.on('error', () => this._fallbackPoll()); // recursive 平台不支持 → 降级轮询
    } catch {
      this._fallbackPoll();
    }
  }

  _fallbackPoll() {
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    if (this._pollTimer || this._disposed) return;
    this._pollTimer = setInterval(() => this._scheduleRescan(), POLL_MS);
    this._pollTimer.unref?.();
  }

  _scheduleRescan() {
    if (this._disposed) return;
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this._enqueue(async () => {
        await this._rescan();
        this._notify();
      }).catch(error => this._warn(`扩展目录重扫失败：${error.message}`));
    }, DEBOUNCE_MS);
    this._debounce.unref?.();
  }

  // ------------------------------------------------------------------ 订阅

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _notify() { for (const fn of this.listeners) { try { fn(this.list()); } catch {} } }

  notify() { this._notify(); }

  dispose() {
    this._disposed = true;
    clearTimeout(this._debounce);
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    this.listeners.clear();
  }
}
