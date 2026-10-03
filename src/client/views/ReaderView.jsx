/**
 * 阅读视图（核心）：tab 条 + 地址栏三模式（阅读/原页/浏览器）+ 阅读模式渲染 + 选区浮条
 * + 右侧扩展工具轨（scope 过滤）+ 伴读 Companion。
 * tab 模型：tabs/activeTabId 提升到 Panel（URL 归一去重）；本组件持有 per-tab 运行时缓存
 * （page/loading/error），已加载 tab 的 DOM 保活（hidden 切换，滚动位置不丢）。
 * 链接拦截：.dlp-reader 内 <a> 点击 → http(s) 在新 tab 打开，其他协议放行默认。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeUrl } from '../../shared/protocol.js';
import { selectedPassage, selectionRect } from '../companion/selection.js';
import { Companion } from '../companion/Companion.jsx';
import { runExtensionFlow } from '../components/runner.jsx';
import { EmptyState, ErrorBar, ItemIcon, Segmented, Spinner, hostOf } from '../components/ui.jsx';

const MODE_OPTIONS = [
  { value: 'reader', label: '📖 阅读', title: '阅读模式（已消毒正文，可选中划线）' },
  { value: 'live', label: '🌐 原页', title: '原页嵌入（站点允许时）' },
  { value: 'browser', label: '↗ 浏览器', title: '在系统浏览器打开' },
];

export function ReaderView({ env, active }) {
  const { api, state, toast, tabs, activeTabId } = env;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const [pages, setPages] = useState({}); // tabId → {status:'loading'|'ready'|'error', page?, error?}
  const [addr, setAddr] = useState('');
  const [extensions, setExtensions] = useState([]);
  const [selection, setSelection] = useState(null);
  const [selPos, setSelPos] = useState(null);
  const [selMenuOpen, setSelMenuOpen] = useState(false);
  const [runningExt, setRunningExt] = useState(null);
  const [crawlPages, setCrawlPages] = useState(null);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const articleRef = useRef(null);
  const mainRef = useRef(null);
  const gens = useRef({}); // tabId → 加载代数（并发守卫）

  const runtime = activeTab ? pages[activeTab.id] : null;
  const current = runtime?.status === 'ready' ? runtime.page : null;
  const loading = runtime?.status === 'loading';
  const mode = activeTab?.mode ?? 'reader';

  // ------------------------------------------------------------- 加载（per-tab 代数守卫）
  const load = useCallback(async (tab, { force = false } = {}) => {
    const gen = (gens.current[tab.id] ?? 0) + 1;
    gens.current[tab.id] = gen;
    setPages((map) => ({ ...map, [tab.id]: { status: 'loading' } }));
    setSelection(null);
    setSelMenuOpen(false);
    try {
      const page = await api.openUrl({ url: tab.url, force });
      if (gens.current[tab.id] !== gen) return;
      setPages((map) => ({ ...map, [tab.id]: { status: 'ready', page } }));
      env.updateTab(tab.id, {
        title: page.title || tab.title,
        siteId: page.siteId,
        pageId: page.pageId,
        ...(tab.mode === 'live' && !page.liveOk ? { mode: 'reader' } : null),
      });
      void env.refresh(); // 新站点/标题即时同步到导航与笔记本
    } catch (cause) {
      if (gens.current[tab.id] !== gen) return;
      setPages((map) => ({ ...map, [tab.id]: { status: 'error', error: cause?.message ?? String(cause) } }));
    }
  }, [api, env]);

  // 激活 tab 变化 → 按需加载（仅首次；错误 tab 走手动重试）
  useEffect(() => {
    if (!activeTab) return;
    if (!pages[activeTab.id]) void load(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.url]);

  // 切换 tab → 地址栏同步 + 选区清理
  useEffect(() => {
    setAddr(activeTab?.url ?? '');
    setSelection(null);
    setSelMenuOpen(false);
  }, [activeTab?.id]);

  // 已关闭 tab → 清理运行时缓存
  useEffect(() => {
    setPages((map) => {
      const alive = new Set(tabs.map((tab) => tab.id));
      const stale = Object.keys(map).filter((key) => !alive.has(key));
      if (!stale.length) return map;
      const next = { ...map };
      for (const key of stale) delete next[key];
      return next;
    });
  }, [tabs]);

  // ------------------------------------------------------------- 扩展清单
  const loadExtensions = useCallback(() => {
    api.listExtensions()
      .then((result) => setExtensions(result.extensions ?? []))
      .catch(() => {});
  }, [api]);
  useEffect(() => {
    if (!active) return undefined;
    loadExtensions();
    const timer = setInterval(loadExtensions, 12000); // 静默追加热加载的新扩展
    return () => clearInterval(timer);
  }, [active, loadExtensions]);

  // ------------------------------------------------------------- 链接拦截（事件委托）
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return undefined;
    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = event.target?.closest?.('a');
      if (!anchor || !anchor.closest('.dlp-reader')) return;
      const href = anchor.href;
      if (!href) return;
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        env.openReader(href); // 新 tab 打开（自动去重激活）
      }
      // 其他协议（mailto: 等）放行默认行为
    };
    main.addEventListener('click', onClick);
    return () => main.removeEventListener('click', onClick);
  }, [env]);

  // ------------------------------------------------------------- 选区捕获
  useEffect(() => {
    if (!active || mode !== 'reader') return undefined;
    let timer = 0;
    const onSelection = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const root = articleRef.current;
        if (!root) { setSelection(null); return; }
        const passage = selectedPassage(root);
        if (passage) {
          const rect = selectionRect(root);
          setSelection(passage);
          setSelPos(rect ? { top: rect.top, bottom: rect.bottom, left: rect.left + rect.width / 2 } : null);
        } else {
          setSelection(null);
          setSelMenuOpen(false);
        }
      }, 120);
    };
    document.addEventListener('selectionchange', onSelection);
    return () => { document.removeEventListener('selectionchange', onSelection); clearTimeout(timer); };
  }, [active, mode, activeTabId, current?.pageId]);

  // ------------------------------------------------------------- 扩展分组
  const usable = useMemo(
    () => extensions.filter((entry) => entry.enabled && entry.valid !== false),
    [extensions],
  );
  const byScope = useCallback((scope) => usable.filter((entry) => entry.manifest?.scopes?.includes(scope)), [usable]);
  const quick = useMemo(() => {
    const sel = byScope('selection');
    const explain = sel.find((e) => /解释/.test(e.manifest?.name ?? ''));
    const translate = sel.find((e) => /翻译|translate/i.test(e.manifest?.name ?? ''));
    const note = sel.find((e) => e.manifest?.kind === 'direct-action' || /笔记|高亮|记录/.test(e.manifest?.name ?? ''));
    const picked = new Set([explain?.id, translate?.id, note?.id].filter(Boolean));
    return { explain, translate, note, more: sel.filter((e) => !picked.has(e.id)) };
  }, [byScope]);

  // ------------------------------------------------------------- 运行扩展
  async function runExt(ext, target) {
    if (runningExt || !target) return;
    setRunningExt(ext.id);
    setCrawlPages(null);
    try {
      await runExtensionFlow(
        { api, companion: env.companion, toast, openFrame: env.openFrame },
        ext,
        target,
        { onProgress: (pagesDone) => setCrawlPages(pagesDone) },
      );
      setSelMenuOpen(false);
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setRunningExt(null);
      setCrawlPages(null);
    }
  }

  const targetFor = useCallback((scope) => {
    if (!current) return null;
    if (scope === 'selection') {
      return selection && {
        scope: 'selection',
        url: current.finalUrl,
        title: current.title,
        siteId: current.siteId,
        selection,
        pageMarkdownExcerpt: String(current.markdown ?? '').slice(0, 4000),
      };
    }
    if (scope === 'page') return { scope: 'page', url: current.finalUrl, siteId: current.siteId };
    return { scope: 'site', siteId: current.siteId };
  }, [current, selection]);

  // ------------------------------------------------------------- 地址栏 / 模式
  function go(event) {
    event?.preventDefault?.();
    const raw = addr.trim();
    if (!raw) return;
    if (mode === 'browser') {
      window.open(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, '_blank', 'noopener');
      return;
    }
    const norm = normalizeUrl(raw);
    if (!norm) { toast('无效的 http(s) URL', 'warn'); return; }
    const existing = tabs.find((tab) => tab.url === norm);
    if (existing) {
      if (existing.id !== activeTabId) env.openReader(norm); // 激活既有 tab（去重）
      return;
    }
    if (!activeTab) { env.openReader(norm); return; }
    // 当前 tab 换址：清运行时缓存 → 更新 url → 加载 effect 自动触发
    setPages((map) => { const next = { ...map }; delete next[activeTab.id]; return next; });
    env.updateTab(activeTab.id, { url: norm, title: hostOf(norm), siteId: null, pageId: null });
  }

  function switchMode(next) {
    if (!activeTab) return;
    if (next === 'browser') {
      window.open(current?.finalUrl ?? activeTab.url, '_blank', 'noopener');
      return;
    }
    if (next === 'live' && current && !current.liveOk) { toast('该站禁止嵌入，无法切换原页', 'warn'); return; }
    env.updateTab(activeTab.id, { mode: next });
    if (next === 'live') { setSelection(null); setSelMenuOpen(false); }
  }

  const siteId = current?.siteId ?? activeTab?.siteId ?? null;
  const site = siteId ? state?.sites?.[siteId] : null;
  const siteTitle = site?.title ?? current?.meta?.siteName ?? (current ? hostOf(current.finalUrl) : activeTab ? hostOf(activeTab.url) : null);
  // 浮条：默认在选区上方；靠顶时改到下方，避免被地址栏遮挡
  const barTop = selPos ? (selPos.top > 110 ? selPos.top - 48 : selPos.bottom + 10) : 0;
  const barLeft = selPos ? Math.min(Math.max(130, selPos.left), (window.innerWidth ?? 800) - 130) : 0;

  return (
    <div className="dlp-reader-view">
      <div className="dlp-reader-main" ref={mainRef}>
        {tabs.length > 0 && (
          <div className="dlp-rtabs" role="tablist" aria-label="打开的页面">
            {tabs.map((tab) => {
              const tabRuntime = pages[tab.id];
              return (
                <div
                  key={tab.id} role="tab" tabIndex={0} title={tab.url}
                  className="dlp-rtab" aria-selected={tab.id === activeTabId}
                  onClick={() => env.openReader(tab.url)}
                  onKeyDown={(event) => { if (event.key === 'Enter') env.openReader(tab.url); }}
                >
                  {tabRuntime?.status === 'loading' && <span className="dlp-rtab-dot" aria-hidden="true" />}
                  <span className="dlp-rtab-title">{tab.title}</span>
                  <button
                    type="button" className="dlp-rtab-close" title="关闭标签页" aria-label={`关闭 ${tab.title}`}
                    onClick={(event) => { event.stopPropagation(); env.closeTab(tab.id); }}
                  >✕</button>
                </div>
              );
            })}
          </div>
        )}

        <div className="dlp-addr">
          <form className="dlp-addr-form" onSubmit={go}>
            <input
              className="dlp-addr-input" value={addr} spellCheck={false}
              placeholder="输入网址，回车开始阅读…"
              onChange={(event) => setAddr(event.target.value)}
            />
          </form>
          <Segmented
            ariaLabel="打开方式" value={mode} onChange={switchMode}
            options={MODE_OPTIONS.map((opt) => opt.value === 'live' && current && !current.liveOk
              ? { ...opt, disabled: true, title: '该站禁止嵌入' }
              : opt)}
          />
          <button type="button" className={`dlp-icon-btn${loading ? ' dlp-spin' : ''}`} title="重新抓取（跳过缓存）" aria-label="重新抓取"
            disabled={!activeTab || loading} onClick={() => activeTab && void load(activeTab, { force: true })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M20 11A8 8 0 1 0 18.9 15"/><path d="M20 5v6h-6"/></svg>
          </button>
          <button type="button" className="dlp-icon-btn" title={sideCollapsed ? '展开侧栏' : '收起侧栏'} aria-label="切换侧栏"
            onClick={() => setSideCollapsed((value) => !value)}>{sideCollapsed ? '⇤' : '⇥'}</button>
        </div>

        {!activeTab && (
          <EmptyState icon="📖" title="在面板里读任何网页"
            desc="从「导航」点一张卡片，或在上方地址栏输入网址。选中正文任意内容，即可让 AI 解释、翻译、记笔记。" />
        )}

        {tabs.map((tab) => {
          const tabRuntime = pages[tab.id];
          if (!tabRuntime) return null;
          const isActive = tab.id === activeTabId;
          const page = tabRuntime.status === 'ready' ? tabRuntime.page : null;
          const pageSite = page?.siteId ? state?.sites?.[page.siteId] : null;
          const pageSiteTitle = pageSite?.title ?? page?.meta?.siteName ?? (page ? hostOf(page.finalUrl) : tab.title);
          return (
            <div key={tab.id} className="dlp-rtab-page" hidden={!isActive}>
              {tabRuntime.status === 'loading' && (
                <div className="dlp-reader-scroll" aria-busy="true">
                  <div className="dlp-reader-wrap">
                    <div className="dlp-skeleton" style={{ height: 30, width: '64%', marginBottom: 14 }} />
                    <div className="dlp-skeleton" style={{ height: 13, width: '36%', marginBottom: 30 }} />
                    {[96, 100, 88, 100, 72].map((w, i) => (
                      <div key={i} className="dlp-skeleton" style={{ height: 13, width: `${w}%`, marginBottom: 12, animationDelay: `${i * 90}ms` }} />
                    ))}
                  </div>
                </div>
              )}
              {tabRuntime.status === 'error' && (
                <ErrorBar error={tabRuntime.error} onRetry={() => void load(tab, { force: true })} />
              )}
              {page && tab.mode === 'reader' && (
                <div className="dlp-reader-scroll">
                  <div className="dlp-reader-wrap">
                    <header className="dlp-pagehead">
                      <h1>{page.title}</h1>
                      <div className="dlp-pagehead-meta">
                        <ItemIcon icon={pageSite?.iconUrl} title={pageSiteTitle} className="dlp-nb-site-icon" />
                        <span>{pageSiteTitle}</span>
                        {page.meta?.publishedAt && <span>· {String(page.meta.publishedAt).slice(0, 10)}</span>}
                        {page.meta?.author && <span>· {page.meta.author}</span>}
                        {page.cached
                          ? <span className="dlp-badge" title="来自本地缓存，点 ↻ 重新抓取">缓存</span>
                          : <span className="dlp-badge dlp-badge-ok">新抓取</span>}
                      </div>
                    </header>
                    <article ref={isActive ? articleRef : null} className="dlp-reader" dangerouslySetInnerHTML={{ __html: page.html ?? '' }} />
                  </div>
                </div>
              )}
              {page && tab.mode === 'live' && (
                <>
                  <div className="dlp-pagehead-meta" style={{ padding: '6px 12px', borderBottom: '.5px solid var(--dsw-alias-border-l1)' }}>
                    <span>原页嵌入中 · 页面空白说明站点拒绝嵌入</span>
                    <button type="button" className="dlp-btn dlp-btn-sm" onClick={() => window.open(page.finalUrl, '_blank', 'noopener')}>↗ 浏览器打开</button>
                  </div>
                  <iframe className="dlp-live-frame" src={page.finalUrl} title={`原页：${page.title}`} />
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* 选区浮条 */}
      {selection && selPos && mode === 'reader' && (
        <div className="dlp-selbar" style={{ top: barTop, left: barLeft, transform: 'translateX(-50%)' }} role="toolbar" aria-label="选中内容操作">
          {quick.explain && (
            <button type="button" disabled={Boolean(runningExt)} onClick={() => void runExt(quick.explain, targetFor('selection'))}>
              {quick.explain.manifest?.icon ?? '💡'} 解释
            </button>
          )}
          {quick.translate && (
            <button type="button" disabled={Boolean(runningExt)} onClick={() => void runExt(quick.translate, targetFor('selection'))}>
              {quick.translate.manifest?.icon ?? '🇬🇧'} 翻译
            </button>
          )}
          {quick.note && (
            <button type="button" disabled={Boolean(runningExt)} onClick={() => void runExt(quick.note, targetFor('selection'))}>
              {quick.note.manifest?.icon ?? '📌'} 记笔记
            </button>
          )}
          {quick.more.length > 0 && (
            <button type="button" aria-expanded={selMenuOpen} onClick={() => setSelMenuOpen((value) => !value)}>更多 ▾</button>
          )}
          {runningExt && <Spinner label="扩展运行中" />}
          {selMenuOpen && (
            <div className="dlp-selbar-menu" role="menu">
              {quick.more.map((ext) => (
                <button key={ext.id} type="button" disabled={Boolean(runningExt)} onClick={() => void runExt(ext, targetFor('selection'))}>
                  {ext.manifest?.icon ?? '✨'} {ext.manifest?.name ?? ext.id}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 右侧栏：扩展轨 + 伴读 */}
      <aside className={`dlp-side${sideCollapsed ? ' dlp-side-collapsed' : ''}`}>
        <div className="dlp-rail">
          <div className="dlp-rail-head">🧰 扩展工具</div>
          {!current && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' }}>打开页面后，这里按上下文出现可用扩展</p>}
          {current && (
            <>
              <div className="dlp-rail-group" data-active={Boolean(selection)}>
                <p className="dlp-rail-group-title">✂️ 选区{selection ? ` · ${Array.from(selection.quote).length} 字` : '（先选中正文）'}</p>
                <div className="dlp-rail-exts">
                  {byScope('selection').map((ext) => (
                    <button key={ext.id} type="button" className="dlp-rail-ext"
                      disabled={!selection || Boolean(runningExt)} title={ext.manifest?.description ?? ext.manifest?.name}
                      onClick={() => void runExt(ext, targetFor('selection'))}>
                      {runningExt === ext.id ? <Spinner /> : ext.manifest?.icon ?? '✨'} {ext.manifest?.name ?? ext.id}
                    </button>
                  ))}
                </div>
              </div>
              <div className="dlp-rail-group" data-active="true">
                <p className="dlp-rail-group-title">📄 本页</p>
                <div className="dlp-rail-exts">
                  {byScope('page').map((ext) => (
                    <button key={ext.id} type="button" className="dlp-rail-ext"
                      disabled={Boolean(runningExt)} title={ext.manifest?.description ?? ext.manifest?.name}
                      onClick={() => void runExt(ext, targetFor('page'))}>
                      {runningExt === ext.id ? <Spinner /> : ext.manifest?.icon ?? '✨'} {ext.manifest?.name ?? ext.id}
                    </button>
                  ))}
                </div>
              </div>
              <div className="dlp-rail-group" data-active="true">
                <p className="dlp-rail-group-title">🌐 整站</p>
                <div className="dlp-rail-exts">
                  {byScope('site').map((ext) => (
                    <button key={ext.id} type="button" className="dlp-rail-ext"
                      disabled={Boolean(runningExt)} title={ext.manifest?.description ?? ext.manifest?.name}
                      onClick={() => void runExt(ext, targetFor('site'))}>
                      {runningExt === ext.id ? <Spinner /> : ext.manifest?.icon ?? '✨'} {ext.manifest?.name ?? ext.id}
                    </button>
                  ))}
                </div>
              </div>
              {crawlPages !== null && (
                <div className="dlp-rail-progress"><Spinner label="抓取中" /><span>正在抓取站点… 已获取 {crawlPages} 页</span></div>
              )}
            </>
          )}
        </div>
        <Companion
          env={env}
          siteId={siteId}
          siteTitle={siteTitle}
          page={current}
          selection={selection}
          onCollapse={() => setSideCollapsed(true)}
        />
      </aside>
    </div>
  );
}
