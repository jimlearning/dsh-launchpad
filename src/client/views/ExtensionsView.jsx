/**
 * 扩展视图：扩展卡片列表（启停 / 编辑 prompt / 删除）+ ✨ 一句话新增（Forge 流程）。
 * 激活时每 6s 静默刷新——host fs.watch 热加载的新扩展会自动上架。
 */
import { useCallback, useEffect, useState } from 'react';
import { Dialog, EmptyState, ErrorBar, Spinner, Switch } from '../components/ui.jsx';

const KIND_LABELS = { 'chat-task': '💬 对话任务', 'material-card': '🎴 材料卡片', 'local-tool': '🛠 本地工具', 'direct-action': '⚡ 直接动作' };
const SCOPE_LABELS = { site: '🌐 整站', page: '📄 页面', selection: '✂️ 选区' };
const SOURCE_LABELS = { builtin: '内置', user: '自定义', agent: 'AI 造' };

export function ExtensionsView({ env, active }) {
  const { api, toast } = env;
  const [extensions, setExtensions] = useState(null);
  const [error, setError] = useState('');
  const [oneLiner, setOneLiner] = useState('');
  const [editing, setEditing] = useState(null); // {id, prompt}
  const [confirmDelete, setConfirmDelete] = useState(null); // entry
  const [busy, setBusy] = useState(false);

  const load = useCallback((silent = false) => {
    if (!silent) setError('');
    api.listExtensions()
      .then((result) => setExtensions(result.extensions ?? []))
      .catch((cause) => { if (!silent) setError(cause?.message ?? String(cause)); });
  }, [api]);

  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(() => load(true), 6000);
    return () => clearInterval(timer);
  }, [active, load]);

  async function toggle(entry, enabled) {
    try {
      await api.setExtensionEnabled({ id: entry.id, enabled });
      setExtensions((list) => list.map((e) => (e.id === entry.id ? { ...e, enabled } : e)));
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    }
  }

  async function savePrompt() {
    if (!editing) return;
    setBusy(true);
    try {
      const entry = extensions.find((e) => e.id === editing.id);
      await api.saveExtension({ manifest: entry.manifest, prompt: editing.prompt });
      toast('提示词已保存', 'ok');
      setEditing(null);
      load(true);
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry) {
    setBusy(true);
    try {
      await api.removeExtension({ id: entry.id });
      toast(`已删除扩展「${entry.manifest?.name ?? entry.id}」`, 'ok');
      setConfirmDelete(null);
      load(true);
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  function forge() {
    const text = oneLiner.trim();
    if (!text) return;
    setOneLiner('');
    env.startForge({ kind: 'extension', oneLiner: text });
  }

  return (
    <div className="dlp-exts">
      <form className="dlp-ext-forge" onSubmit={(event) => { event.preventDefault(); forge(); }}>
        <input className="dlp-input" value={oneLiner} placeholder="✨ 一句话新增扩展：把文章变成播客稿 / 生成 Anki 卡片…"
          onChange={(event) => setOneLiner(event.target.value)} />
        <button type="submit" className="dlp-btn dlp-btn-primary" disabled={!oneLiner.trim()}>✨ 新增扩展</button>
      </form>

      {error && <ErrorBar error={error} onRetry={() => load()} onClose={() => setError('')} />}
      {!extensions && !error && <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 30, justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' }}><Spinner label="加载扩展" /> 加载扩展…</div>}
      {extensions && extensions.length === 0 && (
        <EmptyState icon="🧩" title="还没有扩展" desc="在上方输入一句话，AI 会为你写一个扩展；内置扩展会随插件升级播种" />
      )}

      <div className="dlp-ext-grid">
        {(extensions ?? []).map((entry, index) => {
          const m = entry.manifest ?? {};
          return (
            <div key={entry.id} className="dlp-ext-card" data-disabled={!entry.enabled} style={{ animationDelay: `${Math.min(index * 30, 240)}ms` }}>
              <div className="dlp-ext-head">
                <span className="dlp-ext-icon" aria-hidden="true">{m.icon ?? '✨'}</span>
                <div className="dlp-ext-title">
                  <strong>{m.name ?? entry.id}</strong>
                  <small>{entry.id}</small>
                </div>
                <Switch checked={entry.enabled} label={`启用 ${m.name ?? entry.id}`} onChange={(enabled) => void toggle(entry, enabled)} />
              </div>
              {m.description ? <p className="dlp-ext-desc">{m.description}</p> : null}
              <div className="dlp-ext-badges">
                {(m.scopes ?? []).map((scope) => <span key={scope} className="dlp-badge">{SCOPE_LABELS[scope] ?? scope}</span>)}
                <span className="dlp-badge">{KIND_LABELS[m.kind] ?? m.kind}</span>
                <span className={`dlp-badge${m.source === 'builtin' ? ' dlp-badge-brand' : m.source === 'agent' ? ' dlp-badge-ok' : ''}`}>{SOURCE_LABELS[m.source] ?? m.source ?? '自定义'}</span>
                {entry.valid === false && <span className="dlp-badge dlp-badge-error">清单损坏</span>}
              </div>
              {entry.valid === false && Array.isArray(entry.errors) && entry.errors.length > 0 && (
                <p className="dlp-ext-errors">{entry.errors.join('；')}</p>
              )}
              <div className="dlp-ext-actions">
                <button type="button" className="dlp-btn dlp-btn-sm dlp-btn-ghost" onClick={() => setEditing(editing?.id === entry.id ? null : { id: entry.id, prompt: entry.prompt ?? '' })}>
                  {editing?.id === entry.id ? '收起' : '✎ 提示词'}
                </button>
                <span className="dlp-spacer" />
                <button type="button" className="dlp-btn dlp-btn-sm dlp-btn-ghost dlp-btn-danger" onClick={() => setConfirmDelete(entry)}>删除</button>
              </div>
              {editing?.id === entry.id && (
                <div className="dlp-ext-prompt">
                  <textarea className="dlp-textarea" value={editing.prompt} spellCheck={false}
                    placeholder={'提示词模板，支持变量：{{material.title}} {{material.url}} {{material.markdown}} {{selection.quote}} {{date}} {{siteId}}'}
                    onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} />
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="dlp-btn dlp-btn-sm" onClick={() => setEditing(null)}>取消</button>
                    <button type="button" className="dlp-btn dlp-btn-sm dlp-btn-primary" disabled={busy} onClick={() => void savePrompt()}>保存提示词</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmDelete && (
        <Dialog
          title="删除扩展"
          desc={confirmDelete.manifest?.source === 'builtin'
            ? `「${confirmDelete.manifest?.name ?? confirmDelete.id}」是内置扩展，删除后插件升级时会重新播种。确定删除？`
            : `确定删除扩展「${confirmDelete.manifest?.name ?? confirmDelete.id}」吗？该操作会删除扩展定义文件。`}
          onClose={() => setConfirmDelete(null)}
        >
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setConfirmDelete(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-danger" disabled={busy} onClick={() => void remove(confirmDelete)}>
              {confirmDelete.manifest?.source === 'builtin' ? '确认删除内置扩展' : '删除'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
