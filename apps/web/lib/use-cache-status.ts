import { useQuery } from '@tanstack/react-query';
import { getCacheStatus, type LocalEngineConnection } from './local-engine';

/** One shared, regularly refreshed reading for settings, library and warnings. */
export function useCacheStatus(connection: LocalEngineConnection | null) {
  return useQuery({
    queryKey: ['core-cache', connection?.baseUrl],
    queryFn: () => getCacheStatus(connection!),
    enabled: connection !== null,
    refetchInterval: 5_000,
    staleTime: 1_000,
    retry: 1,
  });
}
