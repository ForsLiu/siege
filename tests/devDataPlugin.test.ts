// A filesystem error on the dev data endpoint's write path must reply with an error, not throw
// inside the request callback: an uncaught exception there crashes the whole dev server (QA on
// P0-18, found by saving a sandbox setup with a 250-character name -> ENAMETOOLONG).
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDataPlugin } from '../tools/vite-dev-data-plugin.ts';

interface FakeReq extends EventEmitter {
  method: string;
  url: string;
}

interface FakeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
  done: Promise<void>;
  body: string;
}

function fakeReq(method: string, url: string, body?: string): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.method = method;
  req.url = url;
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function fakeRes(): FakeRes {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return {
    statusCode: 0,
    body: '',
    setHeader() {
      // headers are irrelevant to this test
    },
    end(b: string) {
      this.body = b;
      resolve();
    },
    done,
  };
}

function installHandler(dataDir: string): (req: FakeReq, res: FakeRes, next: () => void) => void {
  let handler: ((req: FakeReq, res: FakeRes, next: () => void) => void) | null = null;
  const configureServer = devDataPlugin().configureServer as (server: unknown) => void;
  configureServer({
    config: { root: dataDir },
    middlewares: { use: (fn: typeof handler) => (handler = fn) },
  });
  if (!handler) throw new Error('devDataPlugin did not register a middleware');
  return handler;
}

describe('dev data endpoint', () => {
  it('a write that throws (ENAMETOOLONG) replies 500 instead of crashing the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-devdata-'));
    try {
      const handler = installHandler(dir);
      // A single path segment over ~255 bytes reliably exceeds NAME_MAX on common filesystems.
      // `dev/boards/<name>.json` (not the `sandbox-` prefix) has no length cap, so this still
      // reaches the write step even with the P0-18 length cap on sandbox setup names.
      const longName = 'a'.repeat(300);
      const req = fakeReq('POST', `/__data/dev/boards/${longName}.json`, JSON.stringify({ units: [] }));
      const res = fakeRes();
      expect(() => handler(req, res, () => undefined)).not.toThrow();
      await res.done;
      expect(res.statusCode).toBe(500);
      const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/ENAMETOOLONG|name too long/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing file on GET reports a plain "no such file" message, not the absolute server path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-devdata-'));
    try {
      const handler = installHandler(dir);
      const req = fakeReq('GET', '/__data/dev/boards/sandbox-never-saved.json');
      const res = fakeRes();
      handler(req, res, () => undefined);
      await res.done;
      expect(res.statusCode).toBe(404);
      const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe('no such file: dev/boards/sandbox-never-saved.json');
      expect(parsed.error).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sandbox setup name over 64 characters is rejected before any write is attempted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-devdata-'));
    try {
      const handler = installHandler(dir);
      const longName = 'a'.repeat(65);
      const req = fakeReq('POST', `/__data/dev/boards/sandbox-${longName}.json`, JSON.stringify({ left: [], right: [], rules: {} }));
      const res = fakeRes();
      handler(req, res, () => undefined);
      await res.done;
      // Falls through to the unbounded `boardFile` pattern, whose schema then rejects the
      // sandbox-shaped body (`left`/`right`/`rules` are not `units`) — either way, no write.
      expect(res.statusCode).toBe(422);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
