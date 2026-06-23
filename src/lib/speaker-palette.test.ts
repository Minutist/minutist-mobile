import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SPEAKER_PALETTE_SIZE } from './speaker-palette';

// Mirrors the desktop Diarization test: the count of distinct --speaker-N
// tokens in theme.css must equal SPEAKER_PALETTE_SIZE, in BOTH the light
// :root block and the dark override, so every speaker slot has a colour in
// each theme.
describe('speaker palette', () => {
  it('keeps SPEAKER_PALETTE_SIZE in sync with the --speaker-N tokens in BOTH themes', () => {
    // vitest runs with cwd == the package root.
    const themePath = resolve(process.cwd(), 'src/styles/theme.css');
    const css = readFileSync(themePath, 'utf8');
    const darkAt = css.indexOf('[data-theme="dark"]');
    expect(darkAt).toBeGreaterThan(0); // both blocks must exist
    const count = (s: string) => (s.match(/--speaker-\d+\s*:/g) ?? []).length;
    expect(count(css.slice(0, darkAt))).toBe(SPEAKER_PALETTE_SIZE);
    expect(count(css.slice(darkAt))).toBe(SPEAKER_PALETTE_SIZE);
  });
});
