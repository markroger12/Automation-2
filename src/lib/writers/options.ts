import { ACTIVE_MODULE_KEYS, isCelebrityModule, moduleDisplayName, moduleShortName, moduleToWriterType } from '../domain';
import { activeCustomWriters } from './catalog';

/** A writer to choose in a form (client-safe): the built-in writers, then the owner's active writers. */
export interface WriterChoice {
  key: string;
  /** How workflow keywords store it: CELEBRITY / CELEBRITY2 / TIGRAM, or the owner's writer's key. */
  type: string;
  name: string;
  short: string;
  /** About a person (offered for person keywords). */
  person: boolean;
  builtIn: boolean;
}

export function writerChoices(): WriterChoice[] {
  const keys = [...ACTIVE_MODULE_KEYS, ...activeCustomWriters().map((w) => w.key)];
  return keys.map((key) => ({ key, type: moduleToWriterType(key), name: moduleDisplayName(key), short: moduleShortName(key), person: isCelebrityModule(key), builtIn: (ACTIVE_MODULE_KEYS as readonly string[]).includes(key) }));
}

/** Writers offered for a person keyword: Celebrity, Celebrity 2 and the owner's person writers that ask for it. */
export function personWriterChoices(): WriterChoice[] {
  const custom = new Map(activeCustomWriters().map((w) => [w.key, w]));
  return writerChoices().filter((w) => w.person && (w.builtIn || custom.get(w.key)?.config.routing.personKeywords !== false));
}
