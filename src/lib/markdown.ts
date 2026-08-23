/**
 * Lightweight markdown helpers for the meeting summary renderer.
 *
 * No external dependencies — hand-rolled to keep the bundle lean.
 * Supports the subset produced by the Minutist summariser:
 *   - ## and ### headings
 *   - * and - unordered list items
 *   - **text** bold inline spans
 *   - plain paragraphs (all other non-empty lines)
 */

export type MarkdownBlock =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'p'; text: string };

/**
 * Parse a markdown string into a typed block array.
 *
 * Adjacent list items are collapsed into a single `ul` block.
 * Empty lines are ignored (they act as block separators).
 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let pendingListItems: string[] = [];

  function flushList() {
    if (pendingListItems.length > 0) {
      blocks.push({ kind: 'ul', items: pendingListItems });
      pendingListItems = [];
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line === '') {
      // Empty line — flush any open list and move on.
      flushList();
      continue;
    }

    const h2Match = /^##\s+(.+)$/.exec(line);
    if (h2Match) {
      flushList();
      blocks.push({ kind: 'h2', text: h2Match[1].trim() });
      continue;
    }

    const h3Match = /^###\s+(.+)$/.exec(line);
    if (h3Match) {
      flushList();
      blocks.push({ kind: 'h3', text: h3Match[1].trim() });
      continue;
    }

    const listMatch = /^[*-]\s+(.+)$/.exec(line);
    if (listMatch) {
      pendingListItems.push(listMatch[1].trim());
      continue;
    }

    // Plain paragraph line.
    flushList();
    blocks.push({ kind: 'p', text: line.trim() });
  }

  flushList();
  return blocks;
}

/**
 * Strip markdown syntax from `text` and return plain text.
 *
 * Removes heading markers, list bullets, and bold/italic markers.
 * Used to produce snippet text for meeting list rows.
 */
export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // Remove heading markers (##, ###, etc.)
      let s = line.replace(/^#{1,6}\s+/, '');
      // Remove unordered list bullets (* or -)
      s = s.replace(/^[*-]\s+/, '');
      // Remove bold (**text**)
      s = s.replace(/\*\*(.+?)\*\*/g, '$1');
      // Remove italic (*text*). Bold is already gone, so a single asterisk pair
      // is what remains. Written without lookbehind: iOS Safari only gained
      // lookbehind in 16.4, and JavaScriptCore compiles a regex literal lazily,
      // so on an older device it throws at first use rather than at parse —
      // taking out whatever rendered it. `[^*]+` content cannot span an
      // asterisk, which is what the lookbehinds were guarding.
      s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
      return s.trim();
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * Extract a plain-text snippet suitable for a one-to-two line preview.
 *
 * Skips heading lines. Returns the first non-heading, non-empty sentence
 * (or the whole first body line if no sentence boundary is found), stripped
 * of markdown syntax.
 */
export function extractSnippet(text: string): string {
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip heading lines.
    if (/^#{1,6}\s/.test(line)) continue;
    // Strip list bullet and markdown inline syntax.
    let stripped = line.replace(/^[*-]\s+/, '');
    stripped = stripped.replace(/\*\*(.+?)\*\*/g, '$1');
    // Lookbehind-free for the same reason as in stripMarkdown above.
    stripped = stripped.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
    stripped = stripped.trim();
    if (!stripped) continue;
    // Return the first sentence if one exists; otherwise the whole line.
    const sentenceEnd = stripped.search(/[.!?]/);
    if (sentenceEnd !== -1) {
      return stripped.slice(0, sentenceEnd + 1).trim();
    }
    return stripped;
  }
  // Fallback: strip all markdown from the whole text.
  return stripMarkdown(text);
}
