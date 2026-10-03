/**
 * 导航视图：置顶区 + 分组卡片网格 + 搜索/分组过滤 + 批量添加 + 拖拽排序。
 * 点击：link → 阅读视图打开；tool → ToolFrame 打开；打开即 touchOpened。
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, EmptyState, ErrorBar, ItemIcon, hostOf } from '../components/ui.jsx';

function groupKeyOf(item) {
  return item.pinned ? 'pinned' : item.groupId ? `g:${item.groupId}` : 'ungrouped';
}

export function NavView({ env, active }) {
  const { api, state, toast } = env;
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState('all'); // all | groupId
  const [dialog, setDialog] = useState(null); // {kind:'add'|'edit'|'group'|'renameGroup'|'delete', ...}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(null); // {id, zone}
  const [dragOver, setDragOver] = useState(null); // itemId

  useEffect(() => { setError(''); }, [dialog?.kind]);

  const items = state?.items ?? [];
  const groups = state?.groups ?? [];
  const q = query.trim().toLowerCase();

  const visible = useMemo(() => {
    let list = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (chip !== 'all') list = list.filter((item) => item.groupId === chip || (chip === 'none' && !item.groupId));
    if (q) list = list.filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(q));
    return list;
  }, [items, chip, q]);

  const sections = useMemo(() => {
    const out = [];
    const pinned = visible.filter((item) => item.pinned);
    if (pinned.length) out.push({ key: 'pinned', title: '📌 置顶', items: pinned });
    for (const group of [...groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const list = visible.filter((item) => !item.pinned && item.groupId === group.id);
      if (list.length) out.push({ key: `g:${group.id}`, title: group.name, group, items: list });
    }
    const rest = visible.filter((item) => !item.pinned && (!item.groupId || !groups.some((g) => g.id === item.groupId)));
    if (rest.length) out.push({ key: 'ungrouped', title: groups.length ? '未分组' : '全部收藏', items: rest });
    return out;
  }, [visible, groups]);

  const run = async (fn, okText) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await env.refresh();
      if (okText) toast(okText, 'ok');
      setDialog(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  function openItem(item) {
    void api.touchOpened({ id: item.id }).catch(() => {});
    if (item.kind === 'tool' && item.toolId) {
      env.openFrame({ title: item.title, src: `/api/launchpad/tool/${item.toolId}/index.html` });
    } else if (item.kind === 'link' && item.url) {
      env.openReader(item.url);
    } else {
      toast('该条目暂不支持打开', 'warn');
    }
  }

  async function addUrls(text, groupId) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error('请至少输入一个 URL');
    let added = 0;
    const errors = [];
    for (const line of lines) {
      const url = /^https?:\/\//i.test(line) ? line : `https://${line}`;
      try {
        const { item } = await api.addItem({ kind: 'link', title: hostOf(url), url, groupId: groupId ?? null });
        added += 1;
        // 后台抓取真标题后更新（失败无碍）
        void api.openUrl({ url })
          .then((page) => (page?.title ? api.updateItem({ id: item.id, patch: { title: page.title } }) : null))
          .then(() => env.refresh())
          .catch(() => {});
      } catch (cause) {
        errors.push(`${line}：${cause?.message ?? String(cause)}`);
      }
    }
    await env.refresh();
    if (added) toast(`已收藏 ${added} 个网址`, 'ok');
    if (errors.length) throw new Error(errors.join('\n'));
  }

  // ---- 拖拽排序（同区内；全局 id 序提交，避免打乱其他区） ----------------
  function onDrop(zone, beforeId) {
    if (!drag || drag.zone !== zone) return;
    const zoneItems = visible.filter((item) => groupKeyOf(item) === zone);
    const ids = zoneItems.map((item) => item.id).filter((id) => id !== drag.id);
    const at = beforeId ? ids.indexOf(beforeId) : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, drag.id);
    const queue = [...ids];
    const globalOrder = [...items]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((item) => (groupKeyOf(item) === zone ? queue.shift() : item.id))
      .filter(Boolean);
    setDrag(null);
    setDragOver(null);
    void run(() => api.reorderItems({ ids: globalOrder }));
  }

  const filterActive = q.length > 0;

  return (
    <div className="dlp-nav">
      <div className="dlp-nav-toolbar">
        <div className="dlp-nav-search">
          <span aria-hidden="true">🔍</span>
          <input className="dlp-input" placeholder="搜索标题或网址…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="dlp-chips">
          <button type="button" className="dlp-chip" aria-pressed={chip === 'all'} onClick={() => setChip('all')}>全部</button>
          {groups.map((group) => (
            <button key={group.id} type="button" className="dlp-chip" aria-pressed={chip === group.id} onClick={() => setChip(group.id)}>{group.name}</button>
          ))}
          <button type="button" className="dlp-chip dlp-chip-add" title="新建分组" onClick={() => setDialog({ kind: 'group', name: '' })}>＋分组</button>
        </div>
      </div>

      {error && !dialog && <ErrorBar error={error} onClose={() => setError('')} />}

      {!visible.length && (
        <EmptyState
          icon="🗂"
          title={items.length ? '没有匹配的收藏' : '收藏夹还是空的'}
          desc={items.length ? '换个关键词试试' : '点下方「添加网址」，或在上方 ✨ 输入框让 AI 帮你折腾'}
        >
          {!items.length && <button type="button" className="dlp-btn dlp-btn-primary" onClick={() => setDialog({ kind: 'add', text: '', groupId: chip !== 'all' ? chip : null })}>➕ 添加网址</button>}
        </EmptyState>
      )}

      {sections.map((section) => (
        <section key={section.key} className="dlp-nav-section">
          <h2 className="dlp-nav-section-title">
            {section.title}
            {section.group && (
              <>
                <button type="button" className="dlp-icon-btn" style={{ width: 20, height: 20, fontSize: 11 }} title="重命名分组" aria-label="重命名分组"
                  onClick={() => setDialog({ kind: 'renameGroup', id: section.group.id, name: section.group.name })}>✎</button>
                <button type="button" className="dlp-icon-btn" style={{ width: 20, height: 20, fontSize: 11 }} title="删除分组（条目保留为未分组）" aria-label="删除分组"
                  onClick={() => setDialog({ kind: 'deleteGroup', id: section.group.id, name: section.group.name })}>✕</button>
              </>
            )}
          </h2>
          <div className="dlp-nav-grid"
            onDragOver={(event) => { if (drag?.zone === section.key) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); onDrop(section.key, null); }}
          >
            {section.items.map((item, index) => (
              <div
                key={item.id}
                role="button" tabIndex={0}
                className={`dlp-card${dragOver === item.id ? ' dlp-drag-over' : ''}${drag?.id === item.id ? ' dlp-dragging' : ''}`}
                style={{ animationDelay: `${Math.min(index * 24, 200)}ms` }}
                draggable={!filterActive}
                onDragStart={(event) => { setDrag({ id: item.id, zone: section.key }); event.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => { setDrag(null); setDragOver(null); }}
                onDragOver={(event) => { if (drag?.zone === section.key && drag.id !== item.id) { event.preventDefault(); event.stopPropagation(); setDragOver(item.id); } }}
                onDragLeave={() => setDragOver((cur) => (cur === item.id ? null : cur))}
                onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDrop(section.key, item.id); }}
                onClick={() => openItem(item)}
                onKeyDown={(event) => { if (event.key === 'Enter') openItem(item); }}
              >
                {item.pinned && <span className="dlp-card-pin" aria-hidden="true">📌</span>}
                <ItemIcon icon={item.icon} title={item.title} />
                <p className="dlp-card-title">{item.title}</p>
                <p className="dlp-card-sub">{item.kind === 'tool' ? '🛠 生成工具' : hostOf(item.url)}</p>
                <div className="dlp-card-actions" onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="dlp-icon-btn" title="打开" aria-label="打开" onClick={() => openItem(item)}>↗</button>
                  <button type="button" className="dlp-icon-btn" title="编辑" aria-label="编辑"
                    onClick={() => setDialog({ kind: 'edit', id: item.id, title: item.title, icon: item.icon ?? '', groupId: item.groupId ?? '' })}>✎</button>
                  <button type="button" className="dlp-icon-btn" title={item.pinned ? '取消置顶' : '置顶'} aria-label="置顶"
                    onClick={() => run(() => api.pinItem({ id: item.id, pinned: !item.pinned }))}>{item.pinned ? '📍' : '📌'}</button>
                  <button type="button" className="dlp-icon-btn" title="删除" aria-label="删除"
                    onClick={() => setDialog({ kind: 'delete', id: item.id, title: item.title })}>🗑</button>
                </div>
              </div>
            ))}
            {section.key === 'ungrouped' || sections.indexOf(section) === sections.length - 1 ? (
              <button type="button" className="dlp-card dlp-card-add" onClick={() => setDialog({ kind: 'add', text: '', groupId: chip !== 'all' ? chip : null })}>
                <span style={{ fontSize: 20 }} aria-hidden="true">➕</span>
                添加网址
              </button>
            ) : null}
          </div>
        </section>
      ))}

      {dialog?.kind === 'add' && (
        <Dialog title="添加网址" desc="支持批量：一行一个 URL（可省略 https://）" onClose={() => setDialog(null)}>
          <div className="dlp-field">
            <label htmlFor="dlp-add-urls">网址列表</label>
            <textarea id="dlp-add-urls" className="dlp-textarea" rows={5} placeholder={'https://example.com\ngithub.com/datawhalechina/hello-agents'}
              value={dialog.text} onChange={(e) => setDialog({ ...dialog, text: e.target.value })} />
          </div>
          {groups.length > 0 && (
            <div className="dlp-field">
              <label htmlFor="dlp-add-group">放入分组</label>
              <select id="dlp-add-group" className="dlp-select" value={dialog.groupId ?? ''} onChange={(e) => setDialog({ ...dialog, groupId: e.target.value || null })}>
                <option value="">不分组</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </div>
          )}
          {error && <ErrorBar error={error} />}
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-primary" disabled={busy || !dialog.text.trim()}
              onClick={() => run(() => addUrls(dialog.text, dialog.groupId))}>{busy ? '添加中…' : '收藏'}</button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === 'edit' && (
        <Dialog title="编辑收藏" onClose={() => setDialog(null)}>
          <div className="dlp-field">
            <label htmlFor="dlp-edit-title">标题</label>
            <input id="dlp-edit-title" className="dlp-input" value={dialog.title} onChange={(e) => setDialog({ ...dialog, title: e.target.value })} />
          </div>
          <div className="dlp-field">
            <label htmlFor="dlp-edit-icon">图标（emoji 或 favicon URL，留空用首字母）</label>
            <input id="dlp-edit-icon" className="dlp-input" value={dialog.icon} placeholder="📚" onChange={(e) => setDialog({ ...dialog, icon: e.target.value })} />
          </div>
          <div className="dlp-field">
            <label htmlFor="dlp-edit-group">分组</label>
            <select id="dlp-edit-group" className="dlp-select" value={dialog.groupId} onChange={(e) => setDialog({ ...dialog, groupId: e.target.value })}>
              <option value="">不分组</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          </div>
          {error && <ErrorBar error={error} />}
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-primary" disabled={busy || !dialog.title.trim()}
              onClick={() => run(() => api.updateItem({ id: dialog.id, patch: { title: dialog.title, icon: dialog.icon, groupId: dialog.groupId || null } }), '已保存')}>保存</button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === 'group' && (
        <Dialog title="新建分组" onClose={() => setDialog(null)}>
          <div className="dlp-field">
            <label htmlFor="dlp-group-name">分组名</label>
            <input id="dlp-group-name" className="dlp-input" value={dialog.name} placeholder="学习 / 工具 / 灵感…" onChange={(e) => setDialog({ ...dialog, name: e.target.value })} />
          </div>
          {error && <ErrorBar error={error} />}
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-primary" disabled={busy || !dialog.name.trim()}
              onClick={() => run(() => api.addGroup({ name: dialog.name }), '分组已创建')}>创建</button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === 'renameGroup' && (
        <Dialog title="重命名分组" onClose={() => setDialog(null)}>
          <div className="dlp-field">
            <label htmlFor="dlp-group-rename">分组名</label>
            <input id="dlp-group-rename" className="dlp-input" value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} />
          </div>
          {error && <ErrorBar error={error} />}
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-primary" disabled={busy || !dialog.name.trim()}
              onClick={() => run(() => api.renameGroup({ id: dialog.id, name: dialog.name }), '已重命名')}>保存</button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === 'deleteGroup' && (
        <Dialog title="删除分组" desc={`「${dialog.name}」将被删除，组内收藏会保留为未分组。`} onClose={() => setDialog(null)}>
          {error && <ErrorBar error={error} />}
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-danger" disabled={busy}
              onClick={() => run(() => api.removeGroup({ id: dialog.id }), '分组已删除')}>删除</button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === 'delete' && (
        <Dialog title="删除收藏" desc={`确定删除「${dialog.title}」吗？站点笔记本与高亮会保留。`} onClose={() => setDialog(null)}>
          {error && <ErrorBar error={error} />}
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setDialog(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-danger" disabled={busy}
              onClick={() => run(() => api.removeItem({ id: dialog.id }), '已删除')}>删除</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
