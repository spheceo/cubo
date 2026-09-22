import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { LatestRequest } from '@/lib/latest-request';
import { CoreSettings } from './core-settings';

const STORAGE_KEY = 'cubo.coreEndpoint';

interface CoreContextValue {
  connection: LocalEngineConnection | null;
  /** True once the startup connection attempt has finished (either way). */
  connectionChecked: boolean;
  endpoint: string;
  /** True when this page is served by Cubo Core itself. */
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
  // Library reads can overlap during player teardown/navigation. Only the
  // newest read may update the UI; otherwise an older snapshot can hide a
  // progress row that a newer request has already created.
  const libraryReadRef = useRef(new LatestRequest());
  // A write must refresh even if another read began while it was in flight,
  // but an old connection must never refresh the newly selected Core.
  const connectionEpochRef = useRef(0);
  const connectionRef = useRef<LocalEngineConnection | null>(null);
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
    // Resolve Core from the live page URL at call time. This avoids a
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
    const epoch = ++connectionEpochRef.current;
    connectionRef.current = connection;
    const read = libraryReadRef.current.begin();
    if (!connection) {
      setLibrary(null);
      return () => {
        libraryReadRef.current.begin();
      };
    }
    void getLibrary(connection)
      .then((snapshot) => {
        if (libraryReadRef.current.isCurrent(read)) setLibrary(snapshot);
      })
      .catch(() => {
        if (libraryReadRef.current.isCurrent(read)) setLibrary(null);
      });
    return () => {
      // Invalidate callbacks from an unmounted/previous connection effect.
      libraryReadRef.current.begin();
      if (connectionRef.current === connection && connectionEpochRef.current === epoch) {
        connectionRef.current = null;
      }
    };
  }, [connection]);

  const refreshLibrary = useCallback(async () => {
    const read = libraryReadRef.current.begin();
    try {
      const expectedEpoch = connectionEpochRef.current;
      const active = connection ?? (await connect());
      const snapshot = await getLibrary(active);
      const sameConnection =
        connectionRef.current === active && connectionEpochRef.current === expectedEpoch;
      if (sameConnection && libraryReadRef.current.isCurrent(read)) setLibrary(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }, [connection, connect]);

  const updateWatchLater = useCallback(
    async (item: WatchLaterItem, saved: boolean) => {
      const mutation = libraryReadRef.current.begin();
      const active = connection ?? (await connect());
      const epoch = connectionEpochRef.current;
      const snapshot = await setWatchLater(active, item, saved);
      if (libraryReadRef.current.isCurrent(mutation)) setLibrary(snapshot);
      // A GET that began after this mutation can have read before the write
      // reached Core. Re-read after the mutation so the final UI is based on
      // server state, regardless of response order.
      if (connectionRef.current === active && connectionEpochRef.current === epoch) {
        void refreshLibrary();
      }
    },
    [connection, connect, refreshLibrary],
  );

  const removeFromHistory = useCallback(
    async (key: string) => {
      const mutation = libraryReadRef.current.begin();
      const active = connection ?? (await connect());
      const epoch = connectionEpochRef.current;
      const snapshot = await removeHistoryItem(active, key);
      if (libraryReadRef.current.isCurrent(mutation)) setLibrary(snapshot);
      if (connectionRef.current === active && connectionEpochRef.current === epoch) {
        void refreshLibrary();
      }
    },
    [connection, connect, refreshLibrary],
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
