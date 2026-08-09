import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const requiredFiles = [
  '.env.example',
  '.github/workflows/ci.yml',
  '.gitignore',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'app.js',
  'deploy/nginx-ladno.product1c.ru.conf',
  'index.html',
  'package.json',
  'robots.txt',
  'scripts/serve.mjs',
  'scripts/validate.mjs',
  'sitemap.xml',
  'styles.css',
];

async function read(relativePath) {
  return readFile(join(root, relativePath), 'utf8');
}

for (const relativePath of requiredFiles) {
  try {
    const details = await stat(join(root, relativePath));
    if (!details.isFile()) errors.push(`${relativePath}: ожидается файл`);
  } catch {
    errors.push(`${relativePath}: файл отсутствует`);
  }
}

try {
  const packageJson = JSON.parse(await read('package.json'));
  if (packageJson.name !== 'ladno') errors.push('package.json: name должен быть ladno');
  if (packageJson.version !== '0.1.0') errors.push('package.json: ожидается версия 0.1.0');
  if (packageJson.type !== 'module') errors.push('package.json: ожидается type=module');

  for (const script of ['test', 'validate', 'serve']) {
    if (!packageJson.scripts?.[script]) errors.push(`package.json: отсутствует script ${script}`);
  }
} catch (error) {
  errors.push(`package.json: не удалось прочитать JSON (${error.message})`);
}

try {
  const html = await read('index.html');
  if (!/<html[^>]+lang=["']ru["']/i.test(html)) errors.push('index.html: ожидается lang="ru"');
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) errors.push('index.html: отсутствует meta viewport');
  if (!/<link[^>]+href=["'][^"']*styles\.css(?:\?[^"']*)?["']/i.test(html)) errors.push('index.html: не подключён styles.css');
  if (!/<script[^>]+src=["'][^"']*app\.js(?:\?[^"']*)?["']/i.test(html)) errors.push('index.html: не подключён app.js');
} catch {
  // Отсутствие файла уже отражено в requiredFiles.
}

try {
  const envExample = await read('.env.example');
  if (/^(?:VITE_|NEXT_PUBLIC_|PUBLIC_)ODATA_/m.test(envExample)) {
    errors.push('.env.example: OData-секреты нельзя объявлять публичными переменными');
  }
  if (!/^ODATA_READ_ONLY=true$/m.test(envExample)) {
    errors.push('.env.example: ODATA_READ_ONLY должен быть true');
  }
  if (!/\.invalid(?:\/|$)/m.test(envExample)) {
    errors.push('.env.example: пример URL должен использовать зарезервированный домен .invalid');
  }

  for (const key of ['ODATA_USERNAME', 'ODATA_PASSWORD']) {
    const value = envExample.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
    if (!value || !['change-me-on-server', 'replace-me-on-server'].includes(value)) {
      errors.push(`.env.example: ${key} должен содержать только безопасный placeholder`);
    }
  }
} catch {
  // Отсутствие файла уже отражено в requiredFiles.
}

try {
  const gitignore = await read('.gitignore');
  if (!/^\.env$/m.test(gitignore)) errors.push('.gitignore: должен исключать .env');
  if (!/^!\.env\.example$/m.test(gitignore)) errors.push('.gitignore: должен оставлять .env.example');
} catch {
  // Отсутствие файла уже отражено в requiredFiles.
}

try {
  const nginx = await read('deploy/nginx-ladno.product1c.ru.conf');
  if (!/server_name\s+ladno\.product1c\.ru\s*;/m.test(nginx)) {
    errors.push('nginx: неверный server_name');
  }
  if (!/root\s+\/var\/www\/ladno\.product1c\.ru\s*;/m.test(nginx)) {
    errors.push('nginx: неверный document root');
  }
  if (/listen\s+443\b/.test(nginx)) {
    errors.push('nginx: origin Jino не должен слушать 443 в этом vhost');
  }
} catch {
  // Отсутствие файла уже отражено в requiredFiles.
}

const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const textExtensions = new Set(['', '.conf', '.css', '.example', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml']);
const secretPatterns = [
  ['приватный ключ', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Bearer token', /Bearer\s+[A-Za-z0-9._~-]{24,}/i],
  ['credentials в URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/i],
];

async function collectTextFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const relativePath = join(prefix, entry.name);
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTextFiles(absolutePath, relativePath));
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(relativePath);
  }
  return files;
}

for (const relativePath of await collectTextFiles(root)) {
  const contents = await read(relativePath);
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(contents)) errors.push(`${relativePath}: обнаружен возможный ${label}`);
  }
}

if (errors.length) {
  console.error('Проверка не пройдена:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Проверка пройдена: ${requiredFiles.length} обязательных файлов, версия 0.1.0, явных секретов нет.`);
}
