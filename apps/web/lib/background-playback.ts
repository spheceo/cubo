/**
 * Keep a watch session alive after the viewer leaves the tab.
 *
 * Chrome/Safari freeze timers and often refuse `video.play()` in a hidden
 * document. Arming from the Play click (a user gesture) opens an audio
 * context, and a worker timer keeps torrent/remux polls on schedule so
 * the picture can start — and be heard — in the background.
 */

let context: AudioContext | null = null;
let keepalive: AudioBufferSourceNode | null = null;
let timerWorker: Worker | null = null;

function audioContext(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context || context.state === 'closed') {
    context = new Ctor();
    keepalive = null;
  }
  return context;
}

/** Call from the Play click so a later hidden `video.play()` is allowed. */
export function armWatchSession(): void {
  const ctx = audioContext();
  if (!ctx) return;
  void ctx.resume();
  if (keepalive || ctx.state === 'closed') return;

  // One second of near-silence keeps the graph running without a tone.
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (Math.random() - 0.5) * 0.00002;
  }
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = 0.0004;
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
  keepalive = source;
}

/** Stop the silent graph once the real video is making sound. */
export function releaseWatchKeepalive(): void {
  try {
    keepalive?.stop();
  } catch {
    // already stopped
  }
  keepalive = null;
}

function worker(): Worker {
  if (!timerWorker) {
    const source = `onmessage=e=>{const {id,ms}=e.data;setTimeout(()=>postMessage(id),ms)}`;
    timerWorker = new Worker(
      URL.createObjectURL(new Blob([source], { type: 'application/javascript' })),
    );
  }
  return timerWorker;
}

/** `setTimeout` in a hidden tab is clamped or frozen; worker timers are not. */
export function delayUnthrottled(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const id = Math.random();
    const clock = worker();
    const onMessage = (event: MessageEvent<number>) => {
      if (event.data !== id) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      clock.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
    };
    clock.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
    clock.postMessage({ id, ms });
  });
}

export function isWatchHref(href: string): boolean {
  return href.startsWith('/watch/');
}

/** Play even if the tab is hidden. Retries until the caller cancels. */
export async function playInBackground(
  video: HTMLVideoElement,
  cancelled: () => boolean,
  onResult: (blocked: boolean) => void,
): Promise<void> {
  void audioContext()?.resume();
  while (!cancelled()) {
    try {
      await video.play();
      if (cancelled()) return;
      onResult(false);
      releaseWatchKeepalive();
      return;
    } catch {
      if (cancelled()) return;
      onResult(true);
      try {
        await delayUnthrottled(800);
      } catch {
        return;
      }
    }
  }
}
