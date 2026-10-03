/**
 * 权威数据 store：data.json 单文档，原子写 + debounce + .bak 备份 + 损坏自愈。
 * 纯 Node 模块（root 由外部注入），模板参照 qiaomu-rss store.js 并加强韧性：
 *  - 读取顺序：data.json → data.json.bak → 空态（绝不 crash）
 *  - 每次 flush 前把当前良好副本滚到 .bak
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultData, defaultSettings } from '../shared/protocol.js';

export class LaunchpadStore {
  constructor(paths, logger = console) {
    this.paths = paths;               // fslayout.paths(root)
    this.logger = logger;
    this.data = defaultData();
    this.saveTimer = undefined;
    this.saving = Promise.resolve();
    this.loadedFrom = 'empty';        // 'file' | 'backup' | 'empty'（诊断用）
  }

  async load() {
    try {
      const raw = await readFile(this.paths.dataFile, 'utf8');
      this.data = this.merge(JSON.parse(raw));
      this.loadedFrom = 'file';
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.(`dsh-launchpad: data.json 读取失败（${error.message}），尝试 .bak`);
      } else {
        this.loadedFrom = 'empty';
        return; // 首次启动：空态，无备份可试
      }
    }
    try {
      const raw = await readFile(this.paths.dataBackup, 'utf8');
      this.data = this.merge(JSON.parse(raw));
      this.loadedFrom = 'backup';
      this.logger.warn?.('dsh-launchpad: 已从 data.json.bak 恢复');
    } catch {
      this.data = defaultData();
      this.loadedFrom = 'empty';
      this.logger.warn?.('dsh-launchpad: 备份亦不可用，以空态启动（可在设置页执行恢复扫描）');
    }
  }

  /** 前向兼容合并：未知字段保留，settings 深合默认。 */
  merge(parsed) {
    const base = defaultData();
    const merged = { ...base, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    merged.settings = { ...defaultSettings(), ...(parsed?.settings ?? {}) };
    return merged;
  }

  /** 500ms debounce 调度写盘。 */
  touch() {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush().catch(error => this.logger.warn?.(`dsh-launchpad: 保存失败 ${error.message}`));
    }, 500);
  }

  /** 串行原子写：先滚 .bak，再 tmp+rename。 */
  async flush() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.paths.dataFile), { recursive: true });
      try { await copyFile(this.paths.dataFile, this.paths.dataBackup); } catch { /* 首写无原件 */ }
      const temp = `${this.paths.dataFile}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.paths.dataFile);
    });
    return this.saving;
  }

  async dispose() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.flush().catch(() => {});
  }
}
