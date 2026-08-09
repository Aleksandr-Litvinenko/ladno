import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '4173', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT должен быть целым числом от 1 до 65535');
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

const publicFiles = new Set([
  'app.js',
  'index.html',
  'robots.txt',
  'sitemap.xml',
  'styles.css',
  'src/domain.js',
  'src/odata.js',
  'src/seed.js',
  'src/store.js',
]);

function isInsideRoot(pathname) {
  return pathname === root || pathname.startsWith(`${root}${sep}`);
}

async function existingFile(pathname) {
  try {
    let candidate = pathname;
    let details = await stat(candidate);

    if (details.isDirectory()) {
      candidate = resolve(candidate, 'index.html');
      details = await stat(candidate);
    }

    if (!details.isFile()) return null;

    const canonical = await realpath(candidate);
    return isInsideRoot(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

async function resolveRequestPath(requestUrl) {
  const pathname = new URL(requestUrl || '/', 'http://localhost').pathname;
  const decoded = decodeURIComponent(pathname);
  const relative = decoded.replace(/^\/+/, '');
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) return null;
  if (relative && !publicFiles.has(relative)) {
    if (extname(relative)) return null;
    return existingFile(resolve(root, 'index.html'));
  }
  const candidate = resolve(root, relative || 'index.html');

  if (!isInsideRoot(candidate)) return null;

  const direct = await existingFile(candidate);
  if (direct) return direct;

  if (extname(relative)) return null;
  return existingFile(resolve(root, 'index.html'));
}

function writeCommonHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendText(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(message);
}

const server = createServer(async (request, response) => {
  writeCommonHeaders(response);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Метод не поддерживается');
    return;
  }

  let file;
  try {
    file = await resolveRequestPath(request.url);
  } catch {
    sendText(response, 400, 'Некорректный URL');
    return;
  }

  if (!file) {
    sendText(response, 404, 'Файл не найден');
    return;
  }

  const details = await stat(file);
  response.statusCode = 200;
  response.setHeader('Content-Length', details.size);
  response.setHeader('Content-Type', contentTypes.get(extname(file).toLowerCase()) || 'application/octet-stream');

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!response.headersSent) sendText(response, 500, 'Не удалось прочитать файл');
    else response.destroy();
  });
  stream.pipe(response);
});

server.on('error', (error) => {
  console.error(`Не удалось запустить сервер: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Ладно запущено: http://${host}:${port}`);
  console.log('Для остановки нажмите Ctrl+C');
});

function stop() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
