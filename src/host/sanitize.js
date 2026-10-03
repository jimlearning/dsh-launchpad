/**
 * HTML 消毒与转换：纯正则+状态机实现（无 DOM 库），容错优先、绝不抛异常。
 *  - parseHtml：容错微型解析器（处理嵌套/未闭合/注释/实体/rawtext），供本模块与 extract.js 复用
 *  - sanitizeHtml：标签/属性白名单，剔除危险元素与协议
 *  - htmlToMarkdown / htmlToText：阅读模式正文转换
 * 下划线开头的导出为模块内部工具（extract.js / crawl.js 复用），不属于对外契约。
 */

// ---------------------------------------------------------------- 常量表

/** 无内容元素（解析时不入栈、序列化时不输出闭合标签）。 */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** rawtext 元素：内容不解析标签（script 原文保留以便 extract.js 取 JSON-LD）。 */
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** 消毒白名单：命中的标签保留，其余非危险标签解包（保留文本子节点）。 */
const SAFE_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 'b', 'i', 'u', 's',
  'del', 'ins', 'mark', 'br', 'hr', 'figure', 'figcaption', 'sup', 'sub', 'details', 'summary',
  'div', 'span', 'section',
]);

/** 危险元素：连同子树整体剔除（不解包）。 */
const STRIP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'noscript', 'svg', 'canvas', 'video', 'audio', 'source', 'meta', 'link', 'base',
]);

/** 属性白名单：仅这些 标签→属性 组合保留（on 开头事件属性 / srcdoc / style 等天然被排除）。 */
const SAFE_ATTRS = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  ol: new Set(['start']),
};

/** img 的 src 允许 data:image/*（其余 data: 一律剔除）。 */
const SAFE_DATA_IMG = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;

/** 打开标签时隐含闭合的同族标签（容错未闭合的 li/td/p 等）。 */
const IMPLIED_CLOSE = {
  li: ['li'],
  p: ['p'],
  td: ['td', 'th'], th: ['td', 'th'],
  tr: ['tr', 'td', 'th'],
  thead: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  option: ['option'], optgroup: ['option', 'optgroup'],
  dt: ['dt', 'dd'], dd: ['dt', 'dd'],
};

/** 块级标签出现时闭合未闭合的 <p>。 */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'ul',
]);

/** 常见命名实体（数值实体另算，未知实体保留原文）。 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', dagger: '†',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', micro: 'µ',
};

// ---------------------------------------------------------------- 实体与转义

/** 解码 HTML 实体（命名/十进制/十六进制；未知实体原样保留）。 */
export function decodeEntities(text) {
  if (!text || !text.includes('&')) return text ?? '';
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return raw;
      try { return String.fromCodePoint(code); } catch { return raw; }
    }
    return NAMED_ENTITIES[body] ?? raw;
  });
}

const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => escapeText(s).replace(/"/g, '&quot;');

// ---------------------------------------------------------------- 微型解析器

/**
 * 容错解析 HTML 为轻量树：{type:'root'|'element', tag, attrs, children, parent} / {type:'text', text}。
 * 设计目标：任何输入都返回树（绝不抛异常）；script/style/textarea/title 内容按 rawtext 处理。
 */
export function parseHtml(html) {
  const input = String(html ?? '');
  const n = input.length;
  const root = { type: 'root', tag: '', attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = text => {
    if (!text) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last?.type === 'text') last.text += text;
    else parent.children.push({ type: 'text', text, parent });
  };
  /** 闭合栈顶直到 tag（含）；未找到则不动。 */
  const closeTo = tag => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === tag) { stack.length = i; return true; }
    }
    return false;
  };

  let i = 0;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) { pushText(decodeEntities(input.slice(i))); break; }
    if (lt > i) pushText(decodeEntities(input.slice(i, lt)));

    // 注释 <!-- ... -->：直接丢弃
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const ch = input[lt + 1];
    // 声明 / 处理指令 <!doctype> <?xml?>：丢弃
    if (ch === '!' || ch === '?') {
      const end = input.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // 闭合标签 </name ...>
    if (ch === '/') {
      const end = input.indexOf('>', lt + 2);
      const stop = end === -1 ? n : end + 1;
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(input.slice(lt, stop));
      if (m) {
        const tag = m[1].toLowerCase();
        if (!VOID_TAGS.has(tag)) closeTo(tag);
      }
      i = stop;
      continue;
    }
    // 打开标签 <name attrs...>
    const m = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(input.slice(lt, lt + 128));
    if (!m) { pushText('<'); i = lt + 1; continue; } // 孤立 "<" 当文本
    const tag = m[1].toLowerCase();
    let j = lt + m[0].length;
    const attrs = {};
    let selfClosing = false;
    // 属性扫描（容忍引号内 ">"、无引号值、孤立 "/"）
    while (j < n) {
      while (j < n && /\s/.test(input[j])) j++;
      if (j >= n) break;
      if (input[j] === '>') { j++; break; }
      if (input[j] === '/' && input[j + 1] === '>') { selfClosing = true; j += 2; break; }
      if (input[j] === '/') { j++; continue; }
      const am = /^[^\s/>=]+/.exec(input.slice(j));
      if (!am) { j++; continue; }
      const name = am[0].toLowerCase();
      j += am[0].length;
      while (j < n && /\s/.test(input[j])) j++;
      let value = '';
      if (input[j] === '=') {
        j++;
        while (j < n && /\s/.test(input[j])) j++;
        const q = input[j];
        if (q === '"' || q === "'") {
          const end = input.indexOf(q, j + 1);
          if (end === -1) { value = input.slice(j + 1); j = n; }
          else { value = input.slice(j + 1, end); j = end + 1; }
        } else {
          const vm = /^[^\s>]*/.exec(input.slice(j));
          value = vm ? vm[0] : '';
          j += value.length;
        }
      }
      if (!(name in attrs)) attrs[name] = decodeEntities(value);
    }
    i = j;

    // rawtext 元素：吞到对应闭合标签为止
    if (RAWTEXT_TAGS.has(tag) && !selfClosing) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = input.slice(i);
      const cm = closeRe.exec(rest);
      const content = cm ? rest.slice(0, cm.index) : rest;
      const el = { type: 'element', tag, attrs, children: [], parent: top() };
      // script/style 保留原文（JSON-LD 需要）；textarea/title 解实体
      const text = tag === 'script' || tag === 'style' ? content : decodeEntities(content);
      if (text) el.children.push({ type: 'text', text, parent: el });
      top().children.push(el);
      i = cm ? i + cm.index + cm[0].length : n;
      continue;
    }

    // 隐含闭合：li/p/td/tr 等同族标签未闭合时自动补齐（连续弹栈直到不再匹配）
    const implied = IMPLIED_CLOSE[tag];
    if (implied) while (implied.includes(top().tag)) stack.pop();
    if (CLOSES_P.has(tag)) {
      for (let k = stack.length - 1; k > 0; k--) {
        const t = stack[k].tag;
        if (t === 'p') { stack.length = k; break; }
        if (t === 'td' || t === 'th' || t === 'caption' || t === 'button' || t === 'object') break;
      }
    }

    const el = { type: 'element', tag, attrs, children: [], parent: top() };
    top().children.push(el);
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------- 树工具（内部复用）

/** 先序遍历全部元素节点。 */
export function* walkElements(node) {
  for (const child of node.children ?? []) {
    if (child.type === 'element') {
      yield child;
      yield* walkElements(child);
    }
  }
}

/** 块级容器（textOf 补边界空白、Markdown 递归按块处理）。 */
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
  'figure', 'figcaption', 'details', 'summary', 'div', 'section', 'article', 'main',
  'header', 'footer', 'aside', 'nav', 'hr', 'form', 'fieldset', 'dl', 'dt', 'dd',
  'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
]);

/** 收集节点纯文本（跳过 script/style/noscript 子树；块级元素与 br 补 \n 边界）。 */
export function textOf(node, { skipHidden = true } = {}) {
  let out = '';
  const visit = el => {
    if (el.type === 'text') { out += el.text; return; }
    if (skipHidden && (el.tag === 'script' || el.tag === 'style' || el.tag === 'noscript')) return;
    if (el.tag === 'br') { out += '\n'; return; }
    for (const c of el.children) visit(c);
    if (BLOCK_TAGS.has(el.tag)) out += '\n';
  };
  visit(node);
  return out;
}

/** 序列化子树 innerHTML（文本/属性转义；void 元素无闭合标签）。 */
export function serializeChildren(node) {
  let out = '';
  for (const child of node.children ?? []) {
    if (child.type === 'text') { out += escapeText(child.text); continue; }
    const attrs = Object.entries(child.attrs)
      .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
      .join('');
    if (VOID_TAGS.has(child.tag)) { out += `<${child.tag}${attrs}>`; continue; }
    out += `<${child.tag}${attrs}>${serializeChildren(child)}</${child.tag}>`;
  }
  return out;
}

// ---------------------------------------------------------------- sanitizeHtml

/** URL 属性消毒：去空白/控制字符后拦截 javascript:/vbscript:/data:（img 白名单图片 data: 除外）。 */
function sanitizeUrl(tag, value) {
  const compact = String(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) return null;
  if (compact.startsWith('data:')) {
    if (tag === 'img' && SAFE_DATA_IMG.test(compact)) return value;
    return null;
  }
  return value;
}

/**
 * 消毒 HTML：白名单标签保留、非白名单解包、危险元素连子树剔除；
 * 属性仅保留白名单组合，on 开头事件属性、srcdoc、危险协议全部剔除。
 */
export function sanitizeHtml(html) {
  const tree = parseHtml(html);
  const render = node => {
    let out = '';
    for (const child of node.children ?? []) {
      if (child.type === 'text') { out += escapeText(child.text); continue; }
      const tag = child.tag;
      if (STRIP_TAGS.has(tag)) continue;                 // 危险元素：连子树剔除
      if (!SAFE_TAGS.has(tag)) { out += render(child); continue; } // 非白名单：解包
      let attrs = '';
      const allowed = SAFE_ATTRS[tag];
      if (allowed) {
        for (const [name, raw] of Object.entries(child.attrs)) {
          if (!allowed.has(name)) continue;
          let value = raw;
          if (name === 'href' || name === 'src') {
            value = sanitizeUrl(tag, raw);
            if (value === null) continue;
          } else if (name === 'colspan' || name === 'rowspan' || name === 'start') {
            if (!/^\d{1,3}$/.test(raw.trim())) continue; // 数值属性只留纯数字
            value = raw.trim();
          }
          attrs += ` ${name}="${escapeAttr(value)}"`;
        }
      }
      if (VOID_TAGS.has(tag)) { out += `<${tag}${attrs}>`; continue; }
      out += `<${tag}${attrs}>${render(child)}</${tag}>`;
    }
    return out;
  };
  return render(tree);
}

// ---------------------------------------------------------------- htmlToText

/** HTML → 纯文本：去标签（跳过脚本样式子树）、解实体、折叠空白。 */
export function htmlToText(html) {
  const tree = parseHtml(html);
  return textOf(tree).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- htmlToMarkdown

/** 块级容器（递归时按块处理，子节点间需要空行分隔）。 */
/** Markdown 渲染时整体跳过的元素。 */
const MD_SKIP = new Set([...STRIP_TAGS, 'template', 'head']);

/**
 * HTML → Markdown：标题/段落/列表/引用/代码围栏/链接/图片/简单文本表；
 * 折叠 3+ 连续空行为 2。
 */
export function htmlToMarkdown(html) {
  const tree = parseHtml(html);

  /** 单个行内节点渲染（含元素自身的 Markdown 包装）。 */
  const renderInlineNode = (child, ctx) => {
    if (child.type === 'text') return child.text.replace(/\s+/g, ' ');
    const tag = child.tag;
    if (MD_SKIP.has(tag)) return '';
    if (tag === 'br') return '\n';
    if (tag === 'img') {
      const src = child.attrs.src ?? '';
      return src ? `![${(child.attrs.alt ?? '').replace(/[[\]]/g, '')}](${src})` : '';
    }
    const inner = renderInline(child, ctx);
    if (tag === 'a') {
      const href = child.attrs.href ?? '';
      const text = inner.trim();
      return href ? `[${text || href}](${href})` : inner;
    }
    if (tag === 'code' && !ctx.inPre) return `\`${inner.trim()}\``;
    if (tag === 'strong' || tag === 'b') return `**${inner.trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${inner.trim()}*`;
    if (tag === 'del' || tag === 's') return `~~${inner.trim()}~~`;
    if (tag === 'mark') return `==${inner.trim()}==`;
    return inner; // sup/sub/span/u/ins 等行内透传
  };

  /** 行内渲染：子节点依次过 renderInlineNode。 */
  const renderInline = (node, ctx) => {
    let out = '';
    for (const child of node.children ?? []) out += renderInlineNode(child, ctx);
    return out;
  };

  /** pre 原文：不解行内、不折叠空白。 */
  const rawText = node => {
    let out = '';
    for (const child of node.children ?? []) {
      out += child.type === 'text' ? child.text : rawText(child);
    }
    return out;
  };

  /** 块级渲染：连续文本/行内聚合成同一段落，遇块级元素切段落。 */
  const renderBlock = (node, ctx) => {
    let out = '';
    let inlineBuf = '';
    const flush = () => {
      const t = inlineBuf.trim();
      inlineBuf = '';
      if (t) out += `\n\n${t}\n\n`;
    };
    for (const child of node.children ?? []) {
      if (child.type === 'text') { inlineBuf += child.text.replace(/\s+/g, ' '); continue; }
      const tag = child.tag;
      if (MD_SKIP.has(tag)) continue;
      if (BLOCK_TAGS.has(tag)) { flush(); out += renderElement(child, ctx); continue; }
      inlineBuf += renderInlineNode(child, ctx);
    }
    flush();
    return out;
  };

  const renderElement = (el, ctx) => {
    const tag = el.tag;
    if (MD_SKIP.has(tag)) return '';
    if (/^h[1-6]$/.test(tag)) {
      const level = '#'.repeat(Number(tag[1]));
      return `\n\n${level} ${renderInline(el, ctx).trim()}\n\n`;
    }
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'pre') {
      const code = rawText(el).replace(/^\n+/, '').replace(/\s+$/, '');
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    }
    if (tag === 'blockquote') {
      const inner = renderBlock(el, ctx).trim();
      const quoted = inner.split('\n').map(line => (line.trim() ? `> ${line}` : '>')).join('\n');
      return `\n\n${quoted}\n\n`;
    }
    if (tag === 'ul' || tag === 'ol') {
      const start = Number.parseInt(el.attrs.start ?? '', 10);
      let index = Number.isFinite(start) ? start : 1;
      let body = '';
      for (const item of el.children) {
        if (item.type !== 'element' || item.tag !== 'li') continue;
        const marker = tag === 'ul' ? '-' : `${index}.`;
        index += 1;
        const content = renderBlock(item, ctx).trim() || renderInline(item, ctx).trim();
        const indent = ' '.repeat(marker.length + 1);
        const lines = content.split('\n');
        body += `${marker} ${lines[0]}\n`;
        for (const line of lines.slice(1)) body += line.trim() ? `${indent}${line}\n` : '\n';
      }
      return `\n\n${body.replace(/\n+$/, '')}\n\n`;
    }
    if (tag === 'table') {
      const rows = [];
      for (const tr of walkElements(el)) {
        if (tr.tag !== 'tr') continue;
        const cells = [];
        let headerRow = false;
        for (const cell of tr.children) {
          if (cell.type !== 'element' || (cell.tag !== 'td' && cell.tag !== 'th')) continue;
          if (cell.tag === 'th') headerRow = true;
          cells.push(renderInline(cell, ctx).trim().replace(/\|/g, '\\|'));
        }
        if (cells.length) rows.push({ cells, headerRow });
      }
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r => r.cells.length));
      const lines = [];
      rows.forEach((row, ri) => {
        const cells = [...row.cells];
        while (cells.length < width) cells.push('');
        lines.push(`| ${cells.join(' | ')} |`);
        if (row.headerRow && ri === 0) lines.push(`|${' --- |'.repeat(width)}`);
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    // p / li / div / section / figure 等容器
    const block = renderBlock(el, ctx);
    if (block.trim()) return block;
    const inline = renderInline(el, ctx);
    return inline.trim() ? `\n\n${inline.trim()}\n\n` : '';
  };

  const out = renderBlock(tree, { inPre: false });
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
