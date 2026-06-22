import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Desktop design tokens (the "Editorial Ink" theme), imported once ahead of
// every component stylesheet — the single source of truth for colour, type,
// and geometry. Reused verbatim from the desktop app.
import './styles/theme.css';

import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
