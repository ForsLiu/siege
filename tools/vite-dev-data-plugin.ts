// Dev-server-only data endpoint: POST /__data/<path> validates the body with the matching
// zod schema and writes it to /data/<path>. GET /__data/<path> reads it. apply:'serve'
// guarantees the plugin never participates in `vite build`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { validateFile } from '../src/data/loader.ts';
import { kindForPath } from '../src/data/manifest.ts';

const ENDPOINT_PREFIX = '/__data/';

export function devDataPlugin(): Plugin {
  return {
    name: 'siege-dev-data',
    apply: 'serve',
    configureServer(server) {
      const dataDir = resolve(server.config.root, 'data');
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith(ENDPOINT_PREFIX)) return next();
        const rel = decodeURIComponent(url.slice(ENDPOINT_PREFIX.length).split('?')[0] ?? '');
        const target = normalize(join(dataDir, rel));
        if (!target.startsWith(dataDir + sep) || rel.includes('..')) return reply(res, 400, { ok: false, error: 'invalid path' });
        const kind = kindForPath(rel.replace(/\\/g, '/'));
        if (!kind) return reply(res, 404, { ok: false, error: `not a content file: ${rel}` });
        if (req.method === 'GET') {
          try {
            return reply(res, 200, { ok: true, kind, value: JSON.parse(readFileSync(target, 'utf8')) });
          } catch (e) {
            // Not the absolute server path from a raw fs error (QA on P0-18): this is local-dev
            // only, but the message reaches the browser UI verbatim (e.g. a failed sandbox load).
            const notFound = e instanceof Error && 'code' in e && e.code === 'ENOENT';
            return reply(res, 404, { ok: false, error: notFound ? `no such file: ${rel}` : String(e) });
          }
        }
        if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method not allowed' });
        let body = '';
        req.on('data', (chunk: Buffer | string) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            return reply(res, 400, { ok: false, error: `invalid JSON: ${String(e)}` });
          }
          const result = validateFile(kind, parsed);
          if (!result.ok) return reply(res, 422, { ok: false, error: result.error });
          // A filesystem error here (e.g. ENAMETOOLONG from an over-long saved-setup name) must
          // reply with an error, not throw inside the request callback: an uncaught exception
          // there crashes the whole dev server, taking the rest of the app down with it
          // (QA on P0-18, reproduced with a 250-character sandbox setup name).
          try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
          } catch (e) {
            return reply(res, 500, { ok: false, error: String(e) });
          }
          return reply(res, 200, { ok: true, kind, path: rel });
        });
      });
    },
  };
}

function reply(res: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
