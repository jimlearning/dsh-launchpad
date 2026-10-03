/**
 * 选区锚定：text-quote 模式（quote/prefix/suffix），不改 DOM、可回放。
 * 移植自 qiaomu-rss selection.js，限 6000 字（与 LIMITS.selectionChars 对齐）。
 */

/** 捕获 root 内当前选区 → {quote, prefix, suffix}；无有效选区返回 null。 */
export function selectedPassage(root, selection = window.getSelection()) {
  if (!root || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const quote = selection.toString().trim();
  if (!quote || quote.length > 6000) return null;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length;
  const raw = selection.toString();
  return {
    quote,
    prefix: root.textContent.slice(Math.max(0, offset - 40), offset),
    suffix: root.textContent.slice(offset + raw.length, offset + raw.length + 40),
  };
}

/** 当前选区的可视矩形（浮条定位用）；无选区返回 null。 */
export function selectionRect(root, selection = window.getSelection()) {
  if (!root || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}

/** 由锚定信息在 root 中重建 Range（高亮回放用）。 */
export function quoteRange(root, note) {
  const text = root.textContent;
  let start = text.indexOf(note.quote);
  if (start < 0 || !note.quote) return null;
  if (note.prefix) {
    const anchored = text.indexOf(note.prefix + note.quote);
    if (anchored >= 0) start = anchored + note.prefix.length;
  }
  const end = start + note.quote.length;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0, node, begun = false;
  const range = document.createRange();
  while ((node = walker.nextNode())) {
    const next = offset + node.length;
    if (!begun && start < next) { range.setStart(node, start - offset); begun = true; }
    if (begun && end <= next) { range.setEnd(node, end - offset); return range; }
    offset = next;
  }
  return null;
}
