// Browser-side content loading. Every JSON under /data is bundled via import.meta.glob and
// looked up by the same manifest paths Node uses, so there is one source of truth.
import type { Content } from '../sim/rules.ts';
import type { BoardUnit } from '../sim/units.ts';
import { loadBoardFile, loadContent, type RawContentFiles } from './loader.ts';
import { CONTENT_MANIFEST, DEV_BOARD_PATHS } from './manifest.ts';

const files = import.meta.glob('../../data/**/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

function rawFile(path: string): unknown {
  const key = `../../data/${path}`;
  if (!(key in files)) throw new Error(`content file ${path} is not bundled (manifest and /data out of sync)`);
  return files[key];
}

export function loadBrowserContent(): Content {
  const raw: Partial<RawContentFiles> = {};
  for (const entry of CONTENT_MANIFEST) raw[entry.kind] = rawFile(entry.path);
  return loadContent(raw as RawContentFiles);
}

export const DEV_BOARD_NAMES: readonly string[] = DEV_BOARD_PATHS.map((p) => p.replace(/^dev\/boards\//, '').replace(/\.json$/, ''));

export function devBoardUnits(name: string, content: Content): BoardUnit[] {
  const path = `dev/boards/${name}.json`;
  if (!DEV_BOARD_PATHS.includes(path)) throw new Error(`unknown dev board ${name}`);
  return loadBoardFile(path, rawFile(path), content);
}
