import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * index.html asks for every module app.js loads at once (modulepreload), so a
 * phone on a slow line does not fetch them one layer at a time. A module
 * added or removed without the list following it would quietly bring the
 * layers back: this keeps the two the same.
 */
test('index.html preloads exactly the modules app.js loads', () => {
  const root = new URL('../public/', import.meta.url).pathname;
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/^import\s[^'"]*['"](\.[^'"]+)['"]/gm)) walk(resolve(dirname(file), m[1]));
  };
  walk(resolve(root, 'js/app.js'));
  const needed = [...seen].map((f) => `/${relative(root, f)}`).filter((f) => f !== '/js/app.js').sort();
  const listed = [...readFileSync(resolve(root, 'index.html'), 'utf8').matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, needed);
});
