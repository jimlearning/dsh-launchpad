/**
 * 工具视图：Forge 小工具网格。
 *  forging → 玻璃拟态 + 旋转彗星边框 + 呼吸动画；ready → 点击 ToolFrame 打开；
 *  failed → 错误信息 + 重试（retryTool → 新 Forge 会话发送）；missing → 产物缺失 + 重新生成。
 */
import { useMemo, useState } from 'react';
import { Dialog, EmptyState, Spinner, formatTime } from '../components/ui.jsx';

export function ToolsView({ env, active }) {
  const { api, toast } = env;
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const tools = useMemo(() => Object.values(env.state?.tools ?? {})
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))), [env.state?.tools]);

  function open(tool) {
    env.openFrame({ title: tool.title, src: `/api/launchpad/tool/${tool.id}/index.html` });
  }

  async function retry(tool) {
    try {
      const { prompt } = await api.retryTool({ id: tool.id });
      toast('已重新发起锻造', 'ok');
      await env.refresh();
      await env.forgeWithPrompt(prompt);
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    }
  }

  async function remove(tool) {
    setBusy(true);
    try {
      await api.removeTool({ id: tool.id });
      toast(`已删除工具「${tool.title}」`, 'ok');
      setConfirmDelete(null);
      await env.refresh();
    } catch (cause) {
      toast(cause?.message ?? String(cause), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dlp-tools">
      {tools.length === 0 && (
        <EmptyState icon="🛠" title="还没有小工具"
          desc="在上方 ✨ 输入框说一句话——「造个 JSON 格式化工具」「做个番茄钟」——AI 锻好后会自动上架到这里" />
      )}
      <div className="dlp-tool-grid">
        {tools.map((tool) => {
          if (tool.status === 'forging') {
            return (
              <div key={tool.id} className="dlp-tool-card dlp-tool-forging" aria-busy="true" role="button" tabIndex={-1}>
                <div className="dlp-tool-forging-inner">
                  <span className="dlp-tool-icon" aria-hidden="true">{tool.icon ?? '🛠'}</span>
                  <p className="dlp-tool-title">{tool.title}</p>
                  <p className="dlp-tool-sub">{tool.oneLiner}</p>
                  <div className="dlp-tool-forging-status"><Spinner label="锻造中" /><span>锻造中 · AI 正在编写…</span></div>
                </div>
              </div>
            );
          }
          const failed = tool.status === 'failed';
          const missing = tool.status === 'missing';
          return (
            <div
              key={tool.id}
              role="button" tabIndex={0}
              className={`dlp-tool-card${failed ? ' dlp-tool-failed' : ''}${missing ? ' dlp-tool-missing' : ''}`}
              onClick={() => !failed && !missing && open(tool)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !failed && !missing) open(tool); }}
            >
              <span className="dlp-tool-icon" aria-hidden="true">{tool.icon ?? '🛠'}</span>
              <p className="dlp-tool-title">{tool.title}</p>
              {failed
                ? <p className="dlp-tool-error-text">锻造失败：{tool.error ?? '未知原因'}</p>
                : missing
                  ? <p className="dlp-tool-sub" style={{ color: 'var(--dsw-alias-state-warn-primary)' }}>产物缺失（tools/{tool.id}/ 被删或未完成）</p>
                  : <p className="dlp-tool-sub">{tool.oneLiner || '点击打开工具'}</p>}
              <div className="dlp-tool-foot">
                {failed && <span className="dlp-badge dlp-badge-error">失败</span>}
                {missing && <span className="dlp-badge dlp-badge-warn">产物缺失</span>}
                {tool.status === 'ready' && <span className="dlp-badge dlp-badge-ok">已上架</span>}
                <span style={{ flex: 1 }} />
                {(failed || missing) && (
                  <button type="button" className="dlp-btn dlp-btn-sm" onClick={(event) => { event.stopPropagation(); void retry(tool); }}>
                    ↻ {missing ? '重新生成' : '重试'}
                  </button>
                )}
                <button type="button" className="dlp-icon-btn" style={{ width: 24, height: 24 }} title="删除工具" aria-label="删除工具"
                  onClick={(event) => { event.stopPropagation(); setConfirmDelete(tool); }}>🗑</button>
              </div>
              <p className="dlp-tool-sub" style={{ margin: 0, opacity: .7 }}>{formatTime(tool.updatedAt ?? tool.createdAt)}</p>
            </div>
          );
        })}
      </div>

      {confirmDelete && (
        <Dialog title="删除工具" desc={`确定删除「${confirmDelete.title}」吗？工具目录与其导航卡片会一并移除。`} onClose={() => setConfirmDelete(null)}>
          <div className="dlp-dialog-actions">
            <button type="button" className="dlp-btn" onClick={() => setConfirmDelete(null)}>取消</button>
            <button type="button" className="dlp-btn dlp-btn-danger" disabled={busy} onClick={() => void remove(confirmDelete)}>删除</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
