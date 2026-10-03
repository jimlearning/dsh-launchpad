/**
 * 扩展运行编排：runExtension 四种 kind 的完整通路。
 *  - chat-task      → 确保伴读会话 → bindContext → sendMode 直发/填草稿
 *  - material-card  → host 已同步完成 → toast + 「查看」打开卡片预览
 *  - direct-action  → toast 已记入笔记
 *  - local-tool     → ToolFrame 打开工具并 postMessage(bundle)
 * site 级大任务先 startCrawl 并轮询 crawlStatus（进度经 onProgress 回报），再带 crawlJobId 运行。
 */

const CRAWL_POLL_MS = 1200;
const CRAWL_TIMEOUT_MS = 240_000;

async function awaitCrawl(api, jobId, onProgress) {
  const deadline = Date.now() + CRAWL_TIMEOUT_MS;
  for (;;) {
    const { job } = await api.crawlStatus({ jobId });
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new Error(job.error ? `站点抓取失败：${job.error}` : '站点抓取失败');
    onProgress?.(job.pages?.length ?? 0);
    if (Date.now() > deadline) throw new Error('站点抓取超时，请稍后重试');
    await new Promise((resolve) => setTimeout(resolve, CRAWL_POLL_MS));
  }
}

/**
 * @param {object} ctx {api, companion, toast, openFrame}
 * @param {object} ext 扩展条目（{id, manifest}）
 * @param {object} target runExtension target（selection/page/site；须含 siteId）
 */
export async function runExtensionFlow(ctx, ext, target, { onProgress } = {}) {
  const { api, companion, toast, openFrame } = ctx;
  const siteId = target.siteId;
  let finalTarget = target;

  // site 级：先显式抓取（进度可见），完成后再运行
  if (target.scope === 'site' && !target.crawlJobId) {
    const crawl = ext.manifest?.materials?.crawl ?? {};
    const { jobId } = await api.startCrawl({
      siteId,
      strategy: crawl.strategy ?? 'shallow',
      sinceDays: crawl.sinceDays ?? 0,
      limit: crawl.limit,
    });
    onProgress?.(0);
    await awaitCrawl(api, jobId, onProgress);
    finalTarget = { ...target, crawlJobId: jobId };
  }

  const result = await api.runExtension({ id: ext.id, target: finalTarget });

  if (result.kind === 'chat-task') {
    const chat = await companion.ensureChat(siteId);
    await companion.bind({
      bundle: result.bundle,
      instruction: result.instruction,
      scope: target.scope,
      bindKey: `${target.url ?? ''}|${target.selection?.quote ?? ''}`,
    });
    if (result.sendMode === 'auto') {
      await chat.sendPrompt(result.prompt);
      toast(`${ext.manifest?.icon ?? '✨'} ${ext.manifest?.name ?? '扩展'}已发送，伴读会话处理中`, 'ok');
    } else {
      await chat.setDraftOnly(result.prompt);
      toast('已填入伴读输入框，确认后发送', 'ok');
    }
    return result;
  }

  if (result.kind === 'material-card') {
    const file = result.outputFile ?? '';
    const name = file.split('/').pop();
    const canPreview = file.startsWith('cards/') && siteId;
    toast(`已生成 ${name || '产物'}`, 'ok', canPreview ? {
      label: '查看',
      onClick: () => openFrame({
        title: name,
        src: `/api/launchpad/card/${siteId}/${encodeURIComponent(file.slice('cards/'.length))}`,
      }),
    } : undefined);
    return result;
  }

  if (result.kind === 'direct-action') {
    toast(`📌 已记入笔记（共 ${result.count ?? '?'} 条高亮）`, 'ok');
    return result;
  }

  if (result.kind === 'local-tool') {
    openFrame({
      title: ext.manifest?.name ?? result.toolId,
      src: `/api/launchpad/tool/${result.toolId}/index.html`,
      bundle: result.bundle,
    });
    return result;
  }

  throw new Error(`未知扩展结果类型 ${result.kind}`);
}
