import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('локальный сервер отдаёт только runtime и не раскрывает dotfiles', async (context) => {
  const port = 45_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (child.exitCode == null) child.kill('SIGTERM');
    if (child.exitCode == null) await once(child, 'exit');
  });

  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('Локальный сервер не запустился')), 5_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Локальный сервер завершился с кодом ${code}`));
    });
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('запущено')) return;
      clearTimeout(timeout);
      resolveReady();
    });
  });

  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/src/domain.js')).status, 200);
  assert.equal((await get('/does-not-exist')).status, 200);
  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/.env.example')).status, 404);
  assert.equal((await get('/.git/config')).status, 404);
  assert.equal((await get('/README.md')).status, 404);
});
