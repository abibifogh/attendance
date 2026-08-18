import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Every import in the browser code points at something that exists.
 *
 * There is no build step here — that is deliberate, and it costs exactly this.
 * Nothing checks the front end's imports until a browser tries one, and when
 * one is wrong the whole screen is blank with the reason in a console nobody
 * has open. It has happened once, to a constant lost when the repo was split,
 * and the symptom was a manager reporting that Terminals "shows nothing".
 *
 * This is the cheapest possible guard against the same class of thing: walk
 * every module, resolve every path, and check every named import is actually
 * exported by the file it claims to come from.
 */

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

const IMPORTS = /import\s+(?:\{([^}]*)\}|(?:\w+\s*,\s*)?\{([^}]*)\}|\w+)?\s*from\s+'([^']+)'/g;

test('every front-end import resolves to a file that exports it', () => {
  const problems = [];

  for (const file of walk('public/js')) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(IMPORTS)) {
      const specifier = match[3];
      // Only the app's own modules. There are no others — that is the point of
      // having no build step — but a bare specifier would be a bug of its own.
      if (!specifier.startsWith('.')) {
        problems.push(`${file} imports the bare specifier '${specifier}'`);
        continue;
      }

      const target = resolve(dirname(file), specifier);
      if (!existsSync(target)) {
        problems.push(`${file} imports '${specifier}', which does not exist`);
        continue;
      }

      const exported = readFileSync(target, 'utf8');
      const names = (match[1] ?? match[2] ?? '')
        .split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);

      for (const name of names) {
        const declared = new RegExp(
          `export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`
          + `|export\\s*\\{[^}]*\\b${name}\\b`,
        );
        if (!declared.test(exported)) {
          problems.push(`${file} imports { ${name} } from '${specifier}', which does not export it`);
        }
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('no front-end module reaches into the server', () => {
  // The browser bundle and the Worker share nothing. A module that imported
  // across would work in the tests, work in development, and be a file the
  // browser cannot fetch in production.
  for (const file of walk('public/js')) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORTS)) {
      assert.ok(
        !match[3].includes('/src/') && !match[3].startsWith('../../src'),
        `${file} imports ${match[3]} from the server`,
      );
    }
  }
});
