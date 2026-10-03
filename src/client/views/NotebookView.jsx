/**
 * 笔记本视图：站点列表 → 学习路线（可勾选 roadmap）/ 笔记（在线编辑）/ 高亮 / 产物 / 已读页面。
 * roadmap 勾选：改文本回写 writeSiteFile + setProgress 记 {roadmapDone:[...]}。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { runExtensionFlow } from '../components/runner.jsx';
import { EmptyState, ErrorBar, ItemIcon, Spinner, formatDateTime, formatTime, hostOf } from '../components/ui.jsx';

function parseRoadmap(text) {
  return String(text ?? '').split('\n').map((line, index) => {
    const item = line.match(/^\s*- \[( |x|X)\]\s+(.*)$/);
    if (item) return { type: 'item', index, done: item[1] !== ' ', text: item[2].trim() };
    if (!line.trim()) return { type: 'blank', index };
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) return { type: 'heading', index, text: heading[1].replace(/\*\*/g, '') };
    return { type: 'line', index, text: line };
  });
}

function Section({ id, icon, title, badge, openMap, setOpenMap, children, actions }) {
  const open = openMap[id] !== false;
  return (
    <section className="dlp-nb-section" data-open={open}>
      <button type="button" className="dlp-nb-section-head" onClick={() => setOpenMap({ ...openMap, [id]: !open })}>
        <span className="dlp-caret" aria-hidden="true">▶</span>
        <span aria-hidden="true">{icon}</span>
        <strong>{title}</strong>
        {badge}
        {actions && <span onClick={(event) => event.stopPropagation()} style={{ display: 'inline-flex', gap: 6 }}>{actions}</span>}
      </button>
      {open && <div className="dlp-nb-section-body">{children}</div>}
    </section>
  );
}

export function NotebookView({ env, active }) {
  const { api, state, toast } = env;
  const [siteId, setSiteId] = useState(null);
  const [notebook, setNotebook] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openMap, setOpenMap] = useState({ roadmap: true, notes: true });
  const [roadmap, setRoadmap] = useState(null); // {content, items}
  const [roadmapBusy, setRoadmapBusy] = useState(false);
  const [note, setNote] = useState(null); // {name, content, dirty, saving}
  const [digest, setDigest] = useState(null); // {name, content, truncated}
  const [generating, setGenerating] = useState(false);
  const [crawlPages, setCrawlPages] = useState(null);

  const sites = useMemo(() => Object.values(state?.sites ?? {})
    .sort((a, b) => String(b.lastVisitedAt ?? '').localeCompare(String(a.lastVisitedAt ?? ''))), [state?.sites]);

  const loadNotebook = useCallback(async (id) => {
    setLoading(true);
    setError('');
    try {
      const { notebook: nb } = await api.listNotebook({ siteId: id });
      setNotebook(nb);
      if (nb.hasRoadmap) {
        const file = await api.readSiteFile({ siteId: id, relPath: 'notebook/roadmap.md' }).catch(() => null);
        setRoadmap(file ? { content: file.content, rows: parseRoadmap(file.content) } : null);
      } else {
        setRoadmap(null);
      }
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setNotebook(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!active) return;
    if (!siteId && sites.length) setSiteId(sites[0].id);
  }, [active, siteId, sites]);

  useEffect(() => {
    if (!active || !siteId) return;
    setNote(null);
    setDigest(null);
    void loadNotebook(siteId);
  }, [active, siteId, loadNotebook]);

  // ---------------------------------------------------------- roadmap 勾选
  async function toggleRoadmap(row) {
    if (!roadmap || roadmapBusy) return;
    setRoadmapBusy(true);
    try {
      const lines = roadmap.content.split('\n');
      lines[row.index] = lines[row.index].replace(/- \[( |x|X)\]/, row.done ? '- [ ]' : '- [x]');
      const content = lines.join('\n');
      await api.writeSiteFile({ siteId, relPath: 'notebook/roadmap.md', content });
      const rows = parseRoadmap(content);
      setRoadmap({ content, rows });
      const done = rows.filter((r) => r.type === 'item' && r.done).map((r) => r.text);
      await api.setProgress({ siteId, progress: { ...(notebook?.progress ?? {}), roadmapDone: done, updatedAt: new Date().toISOString() } });
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setRoadmapBusy(false);
    }
  }

  // ---------------------------------------------------------- 生成学习路径
  async function generateRoadmap() {
    if (generating) return;
    setGenerating(true);
    setCrawlPages(null);
    try {
      const { extensions } = await api.listExtensions();
      const ext = (extensions ?? []).find((e) => e.enabled && e.valid !== false
        && e.manifest?.scopes?.includes('site') && /学习路径|学习路线|路线图|roadmap/i.test(e.manifest?.name ?? ''));
      if (!ext) throw new Error('未找到「学习路径」扩展——可在扩展视图 ✨ 一句话新增一个');
      await runExtensionFlow(
        { api, companion: env.companion, toast, openFrame: env.openFrame },
        ext,
        { scope: 'site', siteId },
        { onProgress: (pages) => setCrawlPages(pages) },
      );
      // agent 异步落盘：轮询等 roadmap 出现（最多约 2 分钟）
      for (let i = 0; i < 24; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const { notebook: nb } = await api.listNotebook({ siteId }).catch(() => ({ notebook: null }));
        if (nb?.hasRoadmap) { await loadNotebook(siteId); toast('🗺 学习路径已生成', 'ok'); return; }
      }
      toast('伴读仍在生成中，稍后点刷新查看', 'warn');
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setGenerating(false);
      setCrawlPages(null);
    }
  }

  // ---------------------------------------------------------- 笔记
  async function openNote(name) {
    try {
      const file = await api.readSiteFile({ siteId, relPath: `notebook/notes/${name}` });
      setNote({ name, content: file.content, saved: file.content, saving: false });
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    }
  }
  async function saveNote() {
    if (!note) return;
    setNote({ ...note, saving: true });
    try {
      await api.writeSiteFile({ siteId, relPath: `notebook/notes/${note.name}`, content: note.content });
      toast('笔记已保存', 'ok');
      setNote({ ...note, saved: note.content, saving: false });
      void loadNotebook(siteId);
    } catch (cause) {
      setNote({ ...note, saving: false });
      toast(cause?.message ?? String(cause), 'error');
    }
  }
  function newNote() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `笔记-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`;
    void api.writeSiteFile({ siteId, relPath: `notebook/notes/${name}`, content: '# 笔记\n\n' })
      .then(() => loadNotebook(siteId))
      .then(() => openNote(name))
      .catch((cause) => toast(cause?.message ?? String(cause), 'error'));
  }

  async function openDigest(name) {
    try {
      const file = await api.readSiteFile({ siteId, relPath: `digests/${name}` });
      setDigest({ name, content: file.content, truncated: file.truncated });
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    }
  }

  const roadmapStats = useMemo(() => {
    if (!roadmap) return null;
    const items = roadmap.rows.filter((r) => r.type === 'item');
    if (!items.length) return null;
    return { done: items.filter((r) => r.done).length, total: items.length };
  }, [roadmap]);

  return (
    <div className="dlp-notebook">
      <aside className="dlp-nb-sites">
        {sites.length === 0 && <p style={{ padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>还没有站点档案——先从导航打开一个网址</p>}
        {sites.map((site) => (
          <button key={site.id} type="button" className="dlp-nb-site" aria-selected={siteId === site.id} onClick={() => setSiteId(site.id)}>
            <ItemIcon icon={site.iconUrl} title={site.title} className="dlp-nb-site-icon" />
            <span className="dlp-nb-site-name" title={site.baseUrl}>{site.title || hostOf(site.baseUrl)}</span>
            <span className="dlp-nb-site-date">{formatTime(site.lastVisitedAt)}</span>
          </button>
        ))}
      </aside>

      <div className="dlp-nb-main">
        {error && <ErrorBar error={error} onRetry={() => siteId && void loadNotebook(siteId)} onClose={() => setError('')} />}
        {loading && <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 30, justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' }}><Spinner label="加载笔记本" /> 加载笔记本…</div>}
        {!loading && !siteId && <EmptyState icon="📓" title="选择站点查看笔记本" desc="每个站点的笔记、高亮、学习路线与扩展产物都收在这里" />}
        {!loading && siteId && notebook && (
          <>
            <Section id="roadmap" icon="🗺" title="学习路线" openMap={openMap} setOpenMap={setOpenMap}
              badge={roadmapStats ? <span className="dlp-badge dlp-badge-brand">{roadmapStats.done}/{roadmapStats.total}</span> : null}
              actions={
                <button type="button" className="dlp-btn dlp-btn-sm" disabled={generating} onClick={generateRoadmap}>
                  {generating ? <><Spinner /> 生成中{crawlPages !== null ? ` · 已抓 ${crawlPages} 页` : '…'}</> : roadmap ? '↻ 重新生成' : '✨ 生成学习路径'}
                </button>
              }>
              {roadmap ? (
                <div className="dlp-nb-roadmap" aria-busy={roadmapBusy}>
                  {roadmap.rows.map((row) => {
                    if (row.type === 'item') {
                      return (
                        <label key={row.index} className="dlp-nb-roadmap-item" data-done={row.done}>
                          <input type="checkbox" checked={row.done} disabled={roadmapBusy} onChange={() => void toggleRoadmap(row)} />
                          <span>{row.text}</span>
                        </label>
                      );
                    }
                    if (row.type === 'heading') return <div key={row.index} className="dlp-nb-roadmap-lineh">{row.text}</div>;
                    if (row.type === 'line') return <div key={row.index} className="dlp-nb-roadmap-line">{row.text}</div>;
                    return null;
                  })}
                </div>
              ) : (
                <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' }}>
                  还没有学习路线。点「✨ 生成学习路径」，AI 会抓取站点结构并产出章节路线图。
                </p>
              )}
            </Section>

            <Section id="notes" icon="📝" title="笔记" openMap={openMap} setOpenMap={setOpenMap}
              badge={notebook.notes.length ? <span className="dlp-badge">{notebook.notes.length}</span> : null}
              actions={<button type="button" className="dlp-btn dlp-btn-sm" onClick={newNote}>＋ 新建</button>}>
              {notebook.notes.length === 0 && <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' }}>还没有笔记</p>}
              <div className="dlp-nb-list">
                {notebook.notes.map((entry) => (
                  <button key={entry.name} type="button" className="dlp-nb-row" aria-selected={note?.name === entry.name} onClick={() => void openNote(entry.name)}>
                    <span aria-hidden="true">📄</span>
                    <span className="dlp-nb-row-main">
                      <p className="dlp-nb-row-title">{entry.name.replace(/\.md$/, '')}</p>
                      <p className="dlp-nb-row-sub">{formatDateTime(entry.mtime)}</p>
                    </span>
                  </button>
                ))}
              </div>
              {note && (
                <div className="dlp-nb-editor">
                  <textarea className="dlp-textarea" value={note.content} onChange={(e) => setNote({ ...note, content: e.target.value })} />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button type="button" className="dlp-btn dlp-btn-primary dlp-btn-sm" disabled={note.saving || note.content === note.saved} onClick={() => void saveNote()}>
                      {note.saving ? '保存中…' : '保存'}
                    </button>
                    {note.content !== note.saved && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' }}>有未保存的修改</span>}
                  </div>
                </div>
              )}
            </Section>

            <Section id="highlights" icon="🖍" title="高亮" openMap={openMap} setOpenMap={setOpenMap}
              badge={notebook.highlights.length ? <span className="dlp-badge">{notebook.highlights.length}</span> : null}>
              {notebook.highlights.length === 0 && <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' }}>阅读时选中内容点「📌 记笔记」，高亮会收在这里</p>}
              <div className="dlp-nb-list">
                {[...notebook.highlights].reverse().map((hl) => (
                  <div key={hl.id} className="dlp-nb-highlight">
                    <blockquote>{hl.quote}</blockquote>
                    <footer>
                      <span>{hl.pageTitle || hostOf(hl.url)}</span>
                      <span>{formatTime(hl.createdAt)}</span>
                      {hl.note && <span>💭 {hl.note}</span>}
                    </footer>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="artifacts" icon="🎁" title="产物" openMap={openMap} setOpenMap={setOpenMap}
              badge={(notebook.digests.length + notebook.cards.length) ? <span className="dlp-badge">{notebook.digests.length + notebook.cards.length}</span> : null}>
              {notebook.digests.length + notebook.cards.length === 0 && <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' }}>扩展生成的周报、卡片等产物会出现在这里</p>}
              <div className="dlp-nb-list">
                {notebook.cards.map((entry) => (
                  <button key={`c-${entry.name}`} type="button" className="dlp-nb-row"
                    onClick={() => env.openFrame({ title: entry.name, src: `/api/launchpad/card/${siteId}/${encodeURIComponent(entry.name)}` })}>
                    <span aria-hidden="true">🖼</span>
                    <span className="dlp-nb-row-main">
                      <p className="dlp-nb-row-title">{entry.name}</p>
                      <p className="dlp-nb-row-sub">卡片 · {formatDateTime(entry.mtime)}</p>
                    </span>
                    <span className="dlp-badge dlp-badge-brand">预览</span>
                  </button>
                ))}
                {notebook.digests.map((entry) => (
                  <button key={`d-${entry.name}`} type="button" className="dlp-nb-row" aria-selected={digest?.name === entry.name} onClick={() => void openDigest(entry.name)}>
                    <span aria-hidden="true">📰</span>
                    <span className="dlp-nb-row-main">
                      <p className="dlp-nb-row-title">{entry.name}</p>
                      <p className="dlp-nb-row-sub">摘要 · {formatDateTime(entry.mtime)}</p>
                    </span>
                  </button>
                ))}
              </div>
              {digest && (
                <pre className="dlp-nb-pre">{digest.content}{digest.truncated ? '\n\n…（内容过长已截断）' : ''}</pre>
              )}
            </Section>

            <Section id="pages" icon="🗃" title="已读页面" openMap={openMap} setOpenMap={setOpenMap}
              badge={notebook.pages.length ? <span className="dlp-badge">{notebook.pages.length}</span> : null}>
              {notebook.pages.length === 0 && <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' }}>还没有缓存页面</p>}
              <div className="dlp-nb-list">
                {notebook.pages.map((page) => (
                  <button key={page.pageId} type="button" className="dlp-nb-row" onClick={() => page.url && env.openReader(page.url)}>
                    <span aria-hidden="true">🔗</span>
                    <span className="dlp-nb-row-main">
                      <p className="dlp-nb-row-title">{page.title || page.url}</p>
                      <p className="dlp-nb-row-sub">{page.url} · {formatTime(page.fetchedAt)}</p>
                    </span>
                    <span className="dlp-badge">打开</span>
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
