/**
 * 伴读会话管理器：在 api._chat bridge 之上的薄封装。
 * 职责：专属工作区保障（含运行时失效自愈）、按站点复用伴读会话、
 *       上下文绑定串行队列 + bindKey 去重（Companion 自动绑定与扩展运行器绑定共用队列，互不覆盖）、
 *       订阅式状态通知（供 Companion.jsx 渲染）。
 * 全部能力问题（setDraft/submit 缺失等）由 bridge 抛出，这里只做中文错误归一。
 */
export function createCompanion(api) {
  const listeners = new Set();
  let version = 0;
  let workspaceId = null;
  let workspacePromise = null;
  let current = null; // {siteId, sessionId, reference, sendPrompt, setDraftOnly}
  let status = 'idle'; // idle | opening | ready | error
  let lastError = '';
  let boundScope = ''; // 最近一次成功绑定的 scope（UI 指示用）
  let boundKey = ''; // 最近一次成功绑定的内容 key（去重：同 key 不重复绑定）
  let generation = 0;
  let bindQueue = Promise.resolve();

  const emit = () => { version += 1; for (const fn of [...listeners]) fn(); };
  const fail = (cause) => {
    status = 'error';
    lastError = cause?.message ?? String(cause);
    emit();
  };

  /** 确保「🚀 发射台」专属工作区（并发去重）。 */
  function ensureWorkspace() {
    if (workspaceId) return Promise.resolve(workspaceId);
    workspacePromise ??= api._chat.ensureWorkspace()
      .then((id) => { workspaceId = id; return id; })
      .catch((cause) => { workspacePromise = null; throw cause; });
    return workspacePromise;
  }

  /** 打开会话；工作区运行时被删 → 缓存作废、自愈重建后重试一次。 */
  async function openChatHealing(wsId, sessionId) {
    try {
      return await api._chat.openChat({ workspaceId: wsId, sessionId });
    } catch (cause) {
      if (!/工作区不存在/.test(cause?.message ?? '')) throw cause;
      workspaceId = null;
      workspacePromise = null;
      const healed = await ensureWorkspace();
      return api._chat.openChat({ workspaceId: healed, sessionId });
    }
  }

  /**
   * 打开（或复用）某站点的伴读会话。幂等：同站点已就绪直接返回。
   * fresh=true 强制新会话（「新对话」按钮）。
   */
  async function open(siteId, { fresh = false } = {}) {
    if (!siteId) throw new Error('缺少站点，无法开启伴读');
    if (!fresh && status === 'ready' && current?.siteId === siteId) return current;
    const gen = ++generation;
    status = 'opening';
    lastError = '';
    emit();
    let acquired = null;
    try {
      const wsId = await ensureWorkspace();
      const saved = fresh ? null : (await api.getCompanionSession({ siteId }).catch(() => null))?.sessionId ?? null;
      try {
        acquired = await openChatHealing(wsId, saved || undefined);
      } catch (cause) {
        if (!saved) throw cause;
        // 保存的会话已失效（被删等）→ 清掉指针后新建
        await api.setCompanionSession({ siteId, sessionId: null }).catch(() => {});
        acquired = await openChatHealing(wsId, undefined);
      }
      if (gen !== generation) { acquired.release(); return current; }
      current?.reference?.release?.();
      current = { siteId, ...acquired };
      boundScope = '';
      boundKey = '';
      status = 'ready';
      emit();
      await api.setCompanionSession({ siteId, sessionId: acquired.sessionId }).catch(() => {});
      return current;
    } catch (cause) {
      acquired?.release?.();
      if (gen === generation) fail(cause);
      throw cause;
    }
  }

  /** 供扩展运行器使用：确保拿到可发送的会话句柄（必要时静默打开）。 */
  async function ensureChat(siteId) {
    if (status === 'ready' && current?.siteId === siteId) return current;
    return open(siteId);
  }

  /**
   * 绑定上下文到当前会话（串行队列，选区连变/扩展运行不乱序）。
   * bindKey：内容指纹（如 `url|quote`）；与当前 boundKey 相同则跳过——
   * Companion 的防抖自动绑定与 runner 的任务绑定经同一 key 去重，互不覆盖。
   */
  function bind({ bundle, scope, instruction, bindKey: key }) {
    if (!current || status !== 'ready') return Promise.reject(new Error('伴读会话尚未就绪'));
    if (key && key === boundKey) return Promise.resolve({ skipped: true });
    const sessionId = current.sessionId;
    const pending = bindQueue.catch(() => {}).then(async () => {
      await api.bindContext({ sessionId, bundle, instruction, scope });
      boundScope = scope ?? bundle?.kind ?? '';
      if (key) boundKey = key;
      emit();
    });
    bindQueue = pending;
    return pending;
  }

  /** 新对话：废弃当前会话引用，建立全新会话并记住。 */
  async function newChat(siteId) {
    const target = siteId ?? current?.siteId;
    if (!target) throw new Error('缺少站点，无法新建伴读');
    generation += 1; // 使进行中的 open 失效
    current?.reference?.release?.();
    current = null;
    return open(target, { fresh: true });
  }

  /** 面板卸载时释放 retain（会话本体保留在 Harness 中）。 */
  function release() {
    generation += 1;
    current?.reference?.release?.();
    current = null;
    status = 'idle';
    boundScope = '';
    boundKey = '';
    emit();
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getVersion: () => version,
    getState: () => ({
      status, lastError, boundScope, boundKey,
      siteId: current?.siteId ?? null,
      sessionId: current?.sessionId ?? null,
      reference: current?.reference ?? null,
    }),
    ensureWorkspace,
    open,
    ensureChat,
    bind,
    newChat,
    release,
  };
}
