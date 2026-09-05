// Dev-only client for the Vite data endpoint (tools/vite-dev-data-plugin.ts).
// Never imported by production code paths: src/app loads src/dev through a DEV-guarded dynamic import.

export const DATA_ENDPOINT = '/__data/';

export interface DataReadResult {
  ok: boolean;
  kind?: string;
  value?: unknown;
  error?: string;
}

export interface DataWriteResult {
  ok: boolean;
  kind?: string;
  path?: string;
  error?: string;
}

export async function readDataFile(path: string): Promise<DataReadResult> {
  const res = await fetch(DATA_ENDPOINT + path, { method: 'GET' });
  return (await res.json()) as DataReadResult;
}

export async function writeDataFile(path: string, value: unknown): Promise<DataWriteResult> {
  const res = await fetch(DATA_ENDPOINT + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return (await res.json()) as DataWriteResult;
}
