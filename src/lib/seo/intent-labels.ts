/** Search intents and their labels (client-safe; see intent.ts). */

export const INTENTS = ['BIOGRAPHY', 'FAMILY_RELATIONSHIP', 'NET_WORTH', 'EXPLAINER', 'COMPARISON', 'HOW_TO'] as const;
export type SearchIntent = (typeof INTENTS)[number];

export const INTENT_LABEL: Record<SearchIntent, string> = {
  BIOGRAPHY: 'Biography',
  FAMILY_RELATIONSHIP: 'Family / relationship',
  NET_WORTH: 'Net worth (estimate)',
  EXPLAINER: 'Explainer',
  COMPARISON: 'Comparison',
  HOW_TO: 'How-to',
};
