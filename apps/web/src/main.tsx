import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PwaShell } from './PwaStatus';
import { pwaRuntime } from './pwa-runtime';
import './styles.css';
pwaRuntime.start({
  production: import.meta.env.PROD,
  supported: 'serviceWorker' in navigator,
  isOnline: () => navigator.onLine,
  isVisible: () => document.visibilityState === 'visible',
  now: () => Date.now(),
  subscribeConnectivity(change) { window.addEventListener('online', change); window.addEventListener('offline', change); return () => { window.removeEventListener('online', change); window.removeEventListener('offline', change); }; },
  subscribeVisibility(change) { document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); },
  loadRegister: async () => (await import('virtual:pwa-register')).registerSW,
  setTimer: (run, delay) => window.setTimeout(run, delay),
  clearTimer: (timer) => window.clearTimeout(timer as number),
});
createRoot(document.getElementById('root')!).render(<React.StrictMode><PwaShell><App /></PwaShell></React.StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => pwaRuntime.dispose());
