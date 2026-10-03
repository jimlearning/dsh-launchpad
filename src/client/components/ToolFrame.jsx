/**
 * ToolFrame：全屏覆盖层 iframe（生成工具 / 卡片预览 / local-tool 扩展产物）。
 * 安全：sandbox="allow-scripts"（不授 same-origin，工具为自包含单文件应用）。
 * bundle：local-tool 扩展传入时，iframe load 后 postMessage({type:'launchpad.bundle', bundle})。
 */
import { useCallback, useRef, useState } from 'react';
import { Spinner } from './ui.jsx';

export function ToolFrame({ title, src, bundle, hint, onClose }) {
  const frameRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const deliver = useCallback(() => {
    setLoading(false);
    if (bundle && frameRef.current?.contentWindow) {
      try { frameRef.current.contentWindow.postMessage({ type: 'launchpad.bundle', bundle }, '*'); } catch { /* 工具未就绪可忽略 */ }
    }
  }, [bundle]);
  return (
    <div className="dlp-frame-mask" role="dialog" aria-label={title}>
      <div className="dlp-frame-bar">
        <strong>{title}</strong>
        {loading && <Spinner label="工具加载中" />}
        {hint && <span className="dlp-frame-hint">{hint}</span>}
        <button type="button" className="dlp-icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>✕</button>
      </div>
      <iframe
        ref={frameRef}
        className="dlp-frame-frame"
        src={src}
        title={title}
        sandbox="allow-scripts"
        onLoad={deliver}
      />
    </div>
  );
}
