/**
 * tools/ 目录监视：agent 直接写文件也能被发现（publish 工具调用的兜底通道）。
 * 纯 Node ESM（禁 @deepseek-ai 依赖，可被单元测试直接 import）。
 *
 * 契约：new ToolWatcher({root, logger, onToolState})
 *  - root = 插件数据根；监视 <root>/tools/<toolId>/
 *  - start()：① 全量扫描已存在的 tools/<id>/ 并逐个回调；
 *    ② fs.watch(toolsDir, {recursive:true}) 监听变更，事件 debounce 500ms 后
 *    重扫变化目录并回调；watch 不可用（平台不支持 recursive / 目录缺失）时
 *    降级为 setInterval 3000ms 全量重扫
 *  - onToolState(toolId, {hasManifest, hasEntry, manifest})：
 *      hasManifest = manifest.json 存在且 JSON 可解析
 *      hasEntry    = index.html 存在且 trim 后非空
 *      manifest    = 解析出的对象或 null
 *    回调抛错（或返回 rejected promise）只记 logger.warn，绝不炸 watcher
 *  - 只对 protocol.js isSafeId 通过的目录名回调
 *  - 去重：内部按状态指纹记忆，只有状态真正变化才再次回调
 *  - dispose()：关闭 watcher / 定时器 / debounce
 */
import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isSafeId } from '../shared/protocol.js';

const DEBOUNCE_MS = 500;
const POLL_MS = 3000;
const MISSING_STATE = { hasManifest: false, hasEntry: false, manifest: null };

export class ToolWatcher {
  constructor({ root, logger = console, onToolState = null } = {}) {
    if (!root) throw new Error('ToolWatcher: root 必填');
    this.root = root;
    this.toolsDir = join(root, 'tools');
    this.logger = logger;
    this.onToolState = onToolState;
    this.states = new Map();     // toolId → 状态指纹（去重，只在变化时回调）
    this.pending = new Set();    // debounce 收集的变化目录 id
    this.pendingFull = false;    // watch 事件缺文件名 → 退化为全量重扫
    this._debounce = null;
    this._pollTimer = null;
    this._watcher = null;
    this._started = false;
    this._disposed = false;
  }

  start() {
    if (this._started || this._disposed) return;
    this._started = true;
    void this._fullScan(); // ① 启动时全量扫描，逐个回调
    this._watch();         // ② 监视后续变更
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._debounce);
    this._debounce = null;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    this.pending.clear();
  }

  // ------------------------------------------------------------------ 扫描

  /** 扫描单个工具目录，产出 {state, fingerprint}（目录缺失/文件缺失 → 对应 false）。 */
  async _scanTool(toolId) {
    const dir = join(this.toolsDir, toolId);
    let hasEntry = false;
    let hasManifest = false;
    let manifest = null;
    let manifestRaw = '';
    try {
      const entry = await readFile(join(dir, 'index.html'), 'utf8');
      hasEntry = entry.trim().length > 0;
    } catch { /* index.html 缺失或不可读 */ }
    try {
      manifestRaw = await readFile(join(dir, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(manifestRaw);
      hasManifest = true;
      manifest = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch { /* manifest.json 缺失或 JSON 损坏 */ }
    const fingerprint = createHash('sha1')
      .update(String(hasEntry)).update('|')
      .update(String(hasManifest)).update('|')
      .update(manifestRaw)
      .digest('hex');
    return { state: { hasManifest, hasEntry, manifest }, fingerprint };
  }

  /** 状态变化才回调；回调异常只记日志，绝不炸 watcher。 */
  _emit(toolId, state, fingerprint) {
    if (this._disposed) return;
    if (this.states.get(toolId) === fingerprint) return;
    this.states.set(toolId, fingerprint);
    try {
      const result = this.onToolState?.(toolId, state);
      if (result && typeof result.catch === 'function') {
        result.catch(error => this._warn(`onToolState(${toolId}) 异常：${error?.message ?? error}`));
      }
    } catch (error) {
      this._warn(`onToolState(${toolId}) 异常：${error?.message ?? error}`);
    }
  }

  async _scanAndEmit(toolId) {
    if (this._disposed || !isSafeId(toolId)) return;
    let scanned;
    try {
      scanned = await this._scanTool(toolId);
    } catch (error) {
      this._warn(`扫描工具目录失败 ${toolId}：${error?.message ?? error}`);
      return;
    }
    this._emit(toolId, scanned.state, scanned.fingerprint);
  }

  /** 全量扫描：现有目录逐个回调；上轮已知、本轮消失的目录补发全 false 状态。 */
  async _fullScan() {
    if (this._disposed) return;
    const seen = new Set();
    let dirents = [];
    try {
      dirents = await readdir(this.toolsDir, { withFileTypes: true });
    } catch { /* tools/ 目录尚不存在 */ }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !isSafeId(dirent.name)) continue;
      seen.add(dirent.name);
      await this._scanAndEmit(dirent.name);
      if (this._disposed) return;
    }
    for (const toolId of [...this.states.keys()]) {
      if (!seen.has(toolId)) this._emit(toolId, MISSING_STATE, 'missing');
    }
  }

  // ------------------------------------------------------------------ 监视

  _watch() {
    if (this._disposed) return;
    try {
      this._watcher = watch(this.toolsDir, { recursive: true }, (_event, filename) => this._onFsEvent(filename));
      this._watcher.on('error', () => this._fallbackPoll()); // recursive 平台不支持 → 降级轮询
    } catch {
      this._fallbackPoll(); // 目录缺失等同步失败 → 降级轮询
    }
  }

  _fallbackPoll() {
    if (this._watcher) { try { this._watcher.close(); } catch {} this._watcher = null; }
    if (this._pollTimer || this._disposed) return;
    this._pollTimer = setInterval(() => void this._fullScan(), POLL_MS);
    this._pollTimer.unref?.();
  }

  _onFsEvent(filename) {
    if (this._disposed) return;
    if (typeof filename !== 'string' || !filename) {
      this.pendingFull = true; // 无法定位目录：全量重扫兜底
    } else {
      const toolId = filename.split(/[\\/]/)[0];
      if (isSafeId(toolId)) this.pending.add(toolId);
    }
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => void this._flush(), DEBOUNCE_MS);
    this._debounce.unref?.();
  }

  async _flush() {
    if (this._disposed) return;
    if (this.pendingFull) {
      this.pendingFull = false;
      this.pending.clear();
      await this._fullScan();
      return;
    }
    const ids = [...this.pending];
    this.pending.clear();
    for (const toolId of ids) {
      await this._scanAndEmit(toolId);
      if (this._disposed) return;
    }
  }

  _warn(message) {
    try { this.logger?.warn?.(`dsh-launchpad: ToolWatcher ${message}`); } catch {}
  }
}
