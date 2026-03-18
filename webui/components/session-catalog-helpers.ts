import type { SessionInfo } from '@/lib/types';

export function mergeCatalogRow(current: SessionInfo, refreshed: SessionInfo): SessionInfo {
  return {
    ...current,
    ...refreshed,
    detailsPending: refreshed.detailsPending,
    relation: refreshed.relation
  };
}
