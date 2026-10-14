import { CANVAS, layerSchema, type ImageTemplate, type Layer, type LayerInput } from './image-template';

/**
 * Pure editing logic for the Image Template Designer (client-safe, unit
 * tested): snapping, resize/rotate math, layer ordering and an undo/redo
 * history. All coordinates are in the true 1920×1080 canvas.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Guide {
  axis: 'x' | 'y';
  at: number;
}

export const MIN_SIZE = 8;

const edges = (r: Rect) => ({ xs: [r.x, r.x + r.width / 2, r.x + r.width], ys: [r.y, r.y + r.height / 2, r.y + r.height] });

/** Targets a moving layer can snap to: canvas edges/center and the other visible layers' edges/centers. */
export function snapTargets(others: Rect[]): { xs: number[]; ys: number[] } {
  const xs = [0, CANVAS.width / 2, CANVAS.width];
  const ys = [0, CANVAS.height / 2, CANVAS.height];
  for (const o of others) {
    const e = edges(o);
    xs.push(...e.xs);
    ys.push(...e.ys);
  }
  return { xs, ys };
}

function nearest(values: number[], targets: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
  }
  return best;
}

/** Snap a moved rectangle (left/center/right and top/middle/bottom) to the nearest target within the threshold. */
export function snapMove(rect: Rect, others: Rect[], threshold: number): { x: number; y: number; guides: Guide[] } {
  const t = snapTargets(others);
  const e = edges(rect);
  const sx = nearest(e.xs, t.xs, threshold);
  const sy = nearest(e.ys, t.ys, threshold);
  const guides: Guide[] = [];
  if (sx) guides.push({ axis: 'x', at: sx.at });
  if (sy) guides.push({ axis: 'y', at: sy.at });
  return { x: rect.x + (sx?.delta ?? 0), y: rect.y + (sy?.delta ?? 0), guides };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Snap the edges a resize handle moves (unrotated layers only); the opposite edges stay fixed. */
export function snapResize(rect: Rect, handle: Handle, others: Rect[], threshold: number): { rect: Rect; guides: Guide[] } {
  const t = snapTargets(others);
  const guides: Guide[] = [];
  let { x, y, width, height } = rect;
  const pick = (v: number, targets: number[]) => nearest([v], targets, threshold);
  if (handle.includes('e')) {
    const s = pick(x + width, t.xs);
    if (s && width + s.delta >= MIN_SIZE) {
      width += s.delta;
      guides.push({ axis: 'x', at: s.at });
    }
  }
  if (handle.includes('w')) {
    const s = pick(x, t.xs);
    if (s && width - s.delta >= MIN_SIZE) {
      x += s.delta;
      width -= s.delta;
      guides.push({ axis: 'x', at: s.at });
    }
  }
  if (handle.includes('s')) {
    const s = pick(y + height, t.ys);
    if (s && height + s.delta >= MIN_SIZE) {
      height += s.delta;
      guides.push({ axis: 'y', at: s.at });
    }
  }
  if (handle.includes('n')) {
    const s = pick(y, t.ys);
    if (s && height - s.delta >= MIN_SIZE) {
      y += s.delta;
      height -= s.delta;
      guides.push({ axis: 'y', at: s.at });
    }
  }
  return { rect: { x: round(x), y: round(y), width: round(width), height: round(height) }, guides };
}

/**
 * Resize from a handle by a pointer delta (canvas units, already un-rotated
 * into the layer's frame). `keepRatio` preserves the start aspect ratio on
 * corner handles. Width/height never go below MIN_SIZE; the opposite edge
 * stays fixed.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, keepRatio = false): Rect {
  let { x, y, width, height } = start;
  if (handle.includes('e')) width = start.width + dx;
  if (handle.includes('w')) width = start.width - dx;
  if (handle.includes('s')) height = start.height + dy;
  if (handle.includes('n')) height = start.height - dy;
  if (keepRatio && handle.length === 2) {
    const ratio = start.width / start.height;
    if (Math.abs(width - start.width) / start.width > Math.abs(height - start.height) / start.height) height = width / ratio;
    else width = height * ratio;
  }
  width = Math.max(MIN_SIZE, width);
  height = Math.max(MIN_SIZE, height);
  if (handle.includes('w')) x = start.x + start.width - width;
  if (handle.includes('n')) y = start.y + start.height - height;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

/** Rotate a screen delta into a layer's local frame (for resizing rotated layers). */
export function toLocal(dx: number, dy: number, rotationDeg: number): { dx: number; dy: number } {
  const r = (-rotationDeg * Math.PI) / 180;
  return { dx: dx * Math.cos(r) - dy * Math.sin(r), dy: dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * Keep a rotated layer's fixed corner in place after a resize: resizing
 * happens in the local frame, so the center shifts; compensate in canvas space.
 */
export function anchorRotatedResize(start: Rect, next: Rect, rotationDeg: number): Rect {
  if (!rotationDeg) return next;
  const r = (rotationDeg * Math.PI) / 180;
  const c0 = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  const c1 = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
  // Local shift of the center, rotated into canvas space.
  const lx = c1.x - c0.x;
  const ly = c1.y - c0.y;
  const cx = c0.x + lx * Math.cos(r) - ly * Math.sin(r);
  const cy = c0.y + lx * Math.sin(r) + ly * Math.cos(r);
  return { x: round(cx - next.width / 2), y: round(cy - next.height / 2), width: next.width, height: next.height };
}

/** Angle (degrees, -180..180) from the layer center to the pointer; snaps to 15° steps when `step`. */
export function rotationFromPointer(center: { x: number; y: number }, pointer: { x: number; y: number }, step = false): number {
  let deg = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  if (deg > 180) deg -= 360;
  if (step) deg = Math.round(deg / 15) * 15;
  else if (Math.abs(deg % 90) < 3 || Math.abs(deg % 90) > 87) deg = Math.round(deg / 90) * 90;
  return Math.round(deg * 10) / 10 || 0;
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function clampToCanvas(rect: Rect): Rect {
  // Layers may hang off the canvas edges (the renderer clips) but never get lost entirely.
  const x = Math.min(CANVAS.width - MIN_SIZE, Math.max(-rect.width + MIN_SIZE, rect.x));
  const y = Math.min(CANVAS.height - MIN_SIZE, Math.max(-rect.height + MIN_SIZE, rect.y));
  return { ...rect, x: round(x), y: round(y) };
}

// -------------------------------------------------------------- layers

let seq = 0;
export function newLayerId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36).slice(-5)}${seq.toString(36)}`;
}

export type NewLayerType = Layer['type'];

/** Sensible defaults for a new layer, centered on the canvas. */
export function createLayer(type: NewLayerType, opts: { slot?: number; assetId?: string; svg?: string } = {}): Layer {
  const center = (w: number, h: number) => ({ x: (CANVAS.width - w) / 2, y: (CANVAS.height - h) / 2, width: w, height: h });
  const map: Record<NewLayerType, LayerInput> = {
    photo: { id: newLayerId('photo'), name: `Photo slot ${(opts.slot ?? 0) + 1}`, type: 'photo', slot: opts.slot ?? 0, ...center(960, 1080) },
    'fixed-photo': { id: newLayerId('fixed'), name: 'Fixed photo', type: 'fixed-photo', assetId: opts.assetId ?? '', ...center(640, 360) },
    logo: { id: newLayerId('logo'), name: 'Logo', type: 'logo', ...center(300, 130), plate: true },
    text: { id: newLayerId('text'), name: 'Text', type: 'text', text: '{{title}}', ...center(1400, 220), fontSize: 72, fontWeight: 800, maxLines: 2 },
    rect: { id: newLayerId('rect'), name: 'Rectangle', type: 'rect', ...center(600, 200), fill: 'accent' },
    circle: { id: newLayerId('circle'), name: 'Circle', type: 'circle', ...center(300, 300), fill: 'accent' },
    svg: { id: newLayerId('svg'), name: 'SVG', type: 'svg', ...center(300, 300), svg: opts.svg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 95,95 5,95" fill="#ffffff"/></svg>' },
  };
  return layerSchema.parse(map[type]);
}

export function duplicateLayer(layer: Layer): Layer {
  return { ...layer, id: newLayerId(layer.type.replace(/\W/g, '')), name: `${layer.name || layer.type} copy`.slice(0, 60), x: round(layer.x + 40), y: round(layer.y + 40) };
}

/**
 * Change the stacking order. Layers are painted in array order (index 0 at
 * the back); 'up' moves one step toward the front.
 */
export function reorderLayer(layers: Layer[], id: string, move: 'up' | 'down' | 'front' | 'back'): Layer[] {
  const i = layers.findIndex((l) => l.id === id);
  if (i < 0) return layers;
  const next = layers.slice();
  const [layer] = next.splice(i, 1);
  const to = move === 'front' ? next.length : move === 'back' ? 0 : move === 'up' ? Math.min(next.length, i + 1) : Math.max(0, i - 1);
  next.splice(to, 0, layer);
  return next;
}

export function updateLayer(t: ImageTemplate, id: string, patch: Partial<Layer>): ImageTemplate {
  return { ...t, layers: t.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) };
}

// ------------------------------------------------------------- history

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Coalescing key of the last commit (typing in one field becomes one undo step). */
  lastKey: string | null;
  lastAt: number;
}

export const HISTORY_LIMIT = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0 };
}

/** Commit a new state. Commits with the same key within `windowMs` merge into one undo step. */
export function commit<T>(h: History<T>, next: T, key: string | null = null, now = Date.now(), windowMs = 800): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key && key === h.lastKey && now - h.lastAt <= windowMs) return { ...h, present: next, future: [], lastAt: now };
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [], lastKey: key, lastAt: now };
}

/** Replace the present without a new undo step (live drag updates after `commit` of the start state). */
export function replacePresent<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next };
}

/** Finish a live edit (drag): one undo step back to the state before it started. */
export function commitFrom<T>(h: History<T>, before: T): History<T> {
  if (Object.is(before, h.present)) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), present: h.present, future: [], lastKey: null, lastAt: 0 };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastKey: null, lastAt: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastKey: null, lastAt: 0 };
}
