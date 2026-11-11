// This device: the service worker (installable app, notifications with the app closed) and its push subscription.
import {api} from './store.ts';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
/** iPhone and iPad only deliver notifications to the app added to the Home Screen. */
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const installed = () => matchMedia('(display-mode: standalone)').matches || (navigator as {standalone?: boolean}).standalone === true;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tapped notification while the app is open: go to the task.
  navigator.serviceWorker.addEventListener('message', e => { if (typeof e.data?.open === 'string') location.href = e.data.open; });
}

/** The install prompt Chrome and Edge offer (iPhone has none: Share, then Add to Home Screen). */
let installPrompt: (Event & {prompt: () => Promise<void>}) | null = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e as typeof installPrompt; });
export const canInstall = () => !!installPrompt;
export async function install() { await installPrompt?.prompt(); installPrompt = null; }

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
export async function deviceOn() { return pushSupported() && Notification.permission === 'granted' && !!(await currentSub()); }

/** Asks for permission (must come from a tap) and registers this device with the server. */
export async function enableDevice(key: string) {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser or phone settings, then try again.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))});
  return api<{devices: number}>('/push/subscribe', {method: 'POST', body: {subscription: sub.toJSON()}});
}
export async function disableDevice() {
  const sub = await currentSub();
  if (!sub) return;
  await api(`/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`, {method: 'DELETE'});
  await sub.unsubscribe();
}
/** The number on the app icon (installed app, where the system supports it). */
export function setBadge(n: number) {
  const nav = navigator as {setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void>};
  (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
}
