import { isCustomKey, type CustomWriterInfo } from './types';

/**
 * The custom writers this process knows (client-safe). The server fills it from the database
 * (src/lib/writers/store.ts → ensureCustomWriters); the dashboard hands the same list to the browser
 * (WritersHydrator), so names, person/general and the category rule are known everywhere without asking again.
 */
let writers: CustomWriterInfo[] = [];
let version = 0;

export function setCustomWriters(list: CustomWriterInfo[]): void {
  writers = list;
  version++;
}

/** Changes whenever the list is replaced (pipelines are registered again when it changes). */
export const customWritersVersion = () => version;

export function customWriter(key: string | null | undefined): CustomWriterInfo | undefined {
  if (!key || !isCustomKey(key)) return undefined;
  return writers.find((w) => w.key === key);
}

/** Every custom writer known (drafts and archived ones too: their articles still run and show their names). */
export const allCustomWriters = (): CustomWriterInfo[] => writers;
export const activeCustomWriters = (): CustomWriterInfo[] => writers.filter((w) => w.status === 'ACTIVE');

export const isActiveCustomWriter = (key: string | null | undefined): boolean => customWriter(key)?.status === 'ACTIVE';

/** A writer about a person (photos of the person, the facts table, family-claim checks). */
export const isPersonCustomWriter = (key: string | null | undefined): boolean => customWriter(key)?.base === 'person';
