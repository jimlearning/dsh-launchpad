/**
 * LLM 直出（material-card 类扩展用）。实现完全参照 qiaomu-rss-dsh/src/host/ai.js：
 * agentDefaultModel.currentSelection() 取默认模型 → ctx.llm.stream → 拼 text-delta
 * → finish 错误处理 → 去外层代码围栏 → 空结果报错。
 *
 * 接口契约：complete(ctx, {system, user, signal}) → string
 *
 * 注意：@deepseek-ai/dsh-llm 是可选 peer（单测环境未安装），故 createSystemMessage /
 * createUserMessage 走动态导入，缺失时退回结构等效的内联构造器。
 */

let messageHelpersPromise = null;
function loadMessageHelpers() {
  messageHelpersPromise ??= import('@deepseek-ai/dsh-llm')
    .then(m => ({ createSystemMessage: m.createSystemMessage, createUserMessage: m.createUserMessage }))
    .catch(() => ({
      createSystemMessage: (text) => ({ role: 'system', content: [{ type: 'text', text: String(text) }] }),
      createUserMessage: ({ content, source } = {}) => ({ role: 'user', content, ...(source ? { source } : {}) }),
    }));
  return messageHelpersPromise;
}

/** 取宿主当前默认模型选择（agentDefaultModel 服务）。 */
function defaultSelection(ctx) {
  const service = ctx.get('agentDefaultModel');
  if (!service) throw new Error('dsh-launchpad: 缺少 agentDefaultModel 服务，AI 助手不可用');
  const selection = service.currentSelection();
  if (!selection?.provider || !selection?.model) {
    throw new Error('dsh-launchpad: 尚未选择默认模型，请先在设置里选一个模型');
  }
  return selection;
}

/** 解析 "provider/model" 覆盖项；空/非法 → null（跟随默认）。 */
export function parseModelOverride(override) {
  if (typeof override !== 'string') return null;
  const slash = override.indexOf('/');
  if (slash <= 0 || slash === override.length - 1) return null;
  const provider = override.slice(0, slash).trim();
  const model = override.slice(slash + 1).trim();
  return provider && model ? { provider, model } : null;
}

/**
 * 一次性补全：system + user → 拼接全文返回。
 *  options.model 可传 "provider/model" 覆盖默认选择（如给生成类任务配快模型）。
 *  throws：无默认模型 / 模型调用失败 / 被中止 / 产出为空。
 */
export async function complete(ctx, { system, user, signal, model: override } = {}) {
  const { provider, model } = parseModelOverride(override) ?? defaultSelection(ctx);
  const { createSystemMessage, createUserMessage } = await loadMessageHelpers();
  const messages = [
    createSystemMessage(String(system ?? '')),
    createUserMessage({
      content: [{ type: 'text', text: String(user ?? '') }],
      source: { kind: 'user' },
    }),
  ];
  const stream = ctx.llm.stream({ provider, model, messages, ...(signal ? { signal } : {}) });
  let text = '';
  let finished = false;
  for await (const chunk of stream) {
    if (signal?.aborted) throw new Error('dsh-launchpad: 生成已中止');
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && text === '') text = chunk.block.text;
    else if (chunk.type === 'finish') {
      finished = true;
      if (chunk.reason?.kind === 'error') {
        throw new Error(`dsh-launchpad: 模型调用失败：${chunk.reason.failure?.message ?? '未知错误'}`);
      }
      if (chunk.reason?.kind === 'aborted') throw new Error('dsh-launchpad: 生成已中止');
      break;
    }
  }
  if (!finished && text === '') throw new Error('dsh-launchpad: 模型调用没有产出');
  // 去外层代码围栏（```html / ```json / ```markdown 等）
  const cleaned = text.replace(/^```[a-zA-Z0-9]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (cleaned === '') throw new Error('dsh-launchpad: 模型调用产出为空');
  return cleaned;
}

/**
 * 轻量并发 guard（备用）：同 key 串行——已有同 key 调用在进行时直接复用其 promise。
 * 用法：const guard = createCompletionGuard(); await guard(key, () => complete(...));
 */
export function createCompletionGuard() {
  const inflight = new Map();
  return function guard(key, run) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(run).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}
