/**
 * Fonts for text layers (owner request: “more good fonts, like Helvetica”). Shared by the template schema, the
 * designer (which loads them with @font-face from /fonts) and the renderer (which draws them as shapes from the same
 * files, so the picture looks the same on every computer, with or without the font installed).
 *
 * The four original choices stay system fonts. The others ship with the app in public/fonts: free fonts (SIL Open
 * Font License, each with its LICENSE.txt) from Fontsource, Latin subset (English and German letters). Helvetica
 * itself is not free to ship; Arimo has the same letter widths as Helvetica and Arial.
 */

export type FontGroup = 'System' | 'Sans serif' | 'Bold display' | 'Serif' | 'Handwriting';

export interface FontChoice {
  id: string;
  label: string;
  group: FontGroup;
  /** Weights that have a file (bundled fonts); the nearest one is used for the others. */
  weights: number[];
  /** CSS font-family for the designer and the renderer's text fallback. */
  css: string;
  bundled: boolean;
}

const bundled = (id: string, label: string, group: FontGroup, weights: number[], fallback = 'sans-serif'): FontChoice => ({
  id,
  label,
  group,
  weights,
  css: `'${label} BAS', ${fallback}`,
  bundled: true,
});

export const FONT_CHOICES: FontChoice[] = [
  { id: 'sans', label: 'Sans (system)', group: 'System', weights: [400, 600, 700, 800], css: "Inter, 'Segoe UI', Arial, Helvetica, sans-serif", bundled: false },
  { id: 'serif', label: 'Serif (system)', group: 'System', weights: [400, 600, 700, 800], css: "Georgia, 'Times New Roman', serif", bundled: false },
  { id: 'condensed', label: 'Condensed (system)', group: 'System', weights: [400, 600, 700, 800], css: "'Arial Narrow', 'Roboto Condensed', Arial, sans-serif", bundled: false },
  { id: 'mono', label: 'Mono (system)', group: 'System', weights: [400, 600, 700, 800], css: "Consolas, 'Courier New', monospace", bundled: false },
  bundled('arimo', 'Arimo', 'Sans serif', [400, 600, 700]),
  bundled('inter', 'Inter', 'Sans serif', [400, 600, 700, 800]),
  bundled('roboto', 'Roboto', 'Sans serif', [400, 600, 700, 800]),
  bundled('open-sans', 'Open Sans', 'Sans serif', [400, 600, 700, 800]),
  bundled('montserrat', 'Montserrat', 'Sans serif', [400, 600, 700, 800]),
  bundled('poppins', 'Poppins', 'Sans serif', [400, 600, 700, 800]),
  bundled('lato', 'Lato', 'Sans serif', [400, 700]),
  bundled('raleway', 'Raleway', 'Sans serif', [400, 600, 700, 800]),
  bundled('nunito', 'Nunito', 'Sans serif', [400, 600, 700, 800]),
  bundled('oswald', 'Oswald', 'Bold display', [400, 600, 700]),
  bundled('bebas-neue', 'Bebas Neue', 'Bold display', [400]),
  bundled('anton', 'Anton', 'Bold display', [400]),
  bundled('archivo-black', 'Archivo Black', 'Bold display', [400]),
  bundled('barlow-condensed', 'Barlow Condensed', 'Bold display', [400, 600, 700, 800]),
  bundled('playfair-display', 'Playfair Display', 'Serif', [400, 600, 700, 800], 'serif'),
  bundled('merriweather', 'Merriweather', 'Serif', [400, 600, 700, 800], 'serif'),
  bundled('lora', 'Lora', 'Serif', [400, 600, 700], 'serif'),
  bundled('dm-serif-display', 'DM Serif Display', 'Serif', [400], 'serif'),
  bundled('dancing-script', 'Dancing Script', 'Handwriting', [400, 600, 700], 'cursive'),
  bundled('pacifico', 'Pacifico', 'Handwriting', [400], 'cursive'),
];

export const FONT_IDS = FONT_CHOICES.map((f) => f.id) as [string, ...string[]];
export const FONT_GROUPS: FontGroup[] = ['System', 'Sans serif', 'Bold display', 'Serif', 'Handwriting'];

export function fontChoice(id: string): FontChoice {
  return FONT_CHOICES.find((f) => f.id === id) ?? FONT_CHOICES[0];
}

/** The weight that has a file: the requested one, else the nearest (a heavier one on a tie). */
export function nearestWeight(choice: FontChoice, weight: number): number {
  return [...choice.weights].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)[0];
}

/** URL of a bundled font file (served from public/fonts). */
export const fontUrl = (id: string, weight: number) => `/fonts/${id}/${id}-${weight}.woff`;

/** @font-face rules for the designer: every bundled weight under the family “<label> BAS”. */
export function fontFaceCss(): string {
  return FONT_CHOICES.filter((f) => f.bundled)
    .flatMap((f) => f.weights.map((w) => `@font-face{font-family:'${f.label} BAS';font-weight:${w};font-style:normal;font-display:swap;src:url(${fontUrl(f.id, w)}) format('woff');}`))
    .join('\n');
}
