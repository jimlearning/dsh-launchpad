/**
 * 伴读会话桥：专属工作区保障 + 编程式会话创建/投递。
 * 移植 qiaomu native-chat.js 模式，并修复其"会话落进其他工程工作区"的归属问题：
 * 发射台自建并持有专属工作区「🚀 发射台」，全部伴读/Forge 会话集中于此。
 */
export function createChatBridge(ctx, call) {
  let scope;
  const watchers = new Set();
  ctx.inject(['sessions', 'uiSession', 'uiWorkspace', 'workspaces'], child => {
    scope = child;
    for (const notify of watchers) notify();
    return () => { scope = undefined; for (const notify of watchers) notify(); };
  });

  function chatWorkspaces() {
    return scope?.uiWorkspace.workspaces.list.getSnapshot().items
      .map(w => ({ id: w.workspaceId, name: w.title || w.name || w.path, path: w.path })) ?? [];
  }

  /** 确保「🚀 发射台」专属工作区存在并返回 workspaceId（自建自愈，绝不借用其他工程的工作区）。 */
  async function ensureWorkspace() {
    if (!scope) throw new Error('Harness 对话服务尚未就绪');
    const info = await call('getWorkspaceInfo');
    const existing = info.workspaceId
      && scope.uiWorkspace.workspaces.list.getSnapshot().items.some(w => w.workspaceId === info.workspaceId);
    if (existing) return info.workspaceId;
    if (typeof scope.workspaces?.create !== 'function') throw new Error('当前 Harness 版本不支持创建工作区');
    const view = await scope.workspaces.create({ path: info.path });
    const workspaceId = view?.workspaceId ?? view?.id;
    if (!workspaceId) throw new Error('创建工作区失败：未返回 workspaceId');
    await call('saveWorkspaceId', { workspaceId });
    return workspaceId;
  }

  async function openChat({ workspaceId, sessionId }) {
    if (!scope) throw new Error('Harness 对话服务尚未就绪');
    const active = scope;
    if (!active.uiWorkspace.workspaces.list.getSnapshot().items.some(w => w.workspaceId === workspaceId)) {
      throw new Error('发射台工作区不存在，请重试（将自动重建）');
    }
    if (typeof active.sessions?.create !== 'function') throw new Error('当前 Harness 版本不支持创建会话');
    const id = sessionId || await active.sessions.create({ workspaceId });
    const reference = active.sessions.retain(id, { source: 'dsh-launchpad' });
    try {
      const source = active.uiSession.bindingSource(reference);
      if (typeof source.value.props.inputActions?.setDraft !== 'function') {
        throw new Error('当前 Harness 版本不支持原生伴读');
      }
      return {
        sessionId: id, reference, release: () => reference.release(),
        /** 仅填草稿，不发送（大任务确认模式）。 */
        async setDraftOnly(prompt) {
          const actions = source.value.props.inputActions;
          actions.setDraft(prompt);
          source.value.hooks?.input?.getSnapshot?.() ?? null;
        },
        async sendPrompt(prompt) {
          const { input } = source.value.hooks ?? {};
          const actions = source.value.props.inputActions;
          if (typeof actions.submit !== 'function' || typeof input?.getSnapshot !== 'function' || typeof input?.subscribe !== 'function') {
            throw new Error('当前 Harness 版本不支持快捷发送');
          }
          const state = input.getSnapshot();
          if (state.phase !== 'plain') throw new Error('当前输入框正在处理消息，请稍后重试');
          if (state.attachmentIds?.length) throw new Error('输入框有待发送附件，请先处理附件');
          if (state.draft.trim()) throw new Error('输入框已有草稿，请先发送或清空草稿');
          actions.setDraft(prompt);
          if (input.getSnapshot().draft !== prompt) await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { unsubscribe(); reject(new Error('提示词已放入输入框，请手动发送')); }, 1200);
            const unsubscribe = input.subscribe(() => {
              if (input.getSnapshot().draft === prompt) { clearTimeout(timeout); unsubscribe(); resolve(); }
            });
            if (input.getSnapshot().draft === prompt) { clearTimeout(timeout); unsubscribe(); resolve(); }
          });
          if (input.getSnapshot().phase !== 'plain') throw new Error('输入框正在处理消息，请稍后重试');
          actions.submit();
        },
      };
    } catch (error) { reference.release(); throw error; }
  }

  return {
    ensureWorkspace,
    openChat,
    chatWorkspaces,
    watchChatWorkspaces(listener) {
      watchers.add(listener);
      const unsubscribe = scope?.uiWorkspace.workspaces.list.subscribe(listener) ?? (() => {});
      return () => { watchers.delete(listener); unsubscribe(); };
    },
  };
}
