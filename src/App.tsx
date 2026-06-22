/**
 * Placeholder shell. The lean capture surface (record control, quick notes,
 * read-only synced-meeting viewer) is built by the build/test/review loop on
 * top of this baseline; it references the reused design tokens only.
 */
export function App() {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--ink)',
        fontFamily: 'var(--font-text)',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
      }}
    >
      <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--accent)' }}>
        Minutist
      </h1>
    </main>
  );
}
