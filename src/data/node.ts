// Node-only helpers (tools and tests): read the content set from disk.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Content } from '../sim/rules.ts';
import type { BoardUnit } from '../sim/units.ts';
import { ContentError, loadBoardFile, loadContent, type RawContentFiles } from './loader.ts';
import { CONTENT_MANIFEST } from './manifest.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = join(REPO_ROOT, 'data');

export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ContentError(path, `cannot read file (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new ContentError(path, `invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function readRawContent(dataDir: string = DATA_DIR): RawContentFiles {
  const raw: Partial<RawContentFiles> = {};
  for (const entry of CONTENT_MANIFEST) raw[entry.kind] = readJson(join(dataDir, entry.path));
  return raw as RawContentFiles;
}

let cached: Content | null = null;

/** Load and validate the content set from /data (cached per process). */
export function loadContentFromDisk(dataDir: string = DATA_DIR): Content {
  if (dataDir === DATA_DIR && cached) return cached;
  const content = loadContent(readRawContent(dataDir));
  if (dataDir === DATA_DIR) cached = content;
  return content;
}

export function loadBoardFromDisk(path: string, content: Content): BoardUnit[] {
  const abs = resolve(path);
  return loadBoardFile(abs, readJson(abs), content);
}
