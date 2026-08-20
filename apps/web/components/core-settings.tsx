import { useEffect, useState } from 'react';
import { Link } from '@/components/link';
import {
  connectCoreEndpoint,
  normalizeCoreEndpoint,
  type LocalEngineConnection,
} from '@/lib/local-engine';

export function CoreSettings({
  endpoint,
  connection,
  currentOriginCore = false,
  embeddedCore = false,
  onSave,
  onClose,
}: {
  endpoint: string;
  connection: LocalEngineConnection | null;
  currentOriginCore?: boolean;
  embeddedCore?: boolean;
  onSave: (endpoint: string, connection: LocalEngineConnection | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(endpoint);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function saveRemoteCore() {
    setTesting(true);
    setError(null);
    try {
      const normalized = normalizeCoreEndpoint(draft);
      const nextConnection = await connectCoreEndpoint(normalized);
      onSave(normalized, nextConnection);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not connect to Cubo Core');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-3 backdrop-blur-md sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="core-settings-title"
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-ink shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <p className="mb-1 text-[0.68rem] font-medium uppercase tracking-[0.1em] text-faint">
              Playback
            </p>
            <h2 id="core-settings-title" className="text-base font-medium text-fg">
              {embeddedCore ? 'Built-in Cubo Core' : 'Cubo Core'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-full border border-line px-3 py-1.5 text-xs text-muted transition hover:border-line-strong hover:text-fg"
          >
            Close
          </button>
        </header>

        <div className="space-y-6 p-5">
          <div>
            <label htmlFor="core-endpoint" className="text-sm font-medium text-fg">
              Core address
            </label>
            <p className="mt-1 text-xs leading-relaxed text-faint">
              {currentOriginCore
                ? embeddedCore
                  ? 'The desktop app includes Cubo Core. Playback and your library use it automatically.'
                  : 'This interface is served by Cubo Core, so playback uses this address automatically.'
                : 'Leave this empty to find Cubo Core on this device, or enter a Tailscale address.'}
            </p>
            <input
              id="core-endpoint"
              type="url"
              value={draft}
              disabled={currentOriginCore}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="https://media.your-tailnet.ts.net"
              spellCheck={false}
              autoCapitalize="none"
              className="mt-3 w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-sm text-fg outline-none transition placeholder:text-faint focus:border-line-strong"
            />
            {!currentOriginCore ? (
              <p className="mt-2 text-[0.7rem] leading-relaxed text-faint">
                Direct addresses such as http://100.64.0.10:8765 are also supported.
              </p>
            ) : null}
          </div>

          {connection ? (
            <div className="rounded-xl border border-line bg-surface/60 p-3">
              <div className="flex items-start gap-3">
                <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-fg">
                    {embeddedCore ? 'Built-in Core ready' : 'Core connected'}
                  </p>
                  <p className="mt-1 truncate text-[0.7rem] text-faint">{connection.baseUrl}</p>
                </div>
              </div>
              <Link href="/library" onClick={onClose} className="mt-3 block border-t border-line pt-3 text-xs font-medium text-muted transition hover:text-fg">
                Manage library and storage
              </Link>
            </div>
          ) : null}

          {error ? <p role="alert" className="text-xs leading-relaxed text-red-300">{error}</p> : null}

          {!currentOriginCore ? <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button
              type="button"
              onClick={() => onSave('', null)}
              className="cursor-pointer rounded-full border border-line px-4 py-2.5 text-xs font-medium text-muted transition hover:border-line-strong hover:text-fg"
            >
              Use this device
            </button>
            <button
              type="button"
              disabled={testing || !draft.trim()}
              onClick={() => void saveRemoteCore()}
              className="cursor-pointer rounded-full bg-fg px-5 py-2.5 text-xs font-medium text-ink transition hover:bg-accent disabled:cursor-default disabled:opacity-40"
            >
              {testing ? 'Connecting…' : 'Save and connect'}
            </button>
          </div> : null}
        </div>
      </section>
    </div>
  );
}
