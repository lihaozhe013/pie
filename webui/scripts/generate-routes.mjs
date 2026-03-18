import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'server/api';
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry === 'route.ts') files.push(full);
  }
})(root);

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const entries = [];

for (const file of files) {
  const rel = relative(root, file).split('\\').join('/').replace(/\/route\.ts$/, '');
  const segments = rel.split('/').filter(Boolean);
  let url = '/api';
  for (const segment of segments) {
    if (segment.startsWith('[...')) url += '/*';
    else if (segment.startsWith('[')) url += `/:${segment.slice(1, -1)}`;
    else url += `/${segment}`;
  }
  const source = readFileSync(file, 'utf8');
  const found = methods.filter((m) => new RegExp(`export async function ${m}\\(`).test(source));
  const parts = segments.map((segment) =>
    segment.replace(/\[\.\.\.(.+)\]/, '$1').replace(/\[(.+)\]/, 'by-$1')
  );
  const camel = (value) =>
    value
      .split(/[-_]/)
      .filter(Boolean)
      .map((piece, index) =>
        index === 0 ? piece : piece.charAt(0).toUpperCase() + piece.slice(1)
      )
      .join('');
  const alias = parts
    .map((part, index) => (index === 0 ? camel(part) : camel(part).charAt(0).toUpperCase() + camel(part).slice(1)))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
  entries.push({ file, rel, url, methods: found, alias, params: segments.some((s) => s.startsWith('[')) });
}

entries.sort((a, b) => a.url.localeCompare(b.url));

const header = `/**
 * Every HTTP route Pie serves, mapped to the handler that answers it.
 *
 * Routes without a path parameter register first, so a literal segment such as
 * \`/api/sessions/ui-state\` can never be read as \`/api/sessions/:id\`. Each handler keeps the
 * \`(request, context)\` shape (see \`./http.ts\`), which is why the routes stay plain
 * functions that a caller can invoke without a server.
 */
import type { Hono } from 'hono';
import { toHono } from './hono-route';
`;

const imports = entries
  .map((e) => `import * as ${e.alias} from './api/${e.rel}/route';`)
  .join('\n');

const sorted = [...entries].sort((a, b) => {
  if (a.params !== b.params) return a.params ? 1 : -1;
  return a.url.localeCompare(b.url);
});

const body = sorted
  .map((e) => {
    const lines = [`  // server/api/${e.rel}/route.ts`];
    for (const method of e.methods) {
      lines.push(`  app.${method.toLowerCase()}('${e.url}', toHono(${e.alias}.${method}));`);
    }
    return lines.join('\n');
  })
  .join('\n\n');

const output = `${header}\n${imports}\n\nexport function registerApiRoutes(app: Hono): void {\n${body}\n}\n`;
writeFileSync('server/routes.ts', output);
console.log('wrote server/routes.ts with', entries.length, 'modules');
