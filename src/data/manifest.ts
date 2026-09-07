// Which /data files make up the active content set. Provisional: the dev sample set.
// SPEC intake replaces the dev paths with the real content files.
import type { DataFileKind } from './schemas.ts';

export interface ContentManifestEntry {
  kind: Exclude<DataFileKind, 'boardFile' | 'sandboxSetupFile'>;
  /** Path relative to /data. */
  path: string;
}

export const CONTENT_MANIFEST: readonly ContentManifestEntry[] = [
  { kind: 'board', path: 'board.json' },
  { kind: 'rules', path: 'dev/rules.json' },
  { kind: 'units', path: 'dev/units.json' },
  { kind: 'encounters', path: 'dev/encounters.json' },
  { kind: 'augments', path: 'dev/augments.json' },
];

/** Dev boards selectable on the Title screen's "Dev fight" entry. */
export const DEV_BOARD_PATHS: readonly string[] = ['dev/boards/a.json', 'dev/boards/b.json', 'dev/boards/mirror.json'];

/** Resolve the schema kind for a /data-relative path, or null if the path is not writable content. */
export function kindForPath(path: string): DataFileKind | null {
  const entry = CONTENT_MANIFEST.find((e) => e.path === path);
  if (entry) return entry.kind;
  // Sandbox setups (P0-17) share the boards directory but have a distinct shape (two sides
  // plus fight-rule overrides), so they get their own filename prefix and schema kind. The name
  // is capped well under filesystem name limits (QA on P0-18: an unbounded name reached
  // ENAMETOOLONG and crashed the dev server before that endpoint's write got its own try/catch).
  if (/^dev\/boards\/sandbox-[a-z0-9_-]{1,64}\.json$/.test(path)) return 'sandboxSetupFile';
  if (/^dev\/boards\/[a-z0-9_-]+\.json$/.test(path)) return 'boardFile';
  return null;
}
