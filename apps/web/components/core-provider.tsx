import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  type CoreLibrarySnapshot,
  type WatchLaterItem,
} from '@cubo/core';
import {
  connectCoreEndpoint,
  currentOriginCoreEndpoint,
  discoverLocalEngine,
  getLibrary,
  PairingRequiredError,
  removeHistoryItem,
  setWatchLater,
  type LocalEngineConnection,
} from '@/lib/local-engine';
import { CoreSettings } from './core-settings';

const STORAGE_KEY = 'cubo.coreEndpoint';

interface CoreContextValue {
  connection: LocalEngineConnection | null;
  /** True once the startup connection attempt has finished (either way). */
  connectionChecked: boolean;
  endpoint: string;
  /** True when this page is served by Cubo Core itself (port 8765). */
  isHosted: boolean;
  library: CoreLibrarySnapshot | null;
  openSettings: () => void;
  /** Resolves a live Core connection, connecting on demand. */
  connect: () => Promise<LocalEngineConnection>;
  refreshLibrary: () => Promise<CoreLibrarySnapshot | null>;
  updateWatchLater: (item: WatchLaterItem, saved: boolean) => Promise<void>;
  removeFromHistory: (key: string) => Promise<void>;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export function useCore(): CoreContextValue {
  const value = useContext(CoreContext);
  if (!value) throw new Error('useCore must be used inside <CoreProvider>');
  return value;
}

export function CoreProvider({ children }: { children: React.ReactNode }) {
  const [connection, setConnection] = useState<LocalEngineConnection | null>(null);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [savedEndpoint, setSavedEndpoint] = useState('');
  const [hostedEndpoint, setHostedEndpoint] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [library, setLibrary] = useState<CoreLibrarySnapshot | null>(null);
  /** A reachable Core that wants a pairing code before it will talk to us. */
  const [pairingEndpoint, setPairingEndpoint] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) ?? '';
    const pageCoreEndpoint = currentOriginCoreEndpoint();

    const surfacePairing = (reason: unknown) => {
      if (reason instanceof PairingRequiredError) {
        setPairingEndpoint(reason.endpoint);
        setSettingsOpen(true);
      }
    };

    if (!pageCoreEndpoint) {
      setSavedEndpoint(stored);
      // Probe for a Core eagerly so playback starts faster and the
      // disconnected banner reflects a real failed attempt, not a guess.
      void discoverLocalEngine(stored)
        .then(setConnection)
        .catch(surfacePairing)
        .finally(() => setConnectionChecked(true));
      return;
    }

    void connectCoreEndpoint(pageCoreEndpoint)
      .then((hosted) => {
        setHostedEndpoint(hosted.baseUrl);
        setConnection(hosted);
      })
      .catch((reason: unknown) => {
        setSavedEndpoint(stored);
        surfacePairing(reason);
      })
      .finally(() => setConnectionChecked(true));
  }, []);

  const connect = useCallback(async () => {
    // Resolve port 8765 from the live page URL at call time. This avoids a
    // mount-effect race where a fast click on a Core-hosted page would probe
    // 127.0.0.1 on the viewing device instead of the Core serving the page.
    const pageCoreEndpoint = currentOriginCoreEndpoint();
    const next = pageCoreEndpoint
      ? await connectCoreEndpoint(pageCoreEndpoint)
      : await discoverLocalEngine(hostedEndpoint || savedEndpoint);
    setConnection(next);
    return next;
  }, [hostedEndpoint, savedEndpoint]);

  const saveCore = useCallback(
    (endpoint: string, next: LocalEngineConnection | null) => {
      setSavedEndpoint(endpoint);
      setConnection(next);
      if (endpoint) window.localStorage.setItem(STORAGE_KEY, endpoint);
      else window.localStorage.removeItem(STORAGE_KEY);
      setSettingsOpen(false);
    },
    [],
  );

  useEffect(() => {
    if (!connection) {
      setLibrary(null);
      return;
    }
    let cancelled = false;
    void getLibrary(connection)
      .then((snapshot) => {
        if (!cancelled) setLibrary(snapshot);
      })
      .catch(() => {
        if (!cancelled) setLibrary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const refreshLibrary = useCallback(async () => {
    try {
      const active = connection ?? (await connect());
      const snapshot = await getLibrary(active);
      setLibrary(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }, [connection, connect]);

  const updateWatchLater = useCallback(
    async (item: WatchLaterItem, saved: boolean) => {
      const active = connection ?? (await connect());
      const snapshot = await setWatchLater(active, item, saved);
      setLibrary(snapshot);
    },
    [connection, connect],
  );

  const removeFromHistory = useCallback(
    async (key: string) => {
      const active = connection ?? (await connect());
      setLibrary(await removeHistoryItem(active, key));
    },
    [connection, connect],
  );

  const value = useMemo<CoreContextValue>(
    () => ({
      connection,
      connectionChecked,
      endpoint: hostedEndpoint || savedEndpoint,
      isHosted: hostedEndpoint !== '',
      library,
      openSettings: () => setSettingsOpen(true),
      connect,
      refreshLibrary,
      updateWatchLater,
      removeFromHistory,
    }),
    [
      connection,
      connectionChecked,
      hostedEndpoint,
      savedEndpoint,
      library,
      connect,
      refreshLibrary,
      updateWatchLater,
      removeFromHistory,
    ],
  );

  return (
    <CoreContext.Provider value={value}>
      {children}
      {settingsOpen ? (
        <CoreSettings
          endpoint={value.endpoint}
          connection={connection}
          currentOriginCore={value.isHosted}
          initialPairingEndpoint={pairingEndpoint}
          onSave={saveCore}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </CoreContext.Provider>
  );
}
