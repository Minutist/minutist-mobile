/**
 * Tests for the markdown helper utilities.
 */

import { describe, it, expect } from 'vitest';
import { parseMarkdownBlocks, stripMarkdown, extractSnippet } from './markdown';

// ---------------------------------------------------------------------------
// parseMarkdownBlocks
// ---------------------------------------------------------------------------

describe('parseMarkdownBlocks', () => {
  it('returns a single paragraph block for plain text', () => {
    const blocks = parseMarkdownBlocks('Hello world');
    expect(blocks).toEqual([{ kind: 'p', text: 'Hello world' }]);
  });

  it('parses ## headings as h2 blocks', () => {
    const blocks = parseMarkdownBlocks('## Summary heading');
    expect(blocks).toEqual([{ kind: 'h2', text: 'Summary heading' }]);
  });

  it('parses ### headings as h3 blocks', () => {
    const blocks = parseMarkdownBlocks('### Sub-heading');
    expect(blocks).toEqual([{ kind: 'h3', text: 'Sub-heading' }]);
  });

  it('parses * list items into a single ul block', () => {
    const blocks = parseMarkdownBlocks('* Item one\n* Item two\n* Item three');
    expect(blocks).toEqual([
      { kind: 'ul', items: ['Item one', 'Item two', 'Item three'] },
    ]);
  });

  it('parses - list items into a single ul block', () => {
    const blocks = parseMarkdownBlocks('- Alpha\n- Beta');
    expect(blocks).toEqual([{ kind: 'ul', items: ['Alpha', 'Beta'] }]);
  });

  it('collapses adjacent list items even across mixed bullet styles', () => {
    const blocks = parseMarkdownBlocks('* Item A\n- Item B');
    expect(blocks).toEqual([{ kind: 'ul', items: ['Item A', 'Item B'] }]);
  });

  it('separates list blocks split by blank lines', () => {
    const blocks = parseMarkdownBlocks('* One\n\n* Two');
    expect(blocks).toEqual([
      { kind: 'ul', items: ['One'] },
      { kind: 'ul', items: ['Two'] },
    ]);
  });

  it('ignores empty lines between non-list blocks', () => {
    const blocks = parseMarkdownBlocks('## Heading\n\nSome paragraph');
    expect(blocks).toEqual([
      { kind: 'h2', text: 'Heading' },
      { kind: 'p', text: 'Some paragraph' },
    ]);
  });

  it('handles a realistic meeting summary with mixed blocks', () => {
    const summary =
      '## Key decisions\n* Relay is deployed\n* iroh-blobs spike next\n\n### Actions\n- Stub sync interface\n- Continue UI work';
    const blocks = parseMarkdownBlocks(summary);
    expect(blocks).toEqual([
      { kind: 'h2', text: 'Key decisions' },
      { kind: 'ul', items: ['Relay is deployed', 'iroh-blobs spike next'] },
      { kind: 'h3', text: 'Actions' },
      { kind: 'ul', items: ['Stub sync interface', 'Continue UI work'] },
    ]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseMarkdownBlocks('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(parseMarkdownBlocks('   \n  \n')).toEqual([]);
  });

  it('handles plain-text summary (no markdown) as a single paragraph', () => {
    const text =
      'Reviewed WS4 milestones. Relay is deployed. iroh-blobs FFI spike is the next critical path item.';
    const blocks = parseMarkdownBlocks(text);
    expect(blocks).toEqual([{ kind: 'p', text: text }]);
  });
});

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe('stripMarkdown', () => {
  it('strips ## heading markers', () => {
    expect(stripMarkdown('## Summary')).toBe('Summary');
  });

  it('strips ### heading markers', () => {
    expect(stripMarkdown('### Details')).toBe('Details');
  });

  it('strips * list bullets', () => {
    expect(stripMarkdown('* First item')).toBe('First item');
  });

  it('strips - list bullets', () => {
    expect(stripMarkdown('- Second item')).toBe('Second item');
  });

  it('strips **bold** markers', () => {
    expect(stripMarkdown('This is **bold** text')).toBe('This is bold text');
  });

  it('strips *italic* markers', () => {
    expect(stripMarkdown('This is *italic* text')).toBe('This is italic text');
  });

  it('joins multiple lines with spaces', () => {
    const result = stripMarkdown('## Heading\n* Item one\n* Item two');
    expect(result).toBe('Heading Item one Item two');
  });

  it('leaves plain text unchanged', () => {
    const text = 'Relay is deployed. Next step is the iroh-blobs spike.';
    expect(stripMarkdown(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// extractSnippet
// ---------------------------------------------------------------------------

describe('extractSnippet', () => {
  it('returns the first sentence of a plain paragraph', () => {
    const text = 'Relay is deployed. Next step is the iroh-blobs spike.';
    expect(extractSnippet(text)).toBe('Relay is deployed.');
  });

  it('skips heading lines and returns the first body sentence', () => {
    const text = '## Key decisions\nRelay is deployed. Next step next.';
    expect(extractSnippet(text)).toBe('Relay is deployed.');
  });

  it('returns the full first body line when there is no sentence boundary', () => {
    const text = '## Heading\nNo sentence end here';
    expect(extractSnippet(text)).toBe('No sentence end here');
  });

  it('strips bold markers from list items before returning', () => {
    const text = '## Actions\n* **Stub** the sync interface now';
    expect(extractSnippet(text)).toBe('Stub the sync interface now');
  });

  it('handles the fixture plain-text summary (no markdown)', () => {
    const text =
      'Reviewed WS4 milestones. Relay is deployed. iroh-blobs FFI spike is the next critical path item; phone audio transfer is blocked on it. Decision: stub the sync interface and continue UI work in parallel.';
    expect(extractSnippet(text)).toBe('Reviewed WS4 milestones.');
  });

  it('returns empty string for empty input', () => {
    expect(extractSnippet('')).toBe('');
  });
});
