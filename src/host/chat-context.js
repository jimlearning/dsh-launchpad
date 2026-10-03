/**
 * 伴读上下文：per-session 材料注入（qiaomu 范式——写 store，由 systemPrompt.context 每次调用注入）。
 */
import { LIMITS } from '../shared/protocol.js';

export class ChatContextStore {
  constructor(store) {
    this.store = store;               // LaunchpadStore
  }

  /** 绑定/替换一个会话的上下文文本。 */
  async bind(sessionId, text, meta = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 160) throw new Error('无效会话');
    if (typeof text !== 'string' || text.length > 200000) throw new Error('上下文过长');
    const contexts = this.store.data.companionContexts ??= {};
    contexts[sessionId] = { text, meta, updatedAt: Date.now() };
    // LRU：超出上限按 updatedAt 淘汰
    const ids = Object.keys(contexts).sort((a, b) => contexts[b].updatedAt - contexts[a].updatedAt);
    for (const id of ids.slice(LIMITS.companionContextsMax)) delete contexts[id];
    await this.store.flush();
    return { ok: true };
  }

  textFor(agent) {
    const id = agent?.session?.id;
    return (id && this.store.data.companionContexts?.[id]?.text) || '';
  }
}
