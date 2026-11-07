import { CANVAS, layerSchema, type ImageTemplate, type Layer, type LayerInput, type PenPoint } from './image-template';

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
export function createLayer(type: NewLayerType, opts: { slot?: number; assetId?: string; svg?: string; circle?: boolean } = {}): Layer {
  const center = (w: number, h: number) => ({ x: (CANVAS.width - w) / 2, y: (CANVAS.height - h) / 2, width: w, height: h });
  const map: Record<NewLayerType, LayerInput> = {
    // A circle photo place: a square box (so the circle is round) with an accent ring.
    photo: opts.circle
      ? { id: newLayerId('photo'), name: `Circle photo ${(opts.slot ?? 0) + 1}`, type: 'photo', slot: opts.slot ?? 0, ...center(720, 720), shape: 'circle', stroke: 'accent', strokeWidth: 18 }
      : { id: newLayerId('photo'), name: `Photo slot ${(opts.slot ?? 0) + 1}`, type: 'photo', slot: opts.slot ?? 0, ...center(960, 1080) },
    'fixed-photo': { id: newLayerId('fixed'), name: 'Fixed photo', type: 'fixed-photo', assetId: opts.assetId ?? '', ...center(640, 360) },
    logo: { id: newLayerId('logo'), name: 'Logo', type: 'logo', ...center(300, 130), plate: true },
    text: { id: newLayerId('text'), name: 'Text', type: 'text', text: '{{title}}', ...center(1400, 220), fontSize: 72, fontWeight: 800, maxLines: 2 },
    rect: { id: newLayerId('rect'), name: 'Rectangle', type: 'rect', ...center(600, 200), fill: 'accent' },
    circle: { id: newLayerId('circle'), name: 'Circle', type: 'circle', ...center(300, 300), fill: 'accent' },
    svg: { id: newLayerId('svg'), name: 'SVG', type: 'svg', ...center(300, 300), svg: opts.svg ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 95,95 5,95" fill="#ffffff"/></svg>' },
    // A triangle to start from; the pen tool draws its own (penLayer).
    path: { id: newLayerId('path'), name: 'Shape', type: 'path', ...center(400, 400), points: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], fill: 'accent' },
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

// ------------------------------------------------------------------ pen tool

/**
 * A pen point on the canvas (owner request: an Illustrator-like pen for custom photo places and shapes): canvas
 * pixels, its curve handles as pixel offsets from it (0, 0 = a corner).
 */
export interface CanvasPoint {
  x: number;
  y: number;
  ix: number;
  iy: number;
  ox: number;
  oy: number;
}

export const cornerPoint = (x: number, y: number): CanvasPoint => ({ x, y, ix: 0, iy: 0, ox: 0, oy: 0 });

type Seg = [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
const segments = (pts: CanvasPoint[], closed: boolean): Seg[] => {
  const out: Seg[] = [];
  const n = closed && pts.length > 2 ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push([{ x: a.x, y: a.y }, { x: a.x + a.ox, y: a.y + a.oy }, { x: b.x + b.ix, y: b.y + b.iy }, { x: b.x, y: b.y }]);
  }
  return out;
};
const bezier = (s: Seg, t: number) => {
  const u = 1 - t;
  return { x: u * u * u * s[0].x + 3 * u * u * t * s[1].x + 3 * u * t * t * s[2].x + t * t * t * s[3].x, y: u * u * u * s[0].y + 3 * u * u * t * s[1].y + 3 * u * t * t * s[2].y + t * t * t * s[3].y };
};

/** The box around the drawn line itself (curves included, sampled), not around its handles. */
export function penBounds(pts: CanvasPoint[], closed: boolean): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of pts) {
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const s of segments(pts, closed)) {
    for (let k = 1; k < 24; k++) {
      const q = bezier(s, k / 24);
      xs.push(q.x);
      ys.push(q.y);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(MIN_SIZE, Math.max(...xs) - x), height: Math.max(MIN_SIZE, Math.max(...ys) - y) };
}

/** Canvas points → a layer's box and its points as fractions of that box (what the template stores). */
export function penGeometry(pts: CanvasPoint[], closed: boolean): Rect & { points: PenPoint[] } {
  const b = penBounds(pts, closed);
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return {
    x: round(b.x),
    y: round(b.y),
    width: round(b.width),
    height: round(b.height),
    points: pts.map((p) => ({ x: r((p.x - b.x) / b.width), y: r((p.y - b.y) / b.height), ix: r(p.ix / b.width), iy: r(p.iy / b.height), ox: r(p.ox / b.width), oy: r(p.oy / b.height) })),
  };
}

/** A layer's stored points on the canvas (for editing them). */
export function canvasPoints(l: { x: number; y: number; width: number; height: number; points?: PenPoint[] }): CanvasPoint[] {
  return (l.points ?? []).map((p) => ({ x: l.x + p.x * l.width, y: l.y + p.y * l.height, ix: p.ix * l.width, iy: p.iy * l.height, ox: p.ox * l.width, oy: p.oy * l.height }));
}

/** A new layer from a finished pen drawing: a shape (filled when closed, a line when open) or a photo place. */
export function penLayer(pts: CanvasPoint[], as: 'shape' | 'photo', opts: { closed: boolean; slot?: number }): Layer {
  const closed = as === 'photo' || opts.closed;
  const g = penGeometry(pts, closed);
  if (as === 'photo') return layerSchema.parse({ id: newLayerId('photo'), name: `Pen photo ${(opts.slot ?? 0) + 1}`, type: 'photo', slot: opts.slot ?? 0, ...g, shape: 'path' });
  return layerSchema.parse({ id: newLayerId('path'), name: closed ? 'Pen shape' : 'Pen line', type: 'path', ...g, closed, fill: closed ? 'accent' : 'transparent', stroke: closed ? null : 'accent', strokeWidth: closed ? 0 : 8 });
}

/** Where a click lands on the drawn line: the segment and the curve position (0–1) nearest to it, within `max` px. */
export function nearestOnPath(pts: CanvasPoint[], closed: boolean, p: { x: number; y: number }, max: number): { index: number; t: number } | null {
  let best: { index: number; t: number; d: number } | null = null;
  segments(pts, closed).forEach((s, index) => {
    for (let k = 0; k <= 40; k++) {
      const q = bezier(s, k / 40);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= max && (!best || d < best.d)) best = { index, t: k / 40, d };
    }
  });
  return best ? { index: (best as { index: number }).index, t: (best as { t: number }).t } : null;
}

/** A point added on segment `index` at `t`, keeping the line's shape (the curve is split, de Casteljau). */
export function insertPoint(pts: CanvasPoint[], closed: boolean, index: number, t: number): CanvasPoint[] {
  const s = segments(pts, closed)[index];
  if (!s) return pts;
  const lerp = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = lerp(s[0], s[1]);
  const b = lerp(s[1], s[2]);
  const c = lerp(s[2], s[3]);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const m = lerp(d, e);
  const next = pts.map((q) => ({ ...q }));
  const i0 = index;
  const i1 = (index + 1) % pts.length;
  const straight = !pts[i0].ox && !pts[i0].oy && !pts[i1].ix && !pts[i1].iy;
  if (!straight) {
    next[i0] = { ...next[i0], ox: a.x - s[0].x, oy: a.y - s[0].y };
    next[i1] = { ...next[i1], ix: c.x - s[3].x, iy: c.y - s[3].y };
  }
  const added: CanvasPoint = straight ? cornerPoint(m.x, m.y) : { x: m.x, y: m.y, ix: d.x - m.x, iy: d.y - m.y, ox: e.x - m.x, oy: e.y - m.y };
  next.splice(index + 1, 0, added);
  return next;
}

/** A corner becomes a smooth point (handles along its neighbours) and a smooth point a corner. */
export function toggleSmooth(pts: CanvasPoint[], closed: boolean, index: number): CanvasPoint[] {
  const p = pts[index];
  const next = pts.map((q) => ({ ...q }));
  if (p.ix || p.iy || p.ox || p.oy) {
    next[index] = cornerPoint(p.x, p.y);
    return next;
  }
  const prev = pts[(index - 1 + pts.length) % pts.length];
  const after = pts[(index + 1) % pts.length];
  const hasPrev = closed || index > 0;
  const hasNext = closed || index < pts.length - 1;
  const from = hasPrev ? prev : p;
  const to = hasNext ? after : p;
  const dx = (to.x - from.x) / 6;
  const dy = (to.y - from.y) / 6;
  next[index] = { x: p.x, y: p.y, ix: -dx, iy: -dy, ox: dx, oy: dy };
  return next;
}
