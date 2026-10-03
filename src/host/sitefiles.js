/**
 * 站点目录文件操作：site.json、页面缓存、运行记录、笔记本浏览。
 * 纯 Node。所有写入限制在 sites/<siteId>/ 内，路径经 protocol 白名单校验。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { allowSiteRead, allowSiteWrite, LIMITS, newId } from '../shared/protocol.js';
import { sitePaths } from './fslayout.js';

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, file);
}

export async function ensureSiteDirs(root, siteId) {
  const sp = sitePaths(root, siteId);
  await mkdir(sp.pagesDir, { recursive: true });
  await mkdir(sp.notesDir, { recursive: true });
  await mkdir(sp.digestsDir, { recursive: true });
  await mkdir(sp.cardsDir, { recursive: true });
  await mkdir(sp.runsDir, { recursive: true });
  return sp;
}

export async function readSiteFile(root, siteId) {
  return readJson(sitePaths(root, siteId).siteFile);
}

export async function writeSiteFileJson(root, siteId, site) {
  await writeJson(sitePaths(root, siteId).siteFile, site);
}

// ---- 页面缓存（可重建层） ---------------------------------------------------

export async function readPageCache(root, siteId, pageId) {
  const sp = sitePaths(root, siteId);
  const index = await readJson(sp.cacheIndex, {});
  const entry = index[pageId];
  if (!entry) return null;
  const body = await readJson(join(sp.pagesDir, `${pageId}.json`));
  if (!body) return null;
  return { pageId, ...entry, ...body };
}

export async function writePageCache(root, siteId, pageId, { url, title, meta, html, markdown, liveOk }) {
  const sp = await ensureSiteDirs(root, siteId);
  const index = await readJson(sp.cacheIndex, {});
  index[pageId] = { url, title, meta: meta ?? {}, liveOk: liveOk === true, fetchedAt: new Date().toISOString() };
  await writeJson(sp.cacheIndex, index);
  await writeJson(join(sp.pagesDir, `${pageId}.json`), { html: html ?? '', markdown: markdown ?? '' });
  return index[pageId];
}

export async function listPageCache(root, siteId) {
  const index = await readJson(sitePaths(root, siteId).cacheIndex, {});
  return Object.entries(index).map(([pageId, e]) => ({ pageId, ...e }));
}

// ---- 扩展运行记录 ------------------------------------------------------------

export async function createRun(root, siteId, extId, run) {
  const sp = await ensureSiteDirs(root, siteId);
  const runId = newId('run');
  const dir = join(sp.runsDir, extId);
  await mkdir(dir, { recursive: true });
  const record = { runId, extId, siteId, status: 'running', startedAt: new Date().toISOString(), ...run };
  await writeJson(join(dir, `${runId}.json`), record);
  return record;
}

export async function finishRun(root, siteId, extId, runId, patch) {
  const file = join(sitePaths(root, siteId).runsDir, extId, `${runId}.json`);
  const record = await readJson(file);
  if (!record) return null;
  const next = { ...record, ...patch, doneAt: new Date().toISOString() };
  await writeJson(file, next);
  return next;
}

export async function listRuns(root, siteId, extId = null) {
  const base = join(sitePaths(root, siteId).runsDir);
  const out = [];
  let dirs = [];
  try { dirs = await readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    if (extId && dirent.name !== extId) continue;
    let files = [];
    try { files = await readdir(join(base, dirent.name)); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const record = await readJson(join(base, dirent.name, file));
      if (record) out.push(record);
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// ---- 站点文件读写（notebook 等，白名单防护） ----------------------------------

export async function readSiteRelFile(root, siteId, relPath) {
  if (!allowSiteRead(relPath)) throw new Error('路径不在允许范围');
  const full = join(sitePaths(root, siteId).base, relPath);
  const content = await readFile(full, 'utf8').catch(() => null);
  if (content === null) return null;
  return { relPath, content: content.slice(0, LIMITS.siteFileReadChars), truncated: content.length > LIMITS.siteFileReadChars };
}

export async function writeSiteRelFile(root, siteId, relPath, content) {
  if (!allowSiteWrite(relPath)) throw new Error('只允许写入 notebook/ 下的文件');
  if (typeof content !== 'string' || content.length > LIMITS.noteChars) throw new Error('内容过长');
  const full = join(sitePaths(root, siteId).base, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return { ok: true, relPath };
}

/** 扩展产物写入（host 内部通道，仅供 extension runner 使用）：notebook/ digests/ cards/ 三前缀。
 *  Remote writeSiteFile 与 agent 工具仍走 allowSiteWrite（notebook 限定），本函数不对外暴露。 */
const OUTPUT_ALLOW = /^(notebook\/|digests\/|cards\/)/;
export async function writeSiteOutputFile(root, siteId, relPath, content) {
  if (typeof relPath !== 'string' || relPath.length > 300 || relPath.includes('..')
    || relPath.startsWith('/') || !OUTPUT_ALLOW.test(relPath)) {
    throw new Error(`产物路径只允许 notebook/ digests/ cards/ 前缀，收到: ${relPath}`);
  }
  if (typeof content !== 'string' || content.length > LIMITS.noteChars) throw new Error('内容过长');
  const full = join(sitePaths(root, siteId).base, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return { ok: true, relPath };
}

// ---- 笔记本浏览 --------------------------------------------------------------

async function listDirSafe(dir, suffix = '') {
  try {
    const names = await readdir(dir);
    const out = [];
    for (const name of names) {
      if (suffix && !name.endsWith(suffix)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      out.push({ name, mtime: info?.mtime?.toISOString?.() ?? null, size: info?.size ?? 0 });
    }
    return out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  } catch { return []; }
}

export async function listNotebook(root, siteId) {
  const sp = sitePaths(root, siteId);
  const [notes, digests, cards, pages, highlights, progress, roadmapStat, flashcards] = await Promise.all([
    listDirSafe(sp.notesDir, '.md'),
    listDirSafe(sp.digestsDir),
    listDirSafe(sp.cardsDir),
    listPageCache(root, siteId),
    readJson(sp.highlightsFile, []),
    readJson(sp.progressFile, {}),
    stat(sp.roadmapFile).catch(() => null),
    readJson(sp.flashcardsFile, null),
  ]);
  return {
    notes, digests, cards, pages,
    highlights: Array.isArray(highlights) ? highlights : [],
    progress: progress ?? {},
    hasRoadmap: Boolean(roadmapStat),
    flashcardsCount: Array.isArray(flashcards?.cards) ? flashcards.cards.length : 0,
  };
}
