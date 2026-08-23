import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Regex lookbehind — (?<=…) and (?<!…) — reached iOS Safari only in 16.4, while
// this app's floor is iOS 15.0. Two things make it a uniquely nasty failure:
//
//  - JavaScriptCore compiles a regex literal lazily, so an unsupported literal
//    throws a SyntaxError the first time the enclosing function RUNS, not when
//    the bundle is parsed. The app therefore starts fine and dies later, on
//    whichever screen happens to touch that code.
//  - Nothing else catches it. esbuild cannot rewrite regex features, and with
//    `build.target` naming safari15 it still emits them without so much as a
//    warning (verified). Type-checking and lint see nothing wrong either.
//
// Hence this test. It is a text scan, which is crude, but it is the only layer
// that fails before a device does.
//
// Not covered: lookbehind arriving from a dependency. Scanning the built bundle
// would catch that, but dist/ is not guaranteed to exist when unit tests run.
const LOOKBEHIND = /\(\?<[=!]/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      // Test files are excluded: one of them has to contain the pattern as data
      // in order to check for it, which would otherwise self-trigger.
      acc.push(path);
    }
  }
  return acc;
}

describe('iOS regex support', () => {
  it('uses no regex lookbehind anywhere in src', () => {
    const root = resolve(process.cwd(), 'src');
    expect(existsSync(root)).toBe(true);

    const offenders = sourceFiles(root).filter((f) =>
      LOOKBEHIND.test(readFileSync(f, 'utf8')),
    );

    expect(
      offenders,
      'regex lookbehind is unsupported below iOS Safari 16.4 and throws at ' +
        'first use, not at parse; rewrite without it (lookAHEAD is fine)',
    ).toEqual([]);
  });
});
