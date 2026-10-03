/**
 * LaunchpadService：`launchpad` Host 服务——导航、阅读、伴读、扩展、笔记本、Forge。
 * 模块边界：
 *  - 本文件：状态变更（data.json）、Remote 编排、伴读上下文、Forge 注册表
 *  - reader.js：抓取/提取/crawl（纯函数）
 *  - extensions.js：扩展注册表（文件为权威）
 *  - sitefiles.js：站点目录文件操作
 *  - ai.js：LLM 直出
 *  - tools.js / routes.js / forge.js：agent 工具 / HTTP 路由 / 目录监视
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  defaultSettings, FORGE_KINDS, isSafeId, ITEM_KINDS, LIMITS, newId, normalizeUrl,
  pageIdOf, renderTemplate, siteBaseOf, siteIdOf, today, validateRunTarget,
} from '../shared/protocol.js';
import { forgeExtensionPrompt, forgeToolPrompt, materialText, MATERIAL_CARD_SYSTEM, SCOPE_INSTRUCTIONS, wrapContext } from '../shared/templates.js';
import { ensureLayout, extensionPaths, paths, recoveryScan, sitePaths, toolPaths } from './fslayout.js';
import { LaunchpadStore } from './store.js';
import { ChatContextStore } from './chat-context.js';
import { pageBundle, selectionBundle, siteBundle } from './materials.js';
import * as sitefiles from './sitefiles.js';
import { crawlSite, checkLiveOk, fetchAndExtract } from './reader.js';
import { ExtensionRegistry } from './extensions.js';
import { complete as aiComplete } from './ai.js';
import { ToolWatcher } from './forge.js';
import { createToolDefinitions } from './tools.js';
import { registerRoutes } from './routes.js';

const CACHE_TTL_MS = 6 * 3600_000; // 页面缓存 6 小时

export class LaunchpadService extends TypertRemoteService {
  static inject = ['tools', 'llm', 'agentDefaultModel', 'timer', 'webServer'];

  constructor(ctx, config = {}) {
    super(ctx, 'launchpad');
    this.ctx = ctx;
    this.config = config;
    this.root = join(resolveDshHome(), 'storages', 'dsh-launchpad');
    this.paths = paths(this.root);
    this.store = new LaunchpadStore(this.paths, ctx.logger);
    this.chatContext = new ChatContextStore(this.store);
    this.extensions = new ExtensionRegistry(this.root, ctx.logger);
    this.watcher = new ToolWatcher({
      root: this.root,
      logger: ctx.logger,
      onToolState: (toolId, state) => void this.onToolDirState(toolId, state),
    });

    this.ready = (async () => {
      await this.store.load();
      await ensureLayout(this.root);
      await this.extensions.start();
      this.watcher.start();
      await this.healCrawlJobs();
      ctx.logger.info(`dsh-launchpad: 数据目录 ${this.root}（来源 ${this.store.loadedFrom}）`);
    })();

    // 伴读上下文注入（每次模型调用组装时生效；材料不进消息流）
    ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.context({
        name: 'dsh-launchpad:companion', order: 9500, interpolate: false,
        text: ({ agent }) => this.chatContext.textFor(agent),
      });
    });

    for (const tool of createToolDefinitions(this)) ctx.tools.register(tool);
    this.disposeRoutes = registerRoutes({ webServer: ctx.webServer, root: this.root, store: this.store, logger: ctx.logger });

    ctx.effect(() => () => {
      this.watcher.dispose();
      this.extensions.dispose();
      this.disposeRoutes?.();
      void this.store.dispose().catch(() => {});
    }, 'dsh-launchpad: flush on dispose');
  }

  // ------------------------------------------------------------------ helpers

  get settings() { return this.store.data.settings; }

  assertReady() { return this.ready; }

  /** ToolWatcher 回调：tools/<id>/ 目录状态变化 → 上架或标记缺失（目录监视是 publish 的兜底通道）。 */
  async onToolDirState(toolId, state) {
    try {
      await this.ready;
      const tool = this.store.data.tools[toolId];
      if (state.hasManifest && state.hasEntry) {
        if (!tool || tool.status === 'forging' || tool.status === 'failed' || tool.status === 'missing') {
          await this.publishTool({ id: toolId, title: state.manifest?.title, icon: state.manifest?.icon });
          this.ctx.logger.info?.(`dsh-launchpad: 目录监视发现工具 ${toolId}，已上架`);
        }
      } else if (tool?.status === 'ready') {
        tool.status = 'missing';
        tool.updatedAt = new Date().toISOString();
        this.store.touch();
      }
    } catch (error) {
      this.ctx.logger.warn?.(`dsh-launchpad: 工具目录同步失败 ${toolId}: ${error.message}`);
    }
  }

  findItem(id) { return this.store.data.items.find(item => item.id === id); }

  /** 确保站点记录存在（data.json 索引 + sites/<id>/ 目录 + site.json）。 */
  async ensureSite(url) {
    const base = siteBaseOf(url);
    const siteId = siteIdOf(url);
    if (!siteId || !base) throw new Error('无法从该 URL 推导站点');
    const data = this.store.data;
    if (!data.sites[siteId]) {
      data.sites[siteId] = {
        id: siteId, baseUrl: base, title: base.replace(/^https?:\/\//, ''),
        iconUrl: '', chatSessionId: null,
        createdAt: new Date().toISOString(), lastVisitedAt: null,
      };
    }
    data.sites[siteId].lastVisitedAt = new Date().toISOString();
    this.store.touch();
    await sitefiles.ensureSiteDirs(this.root, siteId);
    const existing = await sitefiles.readSiteFile(this.root, siteId);
    if (!existing) await sitefiles.writeSiteFileJson(this.root, siteId, data.sites[siteId]);
    return data.sites[siteId];
  }

  async siteTitle(siteId, fallback) {
    return this.store.data.sites[siteId]?.title ?? fallback ?? siteId;
  }

  /** 读取页面材料（优先缓存；target 给 url 时按需抓取）。 */
  async materialForTarget(target) {
    if (target.scope === 'selection') {
      const base = pageBundle({
        url: target.url ?? '', title: target.title ?? target.url ?? '选中内容',
        markdown: target.pageMarkdownExcerpt ?? '', meta: { site: target.siteId ?? '' },
      });
      return selectionBundle(base, target.selection);
    }
    const url = normalizeUrl(target.url ?? '') || (await this.urlOfCachedPage(target.siteId, target.pageId));
    if (!url) throw new Error('缺少页面 URL');
    const page = await this.openUrl({ url });
    return pageBundle({
      url: page.finalUrl ?? url, title: page.title, markdown: page.markdown,
      meta: page.meta, spillFile: `sites/${page.siteId}/cache/pages/${page.pageId}.json`,
    });
  }

  async urlOfCachedPage(siteId, pageId) {
    if (!isSafeId(siteId ?? '') || !isSafeId(pageId ?? '')) return null;
    const cached = await sitefiles.readPageCache(this.root, siteId, pageId);
    return cached?.url ?? null;
  }

  // ------------------------------------------------------------------ 状态

  async listState() {
    await this.ready;
    const d = this.store.data;
    return {
      settings: d.settings, groups: d.groups, items: d.items,
      sites: d.sites, tools: d.tools, extensionsOverlay: d.extensions,
      loadedFrom: this.store.loadedFrom, root: this.root,
    };
  }

  async health() {
    return { ok: true, root: this.root, loadedFrom: this.store.loadedFrom, version: '0.1.0' };
  }

  // ------------------------------------------------------------------ 导航

  async addItem(request) {
    await this.ready;
    const { kind, title, url = '', icon = '', groupId = null } = request ?? {};
    if (!ITEM_KINDS.includes(kind)) throw new Error(`kind 须为 ${ITEM_KINDS.join(' | ')}`);
    if (typeof title !== 'string' || !title.trim()) throw new Error('标题必填');
    let normUrl = '';
    let siteId = null;
    if (kind === 'link') {
      normUrl = normalizeUrl(url);
      if (!normUrl) throw new Error('无效的 http(s) URL');
      siteId = siteIdOf(normUrl);
    }
    if (kind === 'tool' && !isSafeId(request.toolId ?? '')) throw new Error('tool 条目须要 toolId');
    const d = this.store.data;
    const item = {
      id: newId('it'), kind, title: title.trim().slice(0, 120),
      url: normUrl || String(url).slice(0, 500),
      icon: String(icon ?? '').slice(0, 64),
      toolId: kind === 'tool' ? request.toolId : undefined,
      groupId: groupId && d.groups.some(g => g.id === groupId) ? groupId : null,
      order: d.items.length, pinned: false, siteId,
      createdAt: new Date().toISOString(), lastOpenedAt: null,
    };
    d.items.push(item);
    this.store.touch();
    return { item };
  }

  async updateItem(request) {
    await this.ready;
    const item = this.findItem(request?.id);
    if (!item) throw new Error('条目不存在');
    const patch = request?.patch ?? {};
    if (patch.title !== undefined) item.title = String(patch.title).trim().slice(0, 120) || item.title;
    if (patch.url !== undefined && item.kind === 'link') {
      const norm = normalizeUrl(patch.url);
      if (!norm) throw new Error('无效的 http(s) URL');
      item.url = norm;
      item.siteId = siteIdOf(norm);
    }
    if (patch.icon !== undefined) item.icon = String(patch.icon).slice(0, 64);
    if (patch.groupId !== undefined) item.groupId = this.store.data.groups.some(g => g.id === patch.groupId) ? patch.groupId : null;
    if (patch.pinned !== undefined) item.pinned = patch.pinned === true;
    this.store.touch();
    return { item };
  }

  async removeItem(request) {
    await this.ready;
    const d = this.store.data;
    const before = d.items.length;
    d.items = d.items.filter(item => item.id !== request?.id);
    if (d.items.length === before) throw new Error('条目不存在');
    this.store.touch();
    return { ok: true };
  }

  async reorderItems(request) {
    await this.ready;
    const ids = Array.isArray(request?.ids) ? request.ids : null;
    if (!ids) throw new Error('ids 须为数组');
    const d = this.store.data;
    const rank = new Map(ids.map((id, index) => [id, index]));
    for (const item of d.items) item.order = rank.has(item.id) ? rank.get(item.id) : ids.length + item.order;
    d.items.sort((a, b) => a.order - b.order);
    this.store.touch();
    return { ok: true };
  }

  async pinItem(request) {
    await this.ready;
    const item = this.findItem(request?.id);
    if (!item) throw new Error('条目不存在');
    item.pinned = request?.pinned !== false;
    this.store.touch();
    return { item };
  }

  async touchOpened(request) {
    await this.ready;
    const item = this.findItem(request?.id);
    if (item) { item.lastOpenedAt = new Date().toISOString(); this.store.touch(); }
    return { ok: true };
  }

  async addGroup(request) {
    await this.ready;
    const name = String(request?.name ?? '').trim().slice(0, 40);
    if (!name) throw new Error('分组名必填');
    const group = { id: newId('gr'), name, order: this.store.data.groups.length };
    this.store.data.groups.push(group);
    this.store.touch();
    return { group };
  }

  async renameGroup(request) {
    await this.ready;
    const group = this.store.data.groups.find(g => g.id === request?.id);
    if (!group) throw new Error('分组不存在');
    const name = String(request?.name ?? '').trim().slice(0, 40);
    if (!name) throw new Error('分组名必填');
    group.name = name;
    this.store.touch();
    return { group };
  }

  async removeGroup(request) {
    await this.ready;
    const d = this.store.data;
    d.groups = d.groups.filter(g => g.id !== request?.id);
    for (const item of d.items) if (item.groupId === request?.id) item.groupId = null;
    this.store.touch();
    return { ok: true };
  }

  async saveSettings(request) {
    await this.ready;
    const patch = request?.patch ?? {};
    const current = this.settings;
    const next = { ...current };
    for (const key of Object.keys(defaultSettings())) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    this.store.data.settings = next;
    this.store.touch();
    return { settings: next };
  }

  async exportData() {
    await this.ready;
    return { json: JSON.stringify(this.store.data, null, 2) };
  }

  async importData(request) {
    await this.ready;
    let parsed;
    try { parsed = JSON.parse(String(request?.json ?? '')); } catch { throw new Error('JSON 解析失败'); }
    this.store.data = this.store.merge(parsed);
    await this.store.flush();
    return { ok: true };
  }

  async recoverIndex() {
    await this.ready;
    const recovered = await recoveryScan(this.root, (line) => this.ctx.logger.warn?.(`dsh-launchpad: ${line}`));
    const d = this.store.data;
    let added = 0;
    for (const [id, site] of Object.entries(recovered.sites)) if (!d.sites[id]) { d.sites[id] = site; added++; }
    for (const [id, tool] of Object.entries(recovered.tools)) if (!d.tools[id]) { d.tools[id] = tool; added++; }
    for (const [id, ext] of Object.entries(recovered.extensions)) if (!d.extensions[id]) { d.extensions[id] = ext; added++; }
    await this.store.flush();
    return { ok: true, added };
  }

  // ------------------------------------------------------------------ 阅读

  async openUrl(request) {
    await this.ready;
    const url = normalizeUrl(request?.url ?? '');
    if (!url) throw new Error('无效的 http(s) URL');
    const siteId = siteIdOf(url);
    const pageId = pageIdOf(url);
    await this.ensureSite(url);

    const force = request?.force === true;
    if (!force) {
      const cached = await sitefiles.readPageCache(this.root, siteId, pageId);
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
        return { siteId, pageId, title: cached.title, html: cached.html, markdown: cached.markdown, meta: cached.meta, liveOk: cached.liveOk, cached: true, finalUrl: cached.url };
      }
    }

    const page = await fetchAndExtract(url, { allowPrivateNetworks: this.settings.allowPrivateNetworks });
    await sitefiles.writePageCache(this.root, siteId, pageId, {
      url: page.finalUrl ?? url, title: page.title, meta: page.meta,
      html: page.html, markdown: page.markdown, liveOk: page.liveOk,
    });
    // 站点标题首次抓取后变得更聪明
    const site = this.store.data.sites[siteId];
    if (site && page.meta?.siteName && site.title === site.baseUrl.replace(/^https?:\/\//, '')) {
      site.title = String(page.meta.siteName).slice(0, 80);
      this.store.touch();
      void sitefiles.writeSiteFileJson(this.root, siteId, site);
    }
    return { siteId, pageId, title: page.title, html: page.html, markdown: page.markdown, meta: page.meta, liveOk: page.liveOk, cached: false, finalUrl: page.finalUrl ?? url };
  }

  async getCachedPage(request) {
    await this.ready;
    const { siteId, pageId } = request ?? {};
    if (!isSafeId(siteId ?? '') || !isSafeId(pageId ?? '')) throw new Error('无效 id');
    const cached = await sitefiles.readPageCache(this.root, siteId, pageId);
    if (!cached) return { page: null };
    return { page: { siteId, pageId, title: cached.title, html: cached.html, markdown: cached.markdown, meta: cached.meta, liveOk: cached.liveOk, cached: true, finalUrl: cached.url } };
  }

  async checkLive(request) {
    await this.ready;
    const url = normalizeUrl(request?.url ?? '');
    if (!url) throw new Error('无效的 http(s) URL');
    const ok = await checkLiveOk(url, { allowPrivateNetworks: this.settings.allowPrivateNetworks });
    return { ok };
  }

  async startCrawl(request) {
    await this.ready;
    const siteId = request?.siteId;
    const site = this.store.data.sites[siteId];
    if (!site) throw new Error('站点不存在（先打开该站页面）');
    const strategy = ['recent-posts', 'toc', 'shallow'].includes(request?.strategy) ? request.strategy : 'shallow';
    const sinceDays = Math.min(Math.max(Number(request?.sinceDays) || 0, 0), 90);
    const limit = Math.min(Math.max(Number(request?.limit) || LIMITS.crawlPagesDefault, 1), LIMITS.crawlPagesMax);
    const jobId = newId('job');
    const job = { jobId, siteId, strategy, sinceDays, limit, status: 'running', pages: [], startedAt: new Date().toISOString(), doneAt: null, error: null };
    this.store.data.crawlJobs[jobId] = job;
    this.store.touch();
    // 后台执行；结果写回 job（页正文落盘 cache/pages/）
    void (async () => {
      try {
        const result = await crawlSite({
          baseUrl: site.baseUrl, strategy, sinceDays, limit,
          allowPrivateNetworks: this.settings.allowPrivateNetworks,
        });
        for (const page of result.pages) {
          const pid = pageIdOf(page.url);
          if (pid && page.markdown) {
            await sitefiles.writePageCache(this.root, siteId, pid, {
              url: page.url, title: page.title, meta: page.meta ?? {},
              html: page.html ?? '', markdown: page.markdown, liveOk: false,
            }).catch(() => {});
            page.ref = `sites/${siteId}/cache/pages/${pid}.json`;
            page.pageId = pid;
          }
        }
        job.pages = result.pages.map(p => ({ url: p.url, title: p.title, publishedAt: p.publishedAt ?? null, ref: p.ref ?? '', pageId: p.pageId ?? null }));
        job.status = 'done';
      } catch (error) {
        job.status = 'failed';
        job.error = error?.message ?? String(error);
      } finally {
        job.doneAt = new Date().toISOString();
        this.store.touch();
      }
    })();
    return { jobId };
  }

  async crawlStatus(request) {
    await this.ready;
    const job = this.store.data.crawlJobs[request?.jobId];
    if (!job) throw new Error('抓取任务不存在');
    return { job };
  }

  async healCrawlJobs() {
    const jobs = this.store.data.crawlJobs ?? {};
    for (const job of Object.values(jobs)) {
      if (job.status === 'running') { job.status = 'failed'; job.error = '宿主进程重启，任务中断'; }
    }
    // 只保留最近 50 个任务
    const ids = Object.keys(jobs).sort((a, b) => String(jobs[b].startedAt).localeCompare(String(jobs[a].startedAt)));
    for (const id of ids.slice(50)) delete jobs[id];
    this.store.touch();
  }

  // ------------------------------------------------------------------ 伴读

  async getWorkspaceInfo() {
    await this.ready;
    return { path: this.paths.workspaceDir, workspaceId: this.settings.workspaceId };
  }

  async saveWorkspaceId(request) {
    await this.ready;
    const id = String(request?.workspaceId ?? '');
    if (!id) throw new Error('workspaceId 必填');
    await this.saveSettings({ patch: { workspaceId: id } });
    return { ok: true };
  }

  async bindContext(request) {
    await this.ready;
    const { sessionId, bundle, instruction, scope } = request ?? {};
    if (!bundle || typeof bundle !== 'object') throw new Error('缺少材料包');
    const text = wrapContext({
      instruction: instruction || SCOPE_INSTRUCTIONS[scope] || SCOPE_INSTRUCTIONS.page,
      material: materialText(bundle),
    });
    await this.chatContext.bind(sessionId, text, { scope: scope ?? bundle.kind, url: bundle.url });
    return { ok: true };
  }

  async getCompanionSession(request) {
    await this.ready;
    const site = this.store.data.sites[request?.siteId];
    return { sessionId: site?.chatSessionId ?? null };
  }

  async setCompanionSession(request) {
    await this.ready;
    const site = this.store.data.sites[request?.siteId];
    if (!site) throw new Error('站点不存在');
    site.chatSessionId = typeof request?.sessionId === 'string' ? request.sessionId : null;
    this.store.touch();
    void sitefiles.writeSiteFileJson(this.root, site.id, site);
    return { ok: true };
  }

  // ------------------------------------------------------------------ 扩展

  async listExtensions() {
    await this.ready;
    const overlay = this.store.data.extensions;
    return {
      extensions: this.extensions.list().map(entry => ({
        ...entry,
        enabled: overlay[entry.id]?.enabled !== false,
      })),
    };
  }

  async setExtensionEnabled(request) {
    await this.ready;
    const id = request?.id;
    if (!this.extensions.get(id)) throw new Error('扩展不存在');
    (this.store.data.extensions[id] ??= {}).enabled = request?.enabled !== false;
    this.store.touch();
    return { ok: true };
  }

  async saveExtension(request) {
    await this.ready;
    const result = await this.extensions.save({ manifest: request?.manifest, prompt: request?.prompt });
    (this.store.data.extensions[result.id] ??= {}).source = result.manifest.source;
    this.store.touch();
    return { id: result.id, manifest: result.manifest };
  }

  async removeExtension(request) {
    await this.ready;
    await this.extensions.remove(request?.id);
    delete this.store.data.extensions[request?.id];
    this.store.touch();
    return { ok: true };
  }

  async runExtension(request) {
    await this.ready;
    const ext = this.extensions.get(request?.id);
    if (!ext?.valid) throw new Error('扩展不存在或清单损坏');
    if (this.store.data.extensions[ext.id]?.enabled === false) throw new Error('扩展已停用');
    const { ok, target, error } = validateRunTarget(request?.target);
    if (!ok) throw new Error(error);
    if (!ext.manifest.scopes.includes(target.scope)) throw new Error(`该扩展不支持 ${target.scope} 范围`);

    const m = ext.manifest;
    let bundle;
    let siteId = target.siteId ?? (target.url ? siteIdOf(target.url) : null);

    if (target.scope === 'site') {
      if (!siteId || !this.store.data.sites[siteId]) throw new Error('站点不存在');
      // 复用已完成的 crawl，或现场执行一次有界 crawl
      let crawlPages = [];
      const job = target.crawlJobId ? this.store.data.crawlJobs[target.crawlJobId] : null;
      if (job?.status === 'done') {
        crawlPages = job.pages;
      } else {
        const c = m.materials?.crawl ?? {};
        const result = await crawlSite({
          baseUrl: this.store.data.sites[siteId].baseUrl,
          strategy: c.strategy ?? 'shallow',
          sinceDays: Math.min(Number(c.sinceDays) || 0, 90),
          limit: Math.min(Number(c.limit) || LIMITS.crawlPagesDefault, LIMITS.crawlPagesMax),
          allowPrivateNetworks: this.settings.allowPrivateNetworks,
        });
        crawlPages = result.pages;
      }
      bundle = siteBundle({
        baseUrl: this.store.data.sites[siteId].baseUrl,
        title: await this.siteTitle(siteId),
        crawl: { strategy: m.materials?.crawl?.strategy ?? 'shallow', sinceDays: m.materials?.crawl?.sinceDays ?? 0, pages: crawlPages },
      });
    } else {
      bundle = await this.materialForTarget(target);
    }
    siteId = siteId ?? bundle.meta?.siteId ?? null;
    if (!siteId || !isSafeId(siteId)) throw new Error('无法确定站点归属');

    const vars = {
      material: { title: bundle.title, url: bundle.url, markdown: bundle.markdown, site: bundle.meta?.site ?? '' },
      selection: { quote: bundle.selection?.quote ?? '' },
      date: today(),
      siteId,
    };
    const prompt = renderTemplate(ext.prompt ?? '', vars);

    if (m.kind === 'chat-task') {
      const run = await sitefiles.createRun(this.root, siteId, ext.id, {
        kind: m.kind, targetScope: target.scope, url: bundle.url, status: 'prepared',
      });
      return {
        kind: 'chat-task', runId: run.runId, prompt, bundle,
        instruction: SCOPE_INSTRUCTIONS[target.scope],
        sendMode: target.scope === 'site' ? this.settings.bigTaskSendMode : this.settings.chatSendMode,
      };
    }

    if (m.kind === 'material-card') {
      if (this.settings.aiAssist === false) throw new Error('AI 助手已在设置中停用');
      const run = await sitefiles.createRun(this.root, siteId, ext.id, {
        kind: m.kind, targetScope: target.scope, url: bundle.url,
      });
      try {
        const content = await aiComplete(this.ctx, {
          system: MATERIAL_CARD_SYSTEM,
          user: `任务模板：\n${prompt}\n\n引用材料：\n${materialText(bundle)}`,
          model: this.settings.cardModel,
        });
        let relPath = null;
        if (m.output?.saveAs) {
          relPath = renderTemplate(m.output.saveAs, { ...vars, runId: run.runId });
          await sitefiles.writeSiteOutputFile(this.root, siteId, relPath, content);
        }
        await sitefiles.finishRun(this.root, siteId, ext.id, run.runId, { status: 'done', outputFile: relPath });
        return { kind: 'material-card', runId: run.runId, outputFile: relPath, content: content.slice(0, 40000) };
      } catch (err) {
        await sitefiles.finishRun(this.root, siteId, ext.id, run.runId, { status: 'failed', error: err?.message ?? String(err) });
        throw err;
      }
    }

    if (m.kind === 'local-tool') {
      const run = await sitefiles.createRun(this.root, siteId, ext.id, {
        kind: m.kind, targetScope: target.scope, url: bundle.url, status: 'prepared',
      });
      return { kind: 'local-tool', runId: run.runId, toolId: m.toolId, bundle };
    }

    if (m.kind === 'direct-action') {
      if (m.action === 'append-highlight') {
        if (!bundle.selection?.quote) throw new Error('该操作需要选中段落');
        const result = await this.appendHighlight({
          siteId,
          entry: { quote: bundle.selection.quote, url: bundle.url, pageTitle: bundle.title },
        });
        const run = await sitefiles.createRun(this.root, siteId, ext.id, {
          kind: m.kind, targetScope: target.scope, url: bundle.url, status: 'done', outputFile: 'notebook/highlights.json',
        });
        return { kind: 'direct-action', runId: run.runId, action: m.action, saved: true, count: result.count };
      }
      throw new Error(`未知 direct-action：${m.action}`);
    }

    throw new Error(`未知扩展类型 ${m.kind}`);
  }

  async listExtensionRuns(request) {
    await this.ready;
    const siteId = request?.siteId;
    if (!isSafeId(siteId ?? '')) return { runs: [] };
    return { runs: await sitefiles.listRuns(this.root, siteId, request?.extId ?? null) };
  }

  // ------------------------------------------------------------------ 笔记本

  async listNotebook(request) {
    await this.ready;
    if (!isSafeId(request?.siteId ?? '')) throw new Error('无效站点');
    return { notebook: await sitefiles.listNotebook(this.root, request.siteId) };
  }

  async readSiteFile(request) {
    await this.ready;
    if (!isSafeId(request?.siteId ?? '')) throw new Error('无效站点');
    const result = await sitefiles.readSiteRelFile(this.root, request.siteId, String(request?.relPath ?? ''));
    if (!result) throw new Error('文件不存在');
    return result;
  }

  async writeSiteFile(request) {
    await this.ready;
    if (!isSafeId(request?.siteId ?? '')) throw new Error('无效站点');
    return sitefiles.writeSiteRelFile(this.root, request.siteId, String(request?.relPath ?? ''), String(request?.content ?? ''));
  }

  async appendHighlight(request) {
    await this.ready;
    const siteId = request?.siteId;
    if (!isSafeId(siteId ?? '')) throw new Error('无效站点');
    const entry = request?.entry ?? {};
    const sp = sitePaths(this.root, siteId);
    let list = [];
    try { list = JSON.parse(await readFile(sp.highlightsFile, 'utf8')); } catch {}
    if (!Array.isArray(list)) list = [];
    list.push({
      id: newId('hl'),
      quote: String(entry.quote ?? '').slice(0, LIMITS.selectionChars),
      note: String(entry.note ?? '').slice(0, 2000),
      url: String(entry.url ?? '').slice(0, 500),
      pageTitle: String(entry.pageTitle ?? '').slice(0, 200),
      createdAt: new Date().toISOString(),
    });
    await mkdir(dirname(sp.highlightsFile), { recursive: true });
    await writeFile(sp.highlightsFile, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true, count: list.length };
  }

  async getProgress(request) {
    await this.ready;
    if (!isSafeId(request?.siteId ?? '')) throw new Error('无效站点');
    try {
      return { progress: JSON.parse(await readFile(sitePaths(this.root, request.siteId).progressFile, 'utf8')) };
    } catch { return { progress: {} }; }
  }

  async setProgress(request) {
    await this.ready;
    if (!isSafeId(request?.siteId ?? '')) throw new Error('无效站点');
    const file = sitePaths(this.root, request.siteId).progressFile;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(request?.progress ?? {}, null, 2), 'utf8');
    return { ok: true };
  }

  // ------------------------------------------------------------------ Forge

  async prepareForge(request) {
    await this.ready;
    const kind = request?.kind;
    if (!FORGE_KINDS.includes(kind)) throw new Error(`kind 须为 ${FORGE_KINDS.join(' | ')}`);
    const oneLiner = String(request?.oneLiner ?? '').trim().slice(0, 500);
    if (!oneLiner) throw new Error('请用一句话描述需求');
    if (kind === 'tool') {
      const id = newId('tl');
      this.store.data.tools[id] = {
        id, title: oneLiner.slice(0, 30), icon: '🛠', status: 'forging',
        sessionId: request?.sessionId ?? null, entry: 'index.html', oneLiner,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      this.store.touch();
      return { kind, id, prompt: forgeToolPrompt({ toolId: id, oneLiner, toolsDirAbs: this.paths.toolsDir }) };
    }
    const id = `ext-${newId('x').slice(2)}`;
    return { kind, id, prompt: forgeExtensionPrompt({ extId: id, oneLiner, extensionsDirAbs: this.paths.extensionsDir }) };
  }

  async publishTool(request) {
    await this.ready;
    const id = request?.id;
    if (!isSafeId(id ?? '')) throw new Error('无效工具 id');
    const tp = toolPaths(this.root, id);
    let entry;
    try { entry = await readFile(tp.entryFile, 'utf8'); } catch { throw new Error('工具产物缺失：index.html 不存在'); }
    if (!entry.trim()) throw new Error('工具产物缺失：index.html 为空');
    const d = this.store.data;
    const tool = d.tools[id] ?? {
      id, title: id, icon: '🛠', sessionId: null, entry: 'index.html', oneLiner: '',
      createdAt: new Date().toISOString(),
    };
    tool.title = String(request?.title ?? tool.title).slice(0, 60);
    tool.icon = String(request?.icon ?? tool.icon).slice(0, 16);
    tool.status = 'ready';
    tool.error = null;
    tool.updatedAt = new Date().toISOString();
    d.tools[id] = tool;
    // 工具即收藏：确保有一条 kind:'tool' 的导航条目
    if (!d.items.some(item => item.kind === 'tool' && item.toolId === id)) {
      d.items.push({
        id: newId('it'), kind: 'tool', title: tool.title, url: '', icon: tool.icon,
        toolId: id, groupId: null, order: d.items.length, pinned: false, siteId: null,
        createdAt: new Date().toISOString(), lastOpenedAt: null,
      });
    }
    this.store.touch();
    return { tool };
  }

  async reportForge(request) {
    await this.ready;
    const id = request?.id;
    const tool = this.store.data.tools[id];
    if (!tool) throw new Error('工具不存在');
    if (request?.status === 'failed') {
      tool.status = 'failed';
      tool.error = String(request?.error ?? '未知原因').slice(0, 300);
      tool.updatedAt = new Date().toISOString();
      this.store.touch();
    }
    return { ok: true };
  }

  async listTools() {
    await this.ready;
    return { tools: this.store.data.tools };
  }

  async removeTool(request) {
    await this.ready;
    const id = request?.id;
    if (!this.store.data.tools[id]) throw new Error('工具不存在');
    delete this.store.data.tools[id];
    this.store.data.items = this.store.data.items.filter(item => !(item.kind === 'tool' && item.toolId === id));
    this.store.touch();
    const { rm } = await import('node:fs/promises');
    await rm(toolPaths(this.root, id).base, { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }
  async retryTool(request) {
    await this.ready;
    const tool = this.store.data.tools[request?.id];
    if (!tool) throw new Error('工具不存在');
    tool.status = 'forging';
    tool.error = null;
    tool.updatedAt = new Date().toISOString();
    this.store.touch();
    return {
      id: tool.id, sessionId: tool.sessionId,
      prompt: forgeToolPrompt({ toolId: tool.id, oneLiner: tool.oneLiner || tool.title, toolsDirAbs: this.paths.toolsDir }),
    };
  }
}

// Mark every public method above as Remote-exported（与 qiaomu 同款命令式装饰）。
{
  const names = [
    'listState', 'health',
    'addItem', 'updateItem', 'removeItem', 'reorderItems', 'pinItem', 'touchOpened',
    'addGroup', 'renameGroup', 'removeGroup', 'saveSettings', 'exportData', 'importData', 'recoverIndex',
    'openUrl', 'getCachedPage', 'checkLive', 'startCrawl', 'crawlStatus',
    'getWorkspaceInfo', 'saveWorkspaceId', 'bindContext', 'getCompanionSession', 'setCompanionSession',
    'listExtensions', 'setExtensionEnabled', 'saveExtension', 'removeExtension', 'runExtension', 'listExtensionRuns',
    'listNotebook', 'readSiteFile', 'writeSiteFile', 'appendHighlight', 'getProgress', 'setProgress',
    'prepareForge', 'publishTool', 'reportForge', 'listTools', 'removeTool', 'retryTool',
  ];
  const prototype = LaunchpadService.prototype;
  for (const name of names) {
    Remote(name)(prototype[name], {
      name,
      private: false,
      static: false,
      addInitializer(fn) {
        fn.call(Object.create(prototype));
      },
    });
  }
}
