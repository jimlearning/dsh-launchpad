/**
 * dsh-launchpad client half：挂载 `launchpad` Remote 命名空间，
 * 注册 sidebar.panellist 图标（order 20，插件/计划任务/乔木RSS 之下）与 main 面板。
 * 打包为单个 window.__ModuleLoader__ bundle；react/primitives 保持 external。
 */
import { Panel, PanelIcon } from './Panel.jsx';
import { NativeConversation } from './companion/NativeConversation.jsx';
import { createChatBridge } from './companion/chat-bridge.js';

const PLUGIN_ID = 'dsh-launchpad';
export const PANEL_ID = 'launchpad';

/** Duck-typed codec stub：客户端不解析负载，只转发 JSON。 */
const codec = () => ({
  mode: 'strict',
  typeSymbol: `${PLUGIN_ID}#json`,
  create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
});

function method(method, params = true) {
  return {
    id: `${PLUGIN_ID}#launchpad/${method}`,
    service: 'launchpad',
    namespace: 'launchpad',
    method,
    invocation: { kind: 'direct' },
    ...(params ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec() }] } : { parameters: [] }),
    result: { mode: 'src-json' },
    cancellation: { parameter: 'signal' },
  };
}

const TYPERT_REMOTE = {
  package: PLUGIN_ID,
  descriptors: [
    // 与 host 方法签名元数严格一致：零参方法必须 parameters: []（网关按 host 签名推导描述符）
    ...['listState', 'health', 'exportData', 'recoverIndex', 'getWorkspaceInfo', 'listExtensions', 'listTools']
      .map(name => method(name, false)),
    ...['addItem', 'updateItem', 'removeItem', 'reorderItems', 'pinItem', 'touchOpened',
      'addGroup', 'renameGroup', 'removeGroup', 'saveSettings', 'importData',
      'openUrl', 'getCachedPage', 'checkLive', 'startCrawl', 'crawlStatus',
      'saveWorkspaceId', 'bindContext', 'getCompanionSession', 'setCompanionSession',
      'setExtensionEnabled', 'saveExtension', 'removeExtension', 'runExtension', 'listExtensionRuns',
      'listNotebook', 'readSiteFile', 'writeSiteFile', 'appendHighlight', 'getProgress', 'setProgress',
      'prepareForge', 'publishTool', 'reportForge', 'removeTool', 'retryTool',
    ].map(name => method(name)),
  ],
};

export const inject = ['slots', 'layout', 'remote', 'locale'];

export async function apply(ctx) {
  try {
    await ctx.remote.$mount(TYPERT_REMOTE);
  } catch (error) {
    ctx.logger?.error?.('dsh-launchpad: 挂载 launchpad Remote 命名空间失败: %o', error);
    throw error;
  }
  ctx.inject(['remote.launchpad'], (child) => registerPanel(child));
}

function registerPanel(ctx) {
  // 描述符为 parameters: [] 的方法（其余方法一律以 {} 兜底，保证元数匹配）
  const NOARG = new Set(['listState', 'health', 'exportData', 'recoverIndex', 'getWorkspaceInfo', 'listExtensions', 'listTools']);
  const call = async (name, params) => {
    const namespace = ctx.remote.launchpad;
    if (!namespace || typeof namespace[name] !== 'function') {
      throw new Error('发射台服务尚未就绪，请稍后重试');
    }
    const args = params !== undefined ? [params] : (NOARG.has(name) ? [] : [{}]);
    const result = await namespace[name](...args);
    if (result.ok) return result.value;
    throw result.error;
  };

  const api = new Proxy({}, {
    get: (target, name) => target[name] ?? ((params) => call(String(name), params)),
  });
  // 伴读会话桥（专属工作区 + 编程式投递），以 api._chat 暴露给面板。
  api._chat = createChatBridge(ctx, call);

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    children: { 'launchpad.chat': { kind: 'single', scope: 'session' } },
    inject: () => ({ api }),
  }, Panel));
  ctx.slots.inject('launchpad.chat', () => ctx.slots.register({ name: 'launchpad.chat' }, NativeConversation));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: '发射台',
  }, PanelIcon));
}
