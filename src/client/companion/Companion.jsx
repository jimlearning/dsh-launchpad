/**
 * 伴读侧栏：宿主原生会话内嵌 + 上下文自动绑定。
 *  - 会话复用：按站点经 companion 管理器恢复（getCompanionSession/setCompanionSession 由管理器处理）
 *  - 上下文：页面加载 / 选区变化（300ms 防抖）→ bindContext（材料经 systemPrompt 注入，不进消息流）
 *  - 渲染：<SessionProvider session={reference}>{renderSlot('launchpad.chat')}</SessionProvider>
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ErrorBar, Spinner } from '../components/ui.jsx';

const INLINE_CAP = 24000; // 与 LIMITS.materialInlineChars 对齐

function truncate(text, cap) {
  const value = String(text ?? '');
  return value.length > cap ? `${value.slice(0, cap)}\n\n…（已截断，完整版见文件）` : value;
}

function pageBundle(page, siteId) {
  return {
    kind: 'page',
    title: page.title,
    url: page.finalUrl,
    markdown: truncate(page.markdown, INLINE_CAP),
    meta: page.meta ?? {},
    spillFile: `sites/${siteId}/cache/pages/${page.pageId}.json`,
  };
}

function selectionBundle(page, siteId, selection) {
  return {
    kind: 'selection',
    title: page.title,
    url: page.finalUrl,
    markdown: truncate(page.markdown, 4000),
    meta: { site: page.meta?.site ?? page.meta?.siteName ?? '' },
    selection,
  };
}

export function Companion({ env, siteId, siteTitle, page, selection, onCollapse }) {
  const { companion, SessionProvider, renderSlot, toast } = env;
  useSyncExternalStore(companion.subscribe, companion.getVersion);
  const state = companion.getState();
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState('');
  const [boundDesc, setBoundDesc] = useState('');
  const bindGen = useRef(0);

  // 站点变化 → 打开/恢复伴读会话
  useEffect(() => {
    if (!siteId) return;
    let stale = false;
    companion.open(siteId).catch((cause) => {
      if (!stale) toast?.(cause?.message ?? String(cause), 'error');
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  // 页面/选区变化 → 防抖重绑上下文
  const ready = state.status === 'ready' && state.siteId === siteId;
  const selectionKey = selection?.quote ?? '';
  useEffect(() => {
    if (!ready || !page) return;
    const gen = ++bindGen.current;
    setBinding(true);
    setBindError('');
    const timer = setTimeout(() => {
      const scope = selection ? 'selection' : 'page';
      const bundle = selection ? selectionBundle(page, siteId, selection) : pageBundle(page, siteId);
      const bindKey = `${page.finalUrl ?? ''}|${selection?.quote ?? ''}`;
      companion.bind({ bundle, scope, bindKey })
        .then(() => {
          if (bindGen.current !== gen) return;
          setBoundDesc(selection ? `选区 ${Array.from(selection.quote).length} 字` : '当前页面');
        })
        .catch((cause) => { if (bindGen.current === gen) setBindError(cause?.message ?? String(cause)); })
        .finally(() => { if (bindGen.current === gen) setBinding(false); });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, page?.pageId, selectionKey]);

  if (!siteId) {
    return (
      <div className="dlp-companion">
        <div className="dlp-companion-idle">
          <span style={{ fontSize: 26 }} aria-hidden="true">💬</span>
          <span>打开页面后，这里会出现随读随问的伴读会话</span>
        </div>
      </div>
    );
  }

  return (
    <div className="dlp-companion">
      <div className="dlp-companion-header">
        <strong title={siteTitle}>💬 {siteTitle ?? '伴读'}</strong>
        <button
          type="button" className="dlp-icon-btn" title="新对话" aria-label="新对话"
          disabled={state.status === 'opening'}
          onClick={() => companion.newChat(siteId).catch((cause) => toast?.(cause?.message ?? String(cause), 'error'))}
        >＋</button>
        {onCollapse && <button type="button" className="dlp-icon-btn" title="收起侧栏" aria-label="收起侧栏" onClick={onCollapse}>⇥</button>}
      </div>
      <div className="dlp-companion-context">
        {binding
          ? <><Spinner label="同步上下文" /><span>同步上下文…</span></>
          : boundDesc
            ? <><span className="dlp-badge dlp-badge-brand">已绑定</span><span>{boundDesc} · 选中其他内容即自动切换</span></>
            : <span>上下文随页面与选区自动注入</span>}
      </div>
      {bindError && <ErrorBar error={bindError} onClose={() => setBindError('')} />}
      <div className="dlp-companion-body">
        {state.status === 'opening' && (
          <div className="dlp-companion-loading"><Spinner label="正在打开对话" /><span>正在打开伴读会话…</span></div>
        )}
        {state.status === 'error' && (
          <div className="dlp-companion-error" role="alert">
            <p>{state.lastError}</p>
            <button type="button" className="dlp-btn dlp-btn-sm" onClick={() => companion.open(siteId).catch(() => {})}>重新连接</button>
          </div>
        )}
        {ready && state.reference && SessionProvider && (
          <SessionProvider session={state.reference}>
            {renderSlot('launchpad.chat', {})}
          </SessionProvider>
        )}
      </div>
    </div>
  );
}
