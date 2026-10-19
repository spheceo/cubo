import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { tmdbQueries } from './queries';
import {
  chosenServices,
  guessRegion,
  rankServices,
  loadServicePrefs,
  saveServicePrefs,
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
  const update = useCallback((next: ServicePrefs) => setServicePrefs(next), []);
  return {
    region,
    /** Every service TMDB lists anywhere, the viewer's country first. */
    all,
    services: chosenServices(all, prefs.ids),
    picked: prefs.ids != null,
    loading: providers.isLoading,
    error: providers.error,
    update,
  };
}
