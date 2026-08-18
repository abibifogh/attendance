import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Every import in the front end points at something that exists and exports it.
 *
 * There is no build step here, which is most of why this project is pleasant to
 * work on and the one thing it costs. Nothing checks that `import { thing }
 * from './that.js'` will resolve until a browser tries it, and when it fails it
 * fails as a blank screen with a message in a console nobody has open — on
 * whichever screen the typo was on, which may be one an administrator opens
 * twice a year.
 *
 * So the check is done here instead: read every module, follow every relative
 * import, and confirm the file is there and names each thing asked of it.
 */

const ROOTS = ['public/js'];

function modules(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...modules(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** `import { a, b as c } from './x.js'` and `import x from './y.js'`. */
function importsIn(source) {
  const found = [];
  const pattern = /import\s+([^'"]+?)\s+from\s+['"](\.[^'"]+)['"]/g;
  for (const [, clause, from] of source.matchAll(pattern)) {
    const braces = clause.match(/\{([^}]*)\}/);
    const names = braces
      ? braces[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : [];
    const wantsDefault = /^\s*\w+\s*(,|$)/.test(clause);
    found.push({ from, names, wantsDefault });
  }
  return found;
}

/** What a module exports, by name. Good enough for this code, which is plain. */
function exportsOf(source) {
  const names = new Set();
  for (const [, name] of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(name);
  for (const [, name] of source.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(name);
  for (const [, clause] of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of clause.split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] ?? bits[0])?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

test('every relative import in the front end resolves to a file', () => {
  for (const file of ROOTS.flatMap(modules)) {
    const source = readFileSync(file, 'utf8');
    for (const { from } of importsIn(source)) {
      const target = resolve(dirname(file), from);
      assert.ok(existsSync(target), `${file} imports ${from}, which does not exist`);
    }
  }
});

test('every named import is actually exported', () => {
  // The failure this catches is renaming an export and missing one of its five
  // callers: everything still parses, and one screen goes blank.
  const cache = new Map();
  const exportsFor = (path) => {
    if (!cache.has(path)) cache.set(path, exportsOf(readFileSync(path, 'utf8')));
    return cache.get(path);
  };

  for (const file of ROOTS.flatMap(modules)) {
    const source = readFileSync(file, 'utf8');
    for (const { from, names } of importsIn(source)) {
      const target = resolve(dirname(file), from);
      if (!existsSync(target)) continue; // reported by the test above
      const available = exportsFor(target);
      for (const name of names) {
        assert.ok(available.has(name), `${file} imports { ${name} } from ${from}, which does not export it`);
      }
    }
  }
});

test('every screen the router names has a module behind it', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  const rendered = [...app.matchAll(/render:\s*(\w+)/g)].map((m) => m[1]);
  assert.ok(rendered.length > 10, 'the route table was not read properly');

  const imported = new Set([...app.matchAll(/import\s*\{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(',').map((n) => n.trim())));

  for (const name of rendered) {
    assert.ok(imported.has(name), `the route table names ${name}, which app.js never imports`);
  }
});

test('every page in public/ loads a script that exists', () => {
  for (const page of readdirSync('public').filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join('public', page), 'utf8');
    for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      assert.ok(existsSync(join('public', src.replace(/^\//, ''))), `${page} loads ${src}, which is not there`);
    }
  }
});
