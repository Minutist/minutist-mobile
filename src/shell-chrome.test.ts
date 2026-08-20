import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The shell chrome — the fixed header, the record row and the tab bar — sits
// outside the scrollers, so it is dragged out of place by a rubber-band
// overscroll that chains from an inner scroller up to the document. The
// stylesheets hold that back with `overscroll-behavior: contain` on each
// scroller, and `env(safe-area-inset-*)` keeps the chrome clear of the notch
// and home indicator.
//
// None of that is reachable from jsdom: it has no layout, no compositor and no
// touch scrolling, so a behavioural test is impossible here and the properties
// are invisible to type-checking and lint. Asserting on the stylesheet text is
// the cheapest guard that survives, in the same spirit as
// src/lib/speaker-palette.test.ts. It is a presence check, not a proof that the
// rules work — real scroll-chaining behaviour needs a device or simulator.
//
// Support matrix behind the `contain` rules, so a future reader does not have
// to re-derive it: Chromium's Android WebView supports the property from 65 and
// WebKit from iOS 16.0. It is ignored on iOS 15.0-15.8, which is the app's
// deployment floor but not its ceiling — the app runs on iOS 16, 17 and 18,
// where the rules apply.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

describe('shell chrome stylesheets', () => {
  it('contains overscroll on every scroller that sits under the fixed chrome', () => {
    const scrollers: Array<[string, string]> = [
      ['src/App.css', '.view-body'],
      ['src/views/CaptureView.css', '.capture-middle'],
    ];

    for (const [file, selector] of scrollers) {
      const css = read(file);
      const start = css.indexOf(`${selector} {`);
      expect(start, `${file} should declare ${selector}`).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('}', start));
      expect(block, `${selector} in ${file} scrolls, so it must contain overscroll`)
        .toMatch(/overscroll-behavior:\s*contain/);
    }
  });

  it('keeps the viewport and the chrome inside the safe area', () => {
    // viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
    // anything other than zero, so the insets below are inert without it.
    expect(read('index.html')).toMatch(/viewport-fit=cover/);

    const app = read('src/App.css');
    expect(app, 'the fixed chrome must offset itself by the safe-area insets')
      .toMatch(/env\(safe-area-inset-/);
  });
});
