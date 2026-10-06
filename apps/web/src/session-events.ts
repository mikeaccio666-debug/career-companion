import { startBrowserAuthCoordination } from './auth-coordination.ts';
import { subscribeAuthResponseHeaders } from './api.ts';

let coordination: ReturnType<typeof startBrowserAuthCoordination> | null = null;
/** The app entry owns notification ports; importing this module never opens them. */
export function startSessionNotifications(): () => void {
  if (coordination) return () => {};
  const current = startBrowserAuthCoordination();
  const stopAuthResponses = subscribeAuthResponseHeaders(() => current.notifyLocalAuthChanged());
  coordination = current;
  return () => { stopAuthResponses(); current.dispose(); if (coordination === current) coordination = null; };
}
/** Announce a cookie-changing operation; no account identity or credentials are broadcast. */
export function notifySessionChanged(): void { coordination?.notifyLocalAuthChanged(); }
