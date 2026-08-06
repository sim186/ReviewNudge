// Copies non-TypeScript runtime assets (SQL schema, admin CSS) into dist/, since
// tsc only emits .js. Kept as a tiny script so the build needs no bundler.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['src/db/schema.sql', 'dist/db/schema.sql'],
  ['src/admin/public', 'dist/admin/public'],
];

for (const [from, to] of assets) {
  const dest = resolve(root, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(resolve(root, from), dest, { recursive: true });
}

console.log(`copied ${assets.length} asset paths into dist/`);
