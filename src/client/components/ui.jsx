/**
 * 共用 UI 原语：Toast / Dialog / Switch / Segmented / Spinner / EmptyState / ErrorBar / ItemIcon。
 * 无外部依赖；全部 dlp- 类名，颜色走 --dsw-alias-* 令牌。
 */
import { useEffect, useRef, useState } from 'react';

export function Spinner({ label }) {
  return <span className="dlp-spinner" role="status" aria-label={label ?? '加载中'} />;
}

export function EmptyState({ icon = '🛰', title, desc, children }) {
  return (
    <div className="dlp-empty">
      <div className="dlp-empty-icon" aria-hidden="true">{icon}</div>
      <h3 className="dlp-empty-title">{title}</h3>
      {desc && <p className="dlp-empty-desc">{desc}</p>}
      {children}
    </div>
  );
}

export function ErrorBar({ error, onRetry, onClose }) {
  if (!error) return null;
  return (
    <div className="dlp-error-bar" role="alert">
      <span aria-hidden="true">⚠️</span>
      <p>{error}</p>
      {onRetry && <button type="button" className="dlp-btn dlp-btn-sm" onClick={onRetry}>重试</button>}
      {onClose && <button type="button" className="dlp-icon-btn" aria-label="关闭" onClick={onClose}>✕</button>}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      className="dlp-switch" disabled={disabled}
      onClick={() => onChange?.(!checked)}
    />
  );
}

export function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div className="dlp-seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value} type="button" aria-pressed={value === opt.value}
          title={opt.title} disabled={opt.disabled}
          onClick={() => onChange?.(opt.value)}
        >{opt.label}</button>
      ))}
    </div>
  );
}

export function Dialog({ title, desc, onClose, children, width }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { ref.current?.querySelector?.('input,textarea,select')?.focus?.(); }, []);
  return (
    <div className="dlp-dialog-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="dlp-dialog" role="dialog" aria-label={title} ref={ref} style={width ? { width } : undefined}>
        <div className="dlp-dialog-head">
          <h3>{title}</h3>
          {desc && <p className="dlp-dialog-desc">{desc}</p>}
        </div>
        <div className="dlp-dialog-body">{children}</div>
      </div>
    </div>
  );
}

export function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="dlp-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`dlp-toast dlp-toast-${toast.kind ?? 'info'}`} role="status">
          <span aria-hidden="true">{toast.kind === 'error' ? '⛔' : toast.kind === 'warn' ? '⚠️' : toast.kind === 'ok' ? '✅' : '💬'}</span>
          <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{toast.text}</span>
          {toast.action && <button type="button" onClick={() => { toast.action.onClick?.(); onDismiss(toast.id); }}>{toast.action.label}</button>}
          <button type="button" aria-label="关闭" style={{ color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 }} onClick={() => onDismiss(toast.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

/** 稳定色板：按标题散列取色（字母兜底图标用）。 */
const TILE_HUES = [216, 262, 288, 336, 12, 38, 84, 152, 190];
export function hueOf(text) {
  let h = 0;
  for (let i = 0; i < String(text).length; i++) h = (h * 31 + String(text).charCodeAt(i)) >>> 0;
  return TILE_HUES[h % TILE_HUES.length];
}

/** 条目图标：emoji 原文 / http(s) favicon 图（加载失败自动退字母）/ 字母散色兜底。 */
export function ItemIcon({ icon, title, className = 'dlp-card-icon' }) {
  const [broken, setBroken] = useState(false);
  const isUrl = /^https?:\/\//.test(icon ?? '');
  if (isUrl && !broken) {
    return (
      <span className={className}>
        <img src={icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      </span>
    );
  }
  if (icon && !isUrl) return <span className={className} aria-hidden="true">{icon}</span>;
  return <span className={className}><LetterTile title={title} /></span>;
}

function LetterTile({ title }) {
  const letter = (String(title ?? '?').trim()[0] ?? '?').toUpperCase();
  const hue = hueOf(title);
  return (
    <span className="dlp-card-icon-letter" aria-hidden="true"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${(hue + 40) % 360} 58% 34%))` }}>
      {letter}
    </span>
  );
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url ?? ''; }
}

export function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
