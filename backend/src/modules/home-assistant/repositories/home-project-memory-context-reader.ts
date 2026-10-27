import type { HomePlanningProjectFactSnapshot } from '@/modules/home-assistant/domain/home-planning-context';

/** Reads the current selected active project facts for a persisted workspace scope. */
export interface IHomeProjectMemoryContextReader {
  readSelectedFacts(ownerId: string, projectId: string): Promise<readonly HomePlanningProjectFactSnapshot[]>;
}
