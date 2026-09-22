const EVENT = 'cubo:cache-clearing';

/** Stop local players before deletion so source fallback cannot refill storage. */
export function announceCacheClear(baseUrl: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: baseUrl }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(EVENT);
    channel.postMessage(baseUrl);
    channel.close();
  }
}

export function onCacheClear(callback: (baseUrl: string) => void): () => void {
  const local = (event: Event) => callback((event as CustomEvent<string>).detail);
  window.addEventListener(EVENT, local);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(EVENT) : null;
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') callback(event.data);
  };
  return () => {
    window.removeEventListener(EVENT, local);
    channel?.close();
  };
}
