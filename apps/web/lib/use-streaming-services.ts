import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { tmdbQueries } from './queries';
import {
  chosenServices,
  guessRegion,
  rankServices,
  loadServicePrefs,
  loadServiceTiles,
  saveServicePrefs,
  saveServiceTiles,
  type ServicePrefs,
} from './streaming-services';

// One copy of the prefs for every mounted reader, so an edit on the home
// row shows on a service page's switcher (and vice versa) at once.
let current: ServicePrefs | null = null;
const listeners = new Set<() => void>();

function read(): ServicePrefs {
  current ??= loadServicePrefs();
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setServicePrefs(prefs: ServicePrefs): void {
  current = prefs;
  saveServicePrefs(prefs);
  for (const listener of listeners) listener();
}

export function useStreamingServices() {
  const prefs = useSyncExternalStore(subscribe, read, read);
  const region = prefs.region ?? guessRegion();
  const providers = useQuery(tmdbQueries.providers());
  const all = useMemo(() => rankServices(providers.data ?? [], region), [providers.data, region]);
  const live = useMemo(() => chosenServices(all, prefs.ids), [all, prefs.ids]);
  // Until the catalog answers, or if it fails, the viewer's services as
  // last loaded stand in, so the row neither flashes nor disappears.
  const [saved] = useState(loadServiceTiles);
  useEffect(() => {
    if (providers.data && live.length) saveServiceTiles(live);
  }, [providers.data, live]);
  const services = providers.data ? live : chosenServices(saved, prefs.ids);
  const update = useCallback((next: ServicePrefs) => setServicePrefs(next), []);
  return {
    region,
    /** Every service TMDB lists anywhere, the viewer's country first. */
    all,
    services,
    picked: prefs.ids != null,
    /** Nothing to show yet, or ever: the row's skeleton and hiding. */
    loading: providers.isLoading && services.length === 0,
    error: services.length ? null : providers.error,
    /** The full list's own state, for picking services. */
    listLoading: providers.isLoading,
    listError: providers.error,
    update,
  };
}
