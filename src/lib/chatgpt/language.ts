import type { Language } from '../domain';

const GERMAN_COUNTRY: Record<string, string> = {
  Germany: 'Deutschland',
  Austria: 'Österreich',
  Switzerland: 'der Schweiz',
  'United Kingdom': 'dem Vereinigten Königreich',
  'United States': 'den USA',
  Deutschland: 'Deutschland',
  Österreich: 'Österreich',
};

/**
 * Explicit language line appended to every TEXT-generation prompt so output
 * follows the site language regardless of earlier chats. Image prompts are
 * exempt (the caller decides).
 */
export function languageInstruction(language: Language | string, country: string): string {
  if (language === 'de') {
    const place = GERMAN_COUNTRY[country] ?? country;
    return `Schreibe vollständig auf Deutsch für Leserinnen und Leser in ${place}.`;
  }
  const place = country === 'United States' || country === 'United Kingdom' ? `the ${country}` : country;
  return `Write in English for readers in ${place}.`;
}

export function languageName(language: Language | string): string {
  return language === 'de' ? 'German' : 'English';
}

export function wikipediaSite(language: Language | string): string {
  return language === 'de' ? 'German Wikipedia (de.wikipedia.org)' : 'English Wikipedia (en.wikipedia.org)';
}
