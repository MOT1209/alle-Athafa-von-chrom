import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('VideoMind popup: #root missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
