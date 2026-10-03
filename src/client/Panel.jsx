/**
 * dsh-launchpad 主面板：标题栏（视图 tab + ⚙设置）+ 全局 ForgeBar + 五视图容器。
 * 状态：listState 单一数据源 + refresh()；伴读会话经 companion 管理器（api._chat bridge）。
 * 视图 keep-alive：访问过的视图保持挂载（hidden 切换），阅读进度/会话不丢。
 */
import CSS from './styles.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeUrl } from '../shared/protocol.js';
import { createCompanion } from './companion/chat.js';
import { NavView } from './views/NavView.jsx';
import { ReaderView } from './views/ReaderView.jsx';
import { NotebookView } from './views/NotebookView.jsx';
import { ExtensionsView } from './views/ExtensionsView.jsx';
import { ToolsView } from './views/ToolsView.jsx';
import { ToolFrame } from './components/ToolFrame.jsx';
import { ErrorBar, Segmented, Spinner, Switch, Toasts, hostOf } from './components/ui.jsx';

let stylesReady = false;
function ensureStyles() {
  if (stylesReady) return;
  stylesReady = true;
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-launchpad';
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** 侧栏图标：🚀 火箭，active 用品牌色。 */
export function PanelIcon({ size = 18, active = false }) {
  const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color, display: 'block' }}>
      <path d="M12 2.2c3.1 1.8 4.9 5.5 4.9 9.3l-2.1 2.1H9.2L7.1 11.5c0-3.8 1.8-7.5 4.9-9.3Z"
        stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="12" cy="9" r="1.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.2 13.6 7.3 17.2l3.1-.8M14.8 13.6l1.9 3.6-3.1-.8"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 16.6c-1 1.4-1 3 0 4.6 1-1.6 1-3.2 0-4.6Z"
        fill={active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'} opacity={active ? 1 : 0.55} />
    </svg>
  );
}

const VIEWS = [
  { id: 'nav', icon: '🏠', label: '导航' },
  { id: 'reader', icon: '📖', label: '阅读' },
  { id: 'notebook', icon: '📓', label: '笔记本' },
  { id: 'extensions', icon: '🧩', label: '扩展' },
  { id: 'tools', icon: '🛠', label: '工具' },
];

export function Panel({ api, SessionProvider, renderSlot }) {
  ensureStyles();
  const [state, setState] = useState(null);
  const [stateError, setStateError] = useState('');
  const [view, setView] = useState('nav');
  const [visited, setVisited] = useState(() => new Set(['nav']));
  // 阅读器 tabs：描述符提升到 Panel（keep-alive 不丢）；page 运行时在 ReaderView 按 tabId 缓存
  const [tabs, setTabs] = useState([]); // [{id, url, title, siteId, pageId, mode}]
  const [activeTabId, setActiveTabId] = useState(null);
  const [frame, setFrame] = useState(null); // {title, src, bundle?, hint?}
  const [toasts, setToasts] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forgeBusy, setForgeBusy] = useState(false);

  const companion = useMemo(() => createCompanion(api), [api]);
  useEffect(() => () => companion.release(), [companion]);

  // ------------------------------------------------------------- toast
  const dismissToast = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const toast = useCallback((text, kind = 'info', action) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((list) => [...list.slice(-3), { id, text, kind, action }]);
    setTimeout(() => dismissToast(id), kind === 'error' ? 6500 : 4200);
  }, [dismissToast]);

  // ------------------------------------------------------------- 状态
  const refresh = useCallback(async () => {
    try {
      setState(await api.listState());
      setStateError('');
    } catch (cause) {
      setStateError(cause?.message ?? String(cause));
    }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  // 有工具锻造中 → 每 5s 轮询直至全部就绪（ToolWatcher 驱动上架）
  const forging = Object.values(state?.tools ?? {}).some((tool) => tool.status === 'forging');
  useEffect(() => {
    if (!forging) return undefined;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [forging, refresh]);

  // ------------------------------------------------------------- 跨视图动作
  /** 打开网页：URL 归一去重——已在 tabs 中激活既有 tab，否则新建；切到阅读视图。 */
  const openReader = useCallback((url) => {
    if (state?.settings?.openLinksIn === 'browser') {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const norm = normalizeUrl(url) ?? String(url ?? '').trim();
    if (!norm) return;
    const existing = tabs.find((tab) => tab.url === norm);
    if (existing) {
      setActiveTabId(existing.id);
    } else {
      const tab = {
        id: `tab${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        url: norm,
        title: hostOf(norm),
        siteId: null,
        pageId: null,
        mode: state?.settings?.openLinksIn === 'live' ? 'live' : 'reader',
      };
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
    }
    setVisited((seen) => (seen.has('reader') ? seen : new Set(seen).add('reader')));
    setView('reader');
  }, [tabs, state?.settings?.openLinksIn]);

  const updateTab = useCallback((id, patch) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  }, []);

  /** 关闭 tab；关的是激活 tab 时切换到右邻（无则左邻）；关到最后一个回空态。 */
  const closeTab = useCallback((id) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (activeTabId === id) setActiveTabId((next[index] ?? next[index - 1])?.id ?? null);
  }, [tabs, activeTabId]);

  const openFrame = useCallback((next) => setFrame(next), []);

  /** 把锻造提示词发到新会话（retryTool 复用）；sendPrompt 不支持时降级复制。 */
  const forgeWithPrompt = useCallback(async (prompt) => {
    const workspaceId = await api._chat.ensureWorkspace();
    const chat = await api._chat.openChat({ workspaceId });
    try {
      await chat.sendPrompt(prompt);
    } catch (cause) {
      try {
        await navigator.clipboard?.writeText(prompt);
        toast('快捷发送不可用，提示词已复制——粘贴到任意会话即可继续锻造', 'warn');
      } catch {
        toast(`快捷发送失败：${cause?.message ?? String(cause)}`, 'error');
      }
    } finally {
      chat.release();
    }
  }, [api, toast]);

  /** Forge 流程：ensureWorkspace → openChat → prepareForge → 直发 → 切视图。 */
  const startForge = useCallback(({ kind, oneLiner }) => {
    if (forgeBusy) return;
    setForgeBusy(true);
    void (async () => {
      const workspaceId = await api._chat.ensureWorkspace();
      const chat = await api._chat.openChat({ workspaceId });
      try {
        const { prompt } = await api.prepareForge({ kind, oneLiner, sessionId: chat.sessionId });
        try {
          await chat.sendPrompt(prompt);
        } catch (cause) {
          try {
            await navigator.clipboard?.writeText(prompt);
            toast('快捷发送不可用，提示词已复制——粘贴到任意会话即可继续锻造', 'warn');
          } catch {
            toast(`快捷发送失败：${cause?.message ?? String(cause)}`, 'error');
          }
        }
        toast(kind === 'tool' ? '🔨 锻造中，完成后自动上架到「工具」' : '🧩 扩展锻造中，完成后出现在「扩展」', 'ok');
        setView(kind === 'tool' ? 'tools' : 'extensions');
        setVisited((seen) => new Set(seen).add(kind === 'tool' ? 'tools' : 'extensions'));
        void refresh();
      } finally {
        chat.release();
      }
    })().catch((cause) => toast(cause?.message ?? String(cause), 'error'))
      .finally(() => setForgeBusy(false));
  }, [api, forgeBusy, refresh, toast]);

  const env = useMemo(() => ({
    api, state, refresh, toast, openReader, openFrame, startForge, forgeWithPrompt,
    companion, SessionProvider, renderSlot,
    tabs, activeTabId, updateTab, closeTab,
  }), [api, state, refresh, toast, openReader, openFrame, startForge, forgeWithPrompt, companion, SessionProvider, renderSlot, tabs, activeTabId, updateTab, closeTab]);

  const switchView = useCallback((id) => {
    setView(id);
    setVisited((seen) => (seen.has(id) ? seen : new Set(seen).add(id)));
  }, []);

  return (
    <div className="dlp-root">
      <header className="dlp-header">
        <h1 className="dlp-title"><span className="dlp-title-rocket" aria-hidden="true">🚀</span>发射台</h1>
        <nav className="dlp-tabs" role="tablist" aria-label="发射台视图">
          {VIEWS.map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={view === entry.id}
              className="dlp-tab" onClick={() => switchView(entry.id)}>
              <span aria-hidden="true">{entry.icon}</span>{entry.label}
            </button>
          ))}
        </nav>
        <button type="button" className="dlp-icon-btn" title="设置" aria-label="设置" aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
          </svg>
        </button>
      </header>

      <ForgeBar busy={forgeBusy} onForge={startForge} />

      {stateError && <ErrorBar error={stateError} onRetry={() => void refresh()} />}

      <div className="dlp-body">
        {visited.has('nav') && <div className="dlp-view" hidden={view !== 'nav'}><NavView env={env} active={view === 'nav'} /></div>}
        {visited.has('reader') && <div className="dlp-view" hidden={view !== 'reader'}><ReaderView env={env} active={view === 'reader'} /></div>}
        {visited.has('notebook') && <div className="dlp-view" hidden={view !== 'notebook'}><NotebookView env={env} active={view === 'notebook'} /></div>}
        {visited.has('extensions') && <div className="dlp-view" hidden={view !== 'extensions'}><ExtensionsView env={env} active={view === 'extensions'} /></div>}
        {visited.has('tools') && <div className="dlp-view" hidden={view !== 'tools'}><ToolsView env={env} active={view === 'tools'} /></div>}
      </div>

      {settingsOpen && <SettingsPanel env={env} onClose={() => setSettingsOpen(false)} />}
      {frame && <ToolFrame title={frame.title} src={frame.src} bundle={frame.bundle} hint={frame.hint} onClose={() => setFrame(null)} />}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/** 全局常驻 Forge 输入条。 */
function ForgeBar({ busy, onForge }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('tool'); // tool | extension
  const submit = () => {
    const oneLiner = text.trim();
    if (!oneLiner || busy) return;
    setText('');
    onForge({ kind: mode, oneLiner });
  };
  return (
    <div className="dlp-forge">
      <form className="dlp-forge-inner" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <span className="dlp-forge-spark" aria-hidden="true">✨</span>
        <input
          className="dlp-forge-input" value={text} disabled={busy}
          placeholder="✨ 一句话：造个工具 / 加个扩展…"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="dlp-forge-mode" role="group" aria-label="锻造模式">
          <button type="button" aria-pressed={mode === 'tool'} onClick={() => setMode('tool')}>🛠 造工具</button>
          <button type="button" aria-pressed={mode === 'extension'} onClick={() => setMode('extension')}>🧩 加扩展</button>
        </div>
        <button type="submit" className="dlp-forge-send" disabled={busy || !text.trim()}>
          {busy ? <><Spinner /> 锻造…</> : '🚀 发送'}
        </button>
      </form>
    </div>
  );
}

/** ⚙ 设置弹层。 */
function SettingsPanel({ env, onClose }) {
  const { api, state, refresh, toast } = env;
  const settings = state?.settings ?? {};
  const [busy, setBusy] = useState('');
  const [copiedDir, setCopiedDir] = useState(false);
  const [cardModel, setCardModel] = useState(() => settings.cardModel ?? '');
  const [savedModel, setSavedModel] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (patch) => {
    try {
      await api.saveSettings({ patch });
      await refresh();
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    }
  };

  const exportJson = async () => {
    setBusy('export');
    try {
      const { json } = await api.exportData();
      const blob = new Blob([json], { type: 'application/json' });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `launchpad-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
      toast('已导出数据备份', 'ok');
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const importJson = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api.importData({ json: String(reader.result) });
        await refresh();
        toast('导入完成（已合并）', 'ok');
      } catch (cause) {
        toast(cause?.message ?? String(cause), 'error');
      }
    };
    reader.onerror = () => toast('读取文件失败', 'error');
    reader.readAsText(file);
  };

  const recover = async () => {
    setBusy('recover');
    try {
      const { added } = await api.recoverIndex();
      await refresh();
      toast(`恢复扫描完成，新增 ${added} 条索引`, 'ok');
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setBusy('');
    }
  };

  const copyDir = () => {
    void navigator.clipboard?.writeText(state?.root ?? '')
      .then(() => {
        setCopiedDir(true);
        setTimeout(() => setCopiedDir(false), 1600);
      })
      .catch(() => toast('复制失败，请手动选择复制', 'warn'));
  };

  return (
    <>
      <div className="dlp-pop-mask" onClick={onClose} />
      <div className="dlp-settings" role="dialog" aria-label="发射台设置">
        <div className="dlp-settings-head">
          <h3>⚙ 设置</h3>
          <button type="button" className="dlp-icon-btn" title="关闭" aria-label="关闭设置" onClick={onClose}>✕</button>
        </div>

        <div className="dlp-set-group">
          <p className="dlp-set-group-title">打开方式</p>
          <div className="dlp-set-row">
            <div><span className="dlp-set-label">收藏默认打开方式</span><span className="dlp-set-hint">点导航卡片时的行为</span></div>
            <Segmented ariaLabel="默认打开方式" value={settings.openLinksIn ?? 'reader'} onChange={(value) => void save({ openLinksIn: value })}
              options={[{ value: 'reader', label: '📖 阅读' }, { value: 'live', label: '🌐 原页' }, { value: 'browser', label: '↗ 浏览器' }]} />
          </div>
        </div>

        <div className="dlp-set-group">
          <p className="dlp-set-group-title">发送行为</p>
          <div className="dlp-set-row">
            <div><span className="dlp-set-label">快捷任务直发</span><span className="dlp-set-hint">选区/页面级扩展：自动发送还是仅填草稿</span></div>
            <Segmented ariaLabel="快捷任务发送方式" value={settings.chatSendMode ?? 'auto'} onChange={(value) => void save({ chatSendMode: value })}
              options={[{ value: 'auto', label: '直发' }, { value: 'draft', label: '草稿' }]} />
          </div>
          <div className="dlp-set-row">
            <div><span className="dlp-set-label">整站大任务直发</span><span className="dlp-set-hint">站点级扩展（抓取多页，建议草稿确认）</span></div>
            <Segmented ariaLabel="大任务发送方式" value={settings.bigTaskSendMode ?? 'draft'} onChange={(value) => void save({ bigTaskSendMode: value })}
              options={[{ value: 'auto', label: '直发' }, { value: 'draft', label: '草稿' }]} />
          </div>
        </div>

        <div className="dlp-set-group">
          <p className="dlp-set-group-title">AI</p>
          <div className="dlp-set-row">
            <div><span className="dlp-set-label">AI 助手</span><span className="dlp-set-hint">关闭后 material-card 类扩展不可用</span></div>
            <Switch checked={settings.aiAssist !== false} label="AI 助手" onChange={(value) => void save({ aiAssist: value })} />
          </div>
        </div>

        <div className="dlp-set-group">
          <p className="dlp-set-group-title">数据</p>
          <div className="dlp-set-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div><span className="dlp-set-label">数据目录</span><span className="dlp-set-hint">收藏/站点/扩展/工具全部落盘于此，点击复制路径</span></div>
            <button type="button" className="dlp-set-dir" data-copied={copiedDir} title="点击复制路径" onClick={copyDir}>
              <span className="dlp-set-dir-icon" aria-hidden="true">{copiedDir ? '✓' : '⧉'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{copiedDir ? '已复制到剪贴板' : state?.root ?? '…'}</span>
            </button>
          </div>
          <div className="dlp-set-actions">
            <button type="button" className="dlp-btn dlp-btn-sm" disabled={busy === 'export'} onClick={() => void exportJson()}>⬇ 导出</button>
            <button type="button" className="dlp-btn dlp-btn-sm" title="从 JSON 备份合并恢复（不会删除现有条目之外的文件）" onClick={() => fileRef.current?.click()}>⬆ 导入</button>
            <button type="button" className="dlp-btn dlp-btn-sm" disabled={busy === 'recover'}
              title="data.json 丢失/损坏时，从 sites/ tools/ extensions/ 目录重建索引（只增不删）"
              onClick={() => void recover()}>
              {busy === 'recover' ? <><Spinner /> 扫描中…</> : '🩹 恢复扫描'}
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden
              onChange={(event) => { importJson(event.target.files?.[0]); event.target.value = ''; }} />
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55 }}>
            导入按合并语义覆盖索引；恢复扫描只增不删，从磁盘目录重建丢失的索引。两者都不动笔记与产物文件。
          </p>
        </div>
      </div>
    </>
  );
}
