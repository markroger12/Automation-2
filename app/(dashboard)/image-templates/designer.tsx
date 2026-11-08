'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BringToFront,
  Circle,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileJson,
  ImageIcon,
  ImagePlus,
  LayoutTemplate,
  Lock,
  LockOpen,
  Magnet,
  Maximize,
  PenTool,
  Redo2,
  RefreshCw,
  Save,
  SendToBack,
  Shapes,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { ColorPicker } from '@/components/color-picker';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, cx } from '@/components/ui';
import { api, apiBlob, upload } from '@/lib/client/api';
import { FONT_CHOICES, FONT_GROUPS, fontChoice, fontFaceCss, nearestWeight } from '@/lib/fonts';
import {
  CANVAS,
  importForeignTemplate,
  layerSchema,
  penPathD,
  presetBodyCornerLogo,
  presetSingle,
  presetPhotoCircle,
  presetSplit,
  sanitizeSvg,
  templateSchema,
  templateSet,
  withTemplateSet,
  type EmbeddedPicture,
  type ImageTemplate,
  type Layer,
  type PenPoint,
  type SiteImageSettings,
  type TemplateSet,
  type WriterTemplates,
} from '@/lib/image-template';
import {
  anchorRotatedResize,
  canvasPoints,
  clampToCanvas,
  commit,
  commitFrom,
  cornerPoint,
  createLayer,
  duplicateLayer,
  initHistory,
  insertPoint,
  nearestOnPath,
  newLayerId,
  penGeometry,
  penLayer,
  redo,
  reorderLayer,
  replacePresent,
  resizeRect,
  rotationFromPointer,
  round,
  snapMove,
  snapResize,
  toLocal,
  toggleSmooth,
  undo,
  updateLayer,
  type CanvasPoint,
  type Guide,
  type Handle,
  type History,
  type NewLayerType,
} from '@/lib/template-editor';

type Asset = { id: string; role: string; width: number | null; height: number | null; name: string; origin: string; createdAt: string };
type Data = {
  website: { id: string; name: string; language: string };
  settings: SiteImageSettings;
  activeLogoId: string | null;
  assets: Asset[];
  previewPhotos: Asset[];
  output: { size: string; maxBytes: number };
};
type Which = 'featured' | 'body';

/** The SVG path of pen points in canvas pixels (the pen tool's own lines on the canvas). */
const canvasD = (pts: CanvasPoint[], closed: boolean) => penPathD(pts, closed, 1, 1);
const PEN_HELP = 'Click to add corner points, or click and drag for a curve. Click the first point to close the shape. Enter or a double click finishes; Backspace removes the last point; Esc cancels.';

/** @font-face rules for the bundled fonts (the renderer draws the same files). */
const FONT_FACES = fontFaceCss();
const WEIGHTS: [number, string][] = [
  [400, 'Regular'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
];
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|accent|transparent|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Height of the editor's toolbar, preview controls and hint on wide screens, where the editor stays in view. */
const EDITOR_CHROME = 300;
/** Space around the canvas inside its frame: the 12 px selection handles stick out 6 px past a layer's edge. */
const FRAME_PAD = 8;
const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
const SAMPLE_TITLE = 'How to choose a reliable web host for a growing blog';

const resolve = (c: string | null | undefined, accent: string) => (!c || c === 'transparent' ? 'transparent' : c === 'accent' ? accent : c);
const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function handlePos(h: Handle): CSSProperties {
  const x = h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%';
  const y = h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%';
  return { left: x, top: y, cursor: CURSORS[h] };
}

/** Make layer ids unique and drop references the site does not have (imports). */
/** The embedded picture as a file, cut to Polotno's crop when it has one. */
async function embeddedFile(e: EmbeddedPicture): Promise<File> {
  // Decoded here rather than fetched: the app's content security policy does not allow fetching data: URLs.
  const [head, b64] = e.dataUrl.split(',', 2);
  const bin = atob(b64.replace(/\s+/g, ''));
  const blob = new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: /^data:([^;]+)/.exec(head)?.[1] ?? 'image/png' });
  const name = `${e.name.replace(/[^\w-]+/g, '-').slice(0, 40) || 'picture'}.${blob.type.split('/')[1] ?? 'png'}`;
  if (!e.crop) return new File([blob], name, { type: blob.type });
  const bitmap = await createImageBitmap(blob);
  const sx = Math.round(e.crop.x * bitmap.width);
  const sy = Math.round(e.crop.y * bitmap.height);
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(e.crop.width * bitmap.width)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(e.crop.height * bitmap.height)));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('crop failed'))), 'image/png'));
  return new File([png], name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
}

function normalizeImported(t: ImageTemplate, assetIds: Set<string>, notes: string[]): ImageTemplate {
  const seen = new Set<string>();
  const layers: Layer[] = [];
  for (const l of t.layers) {
    let layer = l;
    if (seen.has(layer.id)) layer = { ...layer, id: newLayerId(layer.type.replace(/\W/g, '')) };
    seen.add(layer.id);
    if (layer.type === 'fixed-photo' && !assetIds.has(layer.assetId)) {
      notes.push(`Fixed photo “${layer.name || layer.id}” refers to an image this website does not have; it became photo slot 1.`);
      layer = { ...layer, type: 'photo', slot: 0, focus: 'auto' } as unknown as Layer;
    }
    if (layer.type === 'svg') {
      const safe = sanitizeSvg(layer.svg);
      if (!safe) {
        notes.push(`SVG “${layer.name || layer.id}” was removed (not a plain inline SVG).`);
        continue;
      }
      layer = { ...layer, svg: safe };
    }
    layers.push(layer);
  }
  return { ...t, layers };
}

export function TemplateDesigner({ sites, initialSiteId }: { sites: { id: string; name: string; active: boolean }[]; initialSiteId: string }) {
  const toast = useToast();
  const [siteId, setSiteId] = useState(initialSiteId);
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hist, setHist] = useState<History<SiteImageSettings> | null>(null);
  const [saved, setSaved] = useState('');
  const [which, setWhich] = useState<Which>('featured');
  // Owner request: a Celebrity and a Tigram image template, each with a featured and a body design.
  const [set, setSet] = useState<TemplateSet>('celebrity');
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [fitScale, setFitScale] = useState(0.4);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [previewTitle, setPreviewTitle] = useState(SAMPLE_TITLE);
  /** The canvas area shows the editor, or the real output of the production renderer at the same size. */
  const [canvasView, setCanvasView] = useState<'edit' | 'output'>('edit');
  const [photoIds, setPhotoIds] = useState<[string, string]>(['', '']);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Asset | null>(null);
  /** Pen tool (owner request: an Illustrator-like pen for custom photo places and shapes); points in canvas pixels. */
  const [pen, setPen] = useState<{ as: 'shape' | 'photo'; points: CanvasPoint[]; hover: { x: number; y: number } | null } | null>(null);
  const penDrag = useRef<number | null>(null);
  const pointDrag = useRef<{ id: string; kind: 'anchor' | 'in' | 'out'; index: number; before: SiteImageSettings; pts: CanvasPoint[]; moved: boolean } | null>(null);
  useEffect(() => setPen(null), [set, which, canvasView, siteId]);

  const load = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const d = await api<Data>(`/api/websites/${id}/image-templates`);
      setData(d);
      setHist(initHistory(d.settings));
      setSaved(JSON.stringify(d.settings));
      setSelected(null);
      setPhotoIds(['', '']);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load(siteId);
  }, [load, siteId]);

  const refreshAssets = useCallback(async () => {
    const d = await api<Data>(`/api/websites/${siteId}/image-templates`);
    setData((old) => (old ? { ...old, assets: d.assets, previewPhotos: d.previewPhotos } : d));
  }, [siteId]);

  const settings = hist?.present ?? null;
  const view = settings ? templateSet(settings, set) : null;
  const template = view ? view[which] : null;
  const dirty = settings ? JSON.stringify(settings) !== saved : false;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---- state changes (all through the history)
  const change = useCallback((fn: (s: SiteImageSettings) => SiteImageSettings, key: string | null = null) => setHist((h) => (h ? commit(h, fn(h.present), key) : h)), []);
  /** Change the templates of the writer being edited (Celebrity or Tigram). */
  const changeSet = useCallback((fn: (v: WriterTemplates) => WriterTemplates, key: string | null = null) => change((s) => withTemplateSet(s, set, fn(templateSet(s, set))), key), [change, set]);
  const changeTemplate = useCallback(
    (fn: (t: ImageTemplate) => ImageTemplate, key: string | null = null) =>
      changeSet((v) => {
        const t = v[which];
        return t ? { ...v, [which]: fn(t) } : v;
      }, key),
    [changeSet, which],
  );
  const patchLayer = useCallback((id: string, patch: Record<string, unknown>, key: string | null = null) => changeTemplate((t) => updateLayer(t, id, patch as Partial<Layer>), key), [changeTemplate]);

  const assetIds = useMemo(() => new Set((data?.assets ?? []).map((a) => a.id)), [data]);
  const logos = (data?.assets ?? []).filter((a) => a.role === 'LOGO');
  const fixedPhotos = (data?.assets ?? []).filter((a) => a.role === 'TEMPLATE_PHOTO');
  const activeLogoId = settings?.logoAssetId && logos.some((l) => l.id === settings.logoAssetId) ? settings.logoAssetId : (logos[0]?.id ?? null);
  const selectedLayer = template?.layers.find((l) => l.id === selected) ?? null;

  // ---- canvas sizing
  const stageRef = useRef<HTMLDivElement>(null);
  // The canvas wrapper mounts and unmounts (e.g. body template off/on): observe whichever one is current.
  const stopObserving = useRef<(() => void) | null>(null);
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    stopObserving.current?.();
    stopObserving.current = null;
    if (!el) return;
    // "Fit" shows the whole canvas, width and height, inside the frame (75vh, padded so edge handles stay inside): no scrollbar.
    const update = () => {
      if (el.clientWidth <= 0) return;
      const width = el.clientWidth - FRAME_PAD * 2;
      const height = (window.matchMedia('(min-width: 1280px)').matches ? Math.max(240, window.innerHeight - EDITOR_CHROME) : window.innerHeight * 0.75) - FRAME_PAD * 2 - 2;
      setFitScale(Math.min(1, Math.max(0.1, Math.min(width / CANVAS.width, height / CANVAS.height))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    stopObserving.current = () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  const scale = zoom === 'fit' ? fitScale : zoom;

  // ---- dragging (move / resize / rotate)
  const drag = useRef<{ kind: 'move' | 'resize' | 'rotate'; id: string; handle?: Handle; before: SiteImageSettings; start: Layer; p0: { x: number; y: number }; moved: boolean } | null>(null);
  const pointer = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  function startDrag(e: ReactPointerEvent, kind: 'move' | 'resize' | 'rotate', layer: Layer, handle?: Handle) {
    e.stopPropagation();
    setSelected(layer.id);
    if (layer.locked || !hist || e.button !== 0) return;
    e.preventDefault();
    stageRef.current?.setPointerCapture(e.pointerId);
    drag.current = { kind, id: layer.id, handle, before: hist.present, start: layer, p0: pointer(e), moved: false };
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d || !template) return;
    const p = pointer(e);
    const dx = p.x - d.p0.x;
    const dy = p.y - d.p0.y;
    if (!d.moved && Math.hypot(dx, dy) * scale < 2) return;
    d.moved = true;
    const others = template.layers.filter((l) => l.id !== d.id && l.visible && !l.rotation);
    const threshold = 6 / scale;
    const useSnap = snap && !e.altKey;
    let patch: Partial<Layer> = {};
    if (d.kind === 'move') {
      let x = d.start.x + dx;
      let y = d.start.y + dy;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) y = d.start.y;
        else x = d.start.x;
      }
      let g: Guide[] = [];
      if (useSnap && !d.start.rotation) {
        const s = snapMove({ x, y, width: d.start.width, height: d.start.height }, others, threshold);
        x = e.shiftKey && Math.abs(dx) <= Math.abs(dy) ? x : s.x;
        y = e.shiftKey && Math.abs(dx) > Math.abs(dy) ? y : s.y;
        g = s.guides;
      }
      setGuides(g);
      const c = clampToCanvas({ x, y, width: d.start.width, height: d.start.height });
      patch = { x: c.x, y: c.y };
    } else if (d.kind === 'resize' && d.handle) {
      const local = toLocal(dx, dy, d.start.rotation);
      const keep = e.shiftKey || d.start.type === 'logo';
      let next = resizeRect(d.start, d.handle, local.dx, local.dy, keep);
      if (useSnap && !d.start.rotation && !keep) {
        const s = snapResize(next, d.handle, others, threshold);
        next = s.rect;
        setGuides(s.guides);
      } else setGuides([]);
      patch = anchorRotatedResize(d.start, next, d.start.rotation);
    } else if (d.kind === 'rotate') {
      patch = { rotation: rotationFromPointer({ x: d.start.x + d.start.width / 2, y: d.start.y + d.start.height / 2 }, p, e.shiftKey) };
    }
    setHist((h) => {
      if (!h) return h;
      const v = templateSet(h.present, set);
      return replacePresent(h, withTemplateSet(h.present, set, { ...v, [which]: updateLayer(v[which]!, d.id, patch) }));
    });
  }
  function endDrag() {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (d?.moved) setHist((h) => (h ? commitFrom(h, d.before) : h));
  }

  // ---- layer actions
  const addLayer = (type: NewLayerType, opts: { slot?: number; assetId?: string; circle?: boolean } = {}) => {
    if (!template) return;
    if (template.layers.length >= 40) return toast('error', 'A template can have at most 40 layers.');
    const layer = createLayer(type, opts);
    changeTemplate((t) => ({ ...t, layers: [...t.layers, layer] }));
    setSelected(layer.id);
  };
  const removeLayer = (id: string) => {
    changeTemplate((t) => ({ ...t, layers: t.layers.filter((l) => l.id !== id) }));
    setSelected(null);
  };
  const duplicate = (id: string) => {
    const l = template?.layers.find((x) => x.id === id);
    if (!l || !template || template.layers.length >= 40) return;
    const copy = duplicateLayer(l);
    changeTemplate((t) => {
      const i = t.layers.findIndex((x) => x.id === id);
      const layers = t.layers.slice();
      layers.splice(i + 1, 0, copy);
      return { ...t, layers };
    });
    setSelected(copy.id);
  };
  const order = (id: string, move: 'up' | 'down' | 'front' | 'back') => changeTemplate((t) => ({ ...t, layers: reorderLayer(t.layers, id, move) }));
  /** A change shown while dragging; the drag's end makes it one undo step. */
  const livePatch = (id: string, patch: Partial<Layer>) =>
    setHist((h) => {
      if (!h) return h;
      const v = templateSet(h.present, set);
      return replacePresent(h, withTemplateSet(h.present, set, { ...v, [which]: updateLayer(v[which]!, id, patch) }));
    });

  // ---- pen tool: draw a new shape or photo place
  const startPen = (as: 'shape' | 'photo') => {
    setSelected(null);
    setCanvasView('edit');
    setPen((p) => (p?.as === as ? null : { as, points: [], hover: null }));
  };
  function finishPen(closeIt: boolean) {
    if (!pen || !template) return;
    // A double click adds its point twice: repeats are dropped.
    const pts = pen.points.filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 2);
    const closed = pen.as === 'photo' || closeIt;
    if (pts.length < (closed ? 3 : 2)) return toast('error', closed ? 'Add at least 3 points for a closed shape.' : 'Add at least 2 points.');
    if (template.layers.length >= 40) return toast('error', 'A template can have at most 40 layers.');
    const layer = penLayer(pts, pen.as, { closed, slot: template.layers.some((l) => l.type === 'photo' && l.slot === 0) ? 1 : 0 });
    changeTemplate((t) => ({ ...t, layers: [...t.layers, layer] }));
    setSelected(layer.id);
    setPen(null);
  }
  function penDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (!pen || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = pointer(e);
    const first = pen.points[0];
    if (first && pen.points.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) * scale <= 10) return finishPen(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    penDrag.current = pen.points.length;
    setPen({ ...pen, points: [...pen.points, cornerPoint(round(p.x), round(p.y))] });
  }
  function penMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!pen) return;
    e.stopPropagation();
    const p = pointer(e);
    const i = penDrag.current;
    if (i === null || !pen.points[i]) return setPen({ ...pen, hover: p });
    const a = pen.points[i];
    const ox = p.x - a.x;
    const oy = p.y - a.y;
    if (Math.hypot(ox, oy) * scale < 3) return;
    // Dragging pulls out the point's curve handles, mirrored, as in Illustrator.
    const points = pen.points.slice();
    points[i] = { ...a, ox: round(ox), oy: round(oy), ix: round(-ox), iy: round(-oy) };
    setPen({ ...pen, points, hover: null });
  }

  // ---- pen tool: edit the points of the selected pen shape or pen photo place
  const editable =
    selectedLayer && !pen && !selectedLayer.locked && !selectedLayer.rotation && selectedLayer.visible && (selectedLayer.type === 'path' || ((selectedLayer.type === 'photo' || selectedLayer.type === 'fixed-photo') && selectedLayer.shape === 'path' && selectedLayer.points?.length)) ? selectedLayer : null;
  const closedOf = (l: Layer) => (l.type === 'path' ? l.closed : true);
  function pointDown(e: ReactPointerEvent<SVGElement>, kind: 'anchor' | 'in' | 'out', index: number) {
    if (!editable || !hist || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const pts = canvasPoints(editable);
    const closed = closedOf(editable);
    if (kind === 'anchor' && e.altKey) {
      if (pts.length <= (closed ? 3 : 2)) return toast('error', `This shape needs at least ${closed ? 3 : 2} points.`);
      pts.splice(index, 1);
      return patchLayer(editable.id, { ...penGeometry(pts, closed) });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointDrag.current = { id: editable.id, kind, index, before: hist.present, pts, moved: false };
  }
  function pointMove(e: ReactPointerEvent<SVGSVGElement>) {
    const d = pointDrag.current;
    if (!d || !editable) return;
    e.stopPropagation();
    const p = pointer(e);
    const pts = d.pts.map((q) => ({ ...q }));
    const a = pts[d.index];
    if (d.kind === 'anchor') pts[d.index] = { ...a, x: round(p.x), y: round(p.y) };
    else {
      const hx = round(p.x - a.x);
      const hy = round(p.y - a.y);
      // Alt: this handle alone (a sharp turn); otherwise the opposite handle mirrors it.
      pts[d.index] = d.kind === 'out' ? { ...a, ox: hx, oy: hy, ...(e.altKey ? {} : { ix: -hx, iy: -hy }) } : { ...a, ix: hx, iy: hy, ...(e.altKey ? {} : { ox: -hx, oy: -hy }) };
    }
    d.moved = true;
    livePatch(d.id, penGeometry(pts, closedOf(editable)));
  }
  function pointUp() {
    const d = pointDrag.current;
    pointDrag.current = null;
    if (d?.moved) setHist((h) => (h ? commitFrom(h, d.before) : h));
  }
  function addPointAt(e: ReactMouseEvent<SVGPathElement>) {
    if (!editable) return;
    e.stopPropagation();
    const pts = canvasPoints(editable);
    const closed = closedOf(editable);
    const hit = nearestOnPath(pts, closed, pointer(e), 14 / scale);
    if (hit) patchLayer(editable.id, { ...penGeometry(insertPoint(pts, closed, hit.index, hit.t), closed) });
  }

  // ---- keyboard: nudge, delete, undo/redo, duplicate
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, [contenteditable="true"]') || el.closest('dialog[open], [role="dialog"]'))) return;
      const mod = e.ctrlKey || e.metaKey;
      if (pen) {
        if (e.key === 'Escape') setPen(null);
        else if (e.key === 'Enter') finishPen(pen.as === 'photo' || pen.points.length >= 3);
        else if (e.key === 'Backspace' || e.key === 'Delete' || (mod && e.key.toLowerCase() === 'z')) setPen({ ...pen, points: pen.points.slice(0, -1) });
        else return;
        e.preventDefault();
        return;
      }
      if (!mod && !e.altKey && e.key.toLowerCase() === 'p' && template) {
        e.preventDefault();
        startPen('shape');
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setHist((h) => (h ? (e.shiftKey ? redo(h) : undo(h)) : h));
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        setHist((h) => (h ? redo(h) : h));
        return;
      }
      if (!selectedLayer) return;
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicate(selectedLayer.id);
        return;
      }
      if (e.key === 'Escape') return setSelected(null);
      if ((e.key === 'Delete' || e.key === 'Backspace') && !selectedLayer.locked) {
        e.preventDefault();
        removeLayer(selectedLayer.id);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const m = moves[e.key];
      if (m && !selectedLayer.locked) {
        e.preventDefault();
        patchLayer(selectedLayer.id, { x: round(selectedLayer.x + m[0]), y: round(selectedLayer.y + m[1]) }, `nudge:${selectedLayer.id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- live preview through the production renderer (debounced)
  const [preview, setPreview] = useState<{ url: string; busy: boolean; error: string | null }>({ url: '', busy: false, error: null });
  const [finalInfo, setFinalInfo] = useState<{ url: string; text: string; over: boolean } | null>(null);
  const previewKey = settings ? JSON.stringify([set, which, template, previewTitle, photoIds, activeLogoId]) : '';
  useEffect(() => {
    if (!settings) return;
    const ctrl = new AbortController();
    setPreview((p) => ({ ...p, busy: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const { blob } = await apiBlob(`/api/websites/${siteId}/image-templates/preview`, { template, kind: which, title: previewTitle, photoAssetIds: photoIds.filter(Boolean), logoAssetId: activeLogoId }, ctrl.signal);
        const url = URL.createObjectURL(blob);
        setPreview((p) => {
          if (p.url) URL.revokeObjectURL(p.url);
          return { url, busy: false, error: null };
        });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setPreview((p) => ({ ...p, busy: false, error: (e as Error).message }));
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, siteId]);
  useEffect(() => setFinalInfo(null), [previewKey]);

  async function finalRender() {
    try {
      const { blob, headers } = await apiBlob(`/api/websites/${siteId}/image-templates/preview`, { template, kind: which, title: previewTitle, photoAssetIds: photoIds.filter(Boolean), logoAssetId: activeLogoId, final: true });
      const bytes = Number(headers.get('X-Image-Bytes'));
      const budget = Number(headers.get('X-Image-Budget'));
      const q = headers.get('X-Image-Quality');
      const type = blob.type === 'image/jpeg' ? 'JPEG' : 'WebP';
      setFinalInfo((old) => {
        if (old?.url) URL.revokeObjectURL(old.url);
        return { url: URL.createObjectURL(blob), text: `${headers.get('X-Image-Width')}×${headers.get('X-Image-Height')} · ${type}${q ? ` quality ${q}` : ''} · ${(bytes / 1024).toFixed(0)} KB of ${(budget / 1024).toFixed(0)} KB budget`, over: bytes > budget };
      });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await api<{ settings: SiteImageSettings }>(`/api/websites/${siteId}/image-templates`, { method: 'PUT', body: { settings } });
      setHist((h) => (h ? replacePresent(h, res.settings) : h));
      setSaved(JSON.stringify(res.settings));
      toast('success', 'Templates saved. New image runs for this website use them.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadAsset(role: 'LOGO' | 'TEMPLATE_PHOTO', file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.set('role', role);
    form.set('file', file);
    try {
      const res = await upload<{ asset: { id: string } }>(`/api/websites/${siteId}/image-assets`, form);
      await refreshAssets();
      if (role === 'LOGO') change((s) => ({ ...s, logoAssetId: res.asset.id }));
      else if (template) addLayer('fixed-photo', { assetId: res.asset.id });
      toast('success', role === 'LOGO' ? 'Logo uploaded and selected (save to keep it).' : 'Photo uploaded and added to the canvas.');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  /** Pictures embedded in an imported design go to this site's template library; the layers then point at them. */
  async function storeEmbeddedPictures(t: ImageTemplate, embedded: EmbeddedPicture[], notes: string[]): Promise<{ template: ImageTemplate; ids: string[] }> {
    if (!embedded.length) return { template: t, ids: [] };
    const stored = new Map<string, string>();
    for (const e of embedded) {
      try {
        const form = new FormData();
        form.set('role', 'TEMPLATE_PHOTO');
        form.set('file', await embeddedFile(e));
        const res = await upload<{ asset: { id: string } }>(`/api/websites/${siteId}/image-assets`, form);
        stored.set(e.ref, res.asset.id);
      } catch (err) {
        notes.push(`Picture “${e.name}” could not be stored (${(err as Error).message}); it was left out.`);
      }
    }
    if (stored.size) await refreshAssets();
    const layers = t.layers.flatMap((l) => (l.type === 'fixed-photo' && l.assetId.startsWith('embedded-') ? (stored.has(l.assetId) ? [{ ...l, assetId: stored.get(l.assetId)! }] : []) : [l]));
    return { template: { ...t, layers }, ids: [...stored.values()] };
  }

  async function retireAsset(a: Asset) {
    try {
      await api(`/api/websites/${siteId}/image-assets/${a.id}`, { method: 'DELETE' });
      await refreshAssets();
      if (settings?.logoAssetId === a.id) change((s) => ({ ...s, logoAssetId: null }));
      toast('success', 'Removed from the template library (the file is kept).');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setConfirmRemove(null);
    }
  }

  function switchSite(id: string) {
    if (dirty && !window.confirm('Discard unsaved template changes for this website?')) return;
    setSiteId(id);
    const url = new URL(window.location.href);
    url.searchParams.set('site', id);
    window.history.replaceState(null, '', url);
  }

  if (loadError) return <Alert tone="danger" title="Could not load the templates">{loadError}</Alert>;
  if (!data || !hist || !settings) return <Card><p className="text-muted text-sm">Loading templates…</p></Card>;

  const vars = { title: previewTitle || 'Your article title appears here', site: data.website.name, keyword: 'example keyword' };
  const photoUrl = (slot: number) => (photoIds[slot] ? `/api/media/${photoIds[slot]}` : null);

  return (
    <div className="space-y-4">
      <style>{FONT_FACES}</style>
      {/* Top bar */}
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <label className="text-sm font-medium" htmlFor="tpl-site">
            Website
          </label>
          <Select id="tpl-site" value={siteId} onChange={(e) => switchSite(e.target.value)} className="w-auto min-w-48">
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.active ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
          <div className="surface-2 ml-1 inline-flex rounded-lg p-0.5" role="tablist" aria-label="Template">
            {(['featured', 'body'] as const).map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={which === w}
                type="button"
                onClick={() => {
                  setWhich(w);
                  setSelected(null);
                }}
                className={cx('rounded-md px-3 py-1.5 text-sm font-medium', which === w ? 'surface shadow-sm' : 'text-muted')}
              >
                {w === 'featured' ? 'Featured image' : 'Body images'}
              </button>
            ))}
          </div>
          <div className="surface-2 ml-1 inline-flex rounded-lg p-0.5" role="tablist" aria-label="Writer">
            {(['celebrity', 'tigram'] as const).map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={set === w}
                type="button"
                onClick={() => {
                  setSet(w);
                  setSelected(null);
                }}
                className={cx('rounded-md px-3 py-1.5 text-sm font-medium', set === w ? 'surface shadow-sm' : 'text-muted')}
              >
                {w === 'celebrity' ? 'Celebrity image template' : 'Tigram image template'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {dirty ? <Chip tone="warning">Unsaved changes</Chip> : <Chip tone="success">Saved</Chip>}
            <Button size="sm" variant="ghost" aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled={!hist.past.length} onClick={() => setHist((h) => (h ? undo(h) : h))}>
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled={!hist.future.length} onClick={() => setHist((h) => (h ? redo(h) : h))}>
              <Redo2 className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setImportOpen(true)} disabled={!template}>
              <FileJson className="h-4 w-4" /> Import
            </Button>
            <Button
              size="sm"
              disabled={!template}
              onClick={() => {
                if (!template) return;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }));
                a.download = `${data.website.name}-${set}-${which}-template.json`.replace(/[^\w.-]+/g, '-');
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              }}
            >
              <Download className="h-4 w-4" /> Export
            </Button>
            <Button size="sm" disabled={!dirty} onClick={() => void load(siteId)}>
              <RefreshCw className="h-4 w-4" /> Revert
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
              <Save className="h-4 w-4" /> Save templates
            </Button>
          </div>
        </div>
        <div className="border-app flex flex-wrap items-center gap-3 border-t px-3 py-2 text-sm">
          {set === 'tigram' ? (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={view?.useFeatured ?? true} onChange={(e) => changeSet((v) => ({ ...v, useFeatured: e.target.checked }))} />
                <span>Use the featured design for Tigram featured images</span>
              </label>
              <span className="text-muted text-xs">
                {view?.useFeatured ?? true
                  ? 'ChatGPT draws the featured picture without text; this design adds the title and logo. Use a one-picture design.'
                  : 'ChatGPT writes the title on the featured picture; it gets the body design, like the body pictures.'}
              </span>
              {!settings.tigram ? <Chip tone="info">Same as Celebrity until you change it</Chip> : null}
            </>
          ) : (
            <span className="text-muted text-xs">Celebrity articles: the gallery photos go into the featured design's photo places; body images use the body design.</span>
          )}
          <Button
            size="sm"
            className="ml-auto"
            disabled={set === 'celebrity' && !settings.tigram}
            title={set === 'celebrity' && !settings.tigram ? 'The Tigram templates are the Celebrity ones until you change them.' : undefined}
            onClick={() => {
              const from = set === 'celebrity' ? 'tigram' : 'celebrity';
              const source = JSON.parse(JSON.stringify(templateSet(settings, from))) as WriterTemplates;
              changeSet((v) => ({ ...v, featured: source.featured, body: source.body }));
              setSelected(null);
              toast('success', `Copied the ${from === 'celebrity' ? 'Celebrity' : 'Tigram'} featured and body designs. Save templates to keep them (Undo goes back).`);
            }}
          >
            <Copy className="h-4 w-4" /> {set === 'celebrity' ? 'Copy from Tigram' : 'Copy from Celebrity'}
          </Button>
        </div>
      </Card>

      {which === 'body' && !view?.body ? (
        <Card title="Body images: clean photo" description="Body images are normally clean 16:9 crops of the photo or illustration — no text, no logo, no watermark.">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div>
              {preview.url ? <img src={preview.url} alt="Body image preview" className="border-app w-full rounded-lg border" /> : <div className="surface-2 aspect-video rounded-lg" />}
              <p className="text-muted mt-2 text-xs">Preview rendered by the production renderer (smart crop of the sample or chosen photo).</p>
            </div>
            <div className="space-y-3 text-sm">
              <p>To brand body images too, start a body template:</p>
              <Button onClick={() => changeSet((v) => ({ ...v, body: presetBodyCornerLogo(v.featured.accent) }))}>
                <LayoutTemplate className="h-4 w-4" /> Photo with corner logo
              </Button>
              <PreviewControls data={data} photoIds={photoIds} setPhotoIds={setPhotoIds} title={previewTitle} setTitle={setPreviewTitle} hideTitle />
            </div>
          </div>
        </Card>
      ) : template ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
          {/* The editor stays in view while the panels on the right scroll (owner: editing a text moved the canvas away). */}
          <div className="min-w-0 space-y-3 xl:sticky xl:top-3">
            {/* Toolbar */}
            <Card padded={false}>
              <div className="flex flex-wrap items-center gap-1.5 p-2">
                <span className="text-muted px-1 text-xs font-medium uppercase">Add</span>
                <Button size="sm" variant="ghost" onClick={() => addLayer('photo', { slot: template.layers.some((l) => l.type === 'photo' && l.slot === 0) ? 1 : 0 })}>
                  <ImageIcon className="h-4 w-4" /> Photo slot
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLayer('photo', { slot: template.layers.some((l) => l.type === 'photo' && l.slot === 0) ? 1 : 0, circle: true })}>
                  <Circle className="h-4 w-4" /> Circle photo slot
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLayer('text')}>
                  <Type className="h-4 w-4" /> Text
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLayer('logo')}>
                  <BringToFront className="h-4 w-4" /> Logo
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLayer('rect')}>
                  <Square className="h-4 w-4" /> Rectangle
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLayer('circle')}>
                  <Circle className="h-4 w-4" /> Circle
                </Button>
                <Button size="sm" variant="ghost" onClick={() => addLayer('svg')}>
                  <Shapes className="h-4 w-4" /> SVG
                </Button>
                <Button size="sm" variant={pen?.as === 'shape' ? 'secondary' : 'ghost'} aria-pressed={pen?.as === 'shape'} title={`Pen (P): draw your own shape. ${PEN_HELP}`} onClick={() => startPen('shape')}>
                  <PenTool className="h-4 w-4" /> Pen shape
                </Button>
                <Button size="sm" variant={pen?.as === 'photo' ? 'secondary' : 'ghost'} aria-pressed={pen?.as === 'photo'} title={`Pen: draw your own photo place (the photo is cut to it). ${PEN_HELP}`} onClick={() => startPen('photo')}>
                  <PenTool className="h-4 w-4" /> Pen photo slot
                </Button>
                <span className="border-app mx-1 h-6 border-l" />
                <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.1, round(scale * 0.8)))}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="w-12 text-center text-xs tabular-nums">{Math.round(scale * 100)}%</span>
                <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => setZoom(Math.min(2, round(scale * 1.25)))}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button size="sm" variant={zoom === 'fit' ? 'secondary' : 'ghost'} onClick={() => setZoom('fit')}>
                  <Maximize className="h-4 w-4" /> Fit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>
                  100%
                </Button>
                <Button size="sm" variant={snap ? 'secondary' : 'ghost'} aria-pressed={snap} title="Snap to edges and centers (hold Alt to bypass)" onClick={() => setSnap((v) => !v)}>
                  <Magnet className="h-4 w-4" /> Snap
                </Button>
                <div className="surface-2 ml-auto inline-flex rounded-lg p-0.5" role="tablist" aria-label="Canvas view">
                  {(['edit', 'output'] as const).map((v) => (
                    <button key={v} role="tab" type="button" aria-selected={canvasView === v} onClick={() => setCanvasView(v)} className={cx('rounded-md px-2.5 py-1 text-xs font-medium', canvasView === v ? 'surface shadow-sm' : 'text-muted')}>
                      {v === 'edit' ? 'Edit' : 'Real output'}
                    </button>
                  ))}
                </div>
              </div>
              {pen ? (
                <div className="border-app flex flex-wrap items-center gap-2 border-t bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-100" role="status">
                  <PenTool className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <strong>{pen.as === 'photo' ? 'Pen photo slot' : 'Pen shape'}:</strong> {PEN_HELP} ({pen.points.length} point{pen.points.length === 1 ? '' : 's'})
                  </span>
                  <Button size="sm" variant="primary" disabled={pen.points.length < 2} onClick={() => finishPen(pen.as === 'photo' || pen.points.length >= 3)}>Finish</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPen(null)}>Cancel</Button>
                </div>
              ) : editable ? (
                <div className="border-app text-muted border-t px-3 py-2 text-xs" role="note">
                  Points: drag a square to move it, drag a round handle to bend the curve (Alt: one side only). Double-click a square: corner ↔ curve. Double-click the line: add a point. Alt-click a square: remove it.
                </div>
              ) : null}
            </Card>

            {/* Canvas */}
            <div ref={wrapRef} className={cx('border-app surface-2 relative max-h-[75vh] rounded-xl border xl:max-h-[calc(100vh_-_300px)]', zoom === 'fit' ? 'overflow-hidden' : 'overflow-auto')} style={{ padding: FRAME_PAD }}>
              {canvasView === 'output' ? (
                <div className="relative mx-auto" style={{ width: CANVAS.width * scale, height: CANVAS.height * scale }}>
                  {preview.url ? <img src={preview.url} alt="Real output (production renderer)" className="h-full w-full" /> : <div className="surface h-full w-full" />}
                  {preview.busy ? <span className="absolute right-2 top-2"><Chip>rendering…</Chip></span> : null}
                </div>
              ) : null}
              <div
                hidden={canvasView === 'output'}
                ref={stageRef}
                role="application"
                aria-label={`${which === 'featured' ? 'Featured' : 'Body'} image canvas, 1920 by 1080`}
                className="relative mx-auto select-none"
                style={{ width: CANVAS.width * scale, height: CANVAS.height * scale, background: resolve(template.background, template.accent), touchAction: 'none' }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvasBg) setSelected(null);
                }}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <div className="absolute inset-0 overflow-hidden" data-canvas-bg="1">
                  {template.layers.map((l) =>
                    l.visible ? (
                      <div
                        key={l.id}
                        data-layer={l.id}
                        onPointerDown={(e) => startDrag(e, 'move', l)}
                        className={cx('absolute', l.locked ? 'cursor-default' : 'cursor-move')}
                        style={{ left: l.x * scale, top: l.y * scale, width: l.width * scale, height: l.height * scale, transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined, opacity: l.opacity }}
                      >
                        <LayerVisual layer={l} template={template} scale={scale} vars={vars} photoUrl={photoUrl} logoUrl={activeLogoId ? `/api/media/${activeLogoId}` : null} />
                      </div>
                    ) : null,
                  )}
                </div>
                {guides.map((g, i) => (
                  <div key={i} className="pointer-events-none absolute bg-fuchsia-500" style={g.axis === 'x' ? { left: g.at * scale, top: 0, width: 1, height: '100%' } : { top: g.at * scale, left: 0, height: 1, width: '100%' }} />
                ))}
                {selectedLayer && selectedLayer.visible ? (
                  <div
                    className="pointer-events-none absolute"
                    style={{ left: selectedLayer.x * scale, top: selectedLayer.y * scale, width: selectedLayer.width * scale, height: selectedLayer.height * scale, transform: selectedLayer.rotation ? `rotate(${selectedLayer.rotation}deg)` : undefined, outline: '2px solid #6366f1', outlineOffset: 0 }}
                  >
                    {!selectedLayer.locked ? (
                      <>
                        {HANDLES.map((h) => (
                          <span key={h} aria-hidden onPointerDown={(e) => startDrag(e, 'resize', selectedLayer, h)} className="pointer-events-auto absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-indigo-500 bg-white" style={handlePos(h)} />
                        ))}
                        <span aria-hidden className="absolute left-1/2 top-0 h-6 w-px -translate-y-6 bg-indigo-500" />
                        <span aria-hidden title="Rotate (Shift: 15° steps)" onPointerDown={(e) => startDrag(e, 'rotate', selectedLayer)} className="pointer-events-auto absolute left-1/2 top-0 h-3.5 w-3.5 -translate-x-1/2 -translate-y-8 cursor-grab rounded-full border-2 border-indigo-500 bg-white" />
                      </>
                    ) : null}
                  </div>
                ) : null}
                {editable
                  ? (() => {
                      const pts = canvasPoints(editable);
                      const closed = closedOf(editable);
                      const r = 6 / scale;
                      const line = { stroke: '#6366f1', strokeWidth: 1.5 / scale };
                      return (
                        <svg className="pointer-events-none absolute inset-0" width={CANVAS.width * scale} height={CANVAS.height * scale} viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`} onPointerMove={pointMove} onPointerUp={pointUp} onPointerCancel={pointUp} aria-hidden>
                          <path d={canvasD(pts, closed)} fill="none" {...line} />
                          <path d={canvasD(pts, closed)} fill="none" stroke="transparent" strokeWidth={14 / scale} className="pointer-events-auto cursor-copy" onDoubleClick={addPointAt} />
                          {pts.map((q, i) => (
                            <g key={i}>
                              {q.ix || q.iy ? (
                                <>
                                  <line x1={q.x} y1={q.y} x2={q.x + q.ix} y2={q.y + q.iy} {...line} />
                                  <circle data-pen-handle={`in-${i}`} cx={q.x + q.ix} cy={q.y + q.iy} r={r * 0.8} fill="#6366f1" className="pointer-events-auto cursor-pointer" onPointerDown={(e) => pointDown(e, 'in', i)} />
                                </>
                              ) : null}
                              {q.ox || q.oy ? (
                                <>
                                  <line x1={q.x} y1={q.y} x2={q.x + q.ox} y2={q.y + q.oy} {...line} />
                                  <circle data-pen-handle={`out-${i}`} cx={q.x + q.ox} cy={q.y + q.oy} r={r * 0.8} fill="#6366f1" className="pointer-events-auto cursor-pointer" onPointerDown={(e) => pointDown(e, 'out', i)} />
                                </>
                              ) : null}
                              <rect
                                data-pen-point={i}
                                x={q.x - r}
                                y={q.y - r}
                                width={2 * r}
                                height={2 * r}
                                fill="#fff"
                                {...line}
                                className="pointer-events-auto cursor-move"
                                onPointerDown={(e) => pointDown(e, 'anchor', i)}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  patchLayer(editable.id, { ...penGeometry(toggleSmooth(pts, closed, i), closed) });
                                }}
                              />
                            </g>
                          ))}
                        </svg>
                      );
                    })()
                  : null}
                {pen ? (
                  <svg
                    data-pen-canvas="1"
                    className="absolute inset-0 cursor-crosshair"
                    width={CANVAS.width * scale}
                    height={CANVAS.height * scale}
                    viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
                    onPointerDown={penDown}
                    onPointerMove={penMove}
                    onPointerUp={() => (penDrag.current = null)}
                    onPointerCancel={() => (penDrag.current = null)}
                    onDoubleClick={() => finishPen(pen.as === 'photo' || pen.points.length >= 3)}
                    aria-label={`Pen tool: ${PEN_HELP}`}
                  >
                    {pen.points.length ? <path d={canvasD(pen.points, false)} fill={pen.as === 'photo' ? 'rgba(99,102,241,0.18)' : 'none'} stroke="#6366f1" strokeWidth={2 / scale} /> : null}
                    {pen.hover && pen.points.length ? <line x1={pen.points[pen.points.length - 1].x} y1={pen.points[pen.points.length - 1].y} x2={pen.hover.x} y2={pen.hover.y} stroke="#6366f1" strokeWidth={1.5 / scale} strokeDasharray={`${6 / scale} ${4 / scale}`} /> : null}
                    {pen.points.map((q, i) => (
                      <g key={i}>
                        {q.ox || q.oy ? <line x1={q.x + q.ix} y1={q.y + q.iy} x2={q.x + q.ox} y2={q.y + q.oy} stroke="#6366f1" strokeWidth={1 / scale} /> : null}
                        <rect x={q.x - (i === 0 ? 8 : 5) / scale} y={q.y - (i === 0 ? 8 : 5) / scale} width={(i === 0 ? 16 : 10) / scale} height={(i === 0 ? 16 : 10) / scale} fill={i === 0 ? '#eef2ff' : '#fff'} stroke="#6366f1" strokeWidth={1.5 / scale} />
                      </g>
                    ))}
                  </svg>
                ) : null}
              </div>
            </div>
            {/* Preview data and the final check, under the canvas so they stay in view too. */}
            <Card padded={false}>
              <div className="flex flex-wrap items-end gap-3 p-3">
                <PreviewControls compact data={data} photoIds={photoIds} setPhotoIds={setPhotoIds} title={previewTitle} setTitle={setPreviewTitle} />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => void finalRender()}>Check final size</Button>
                  {canvasView === 'edit' ? (
                    <Button size="sm" variant="ghost" onClick={() => setCanvasView('output')}>
                      <Eye className="h-4 w-4" /> See real output
                    </Button>
                  ) : null}
                </div>
              </div>
              {preview.error || finalInfo ? (
                <div className="space-y-2 px-3 pb-3">
                  {preview.error ? <Alert tone="danger">{preview.error}</Alert> : null}
                  {finalInfo ? (
                    <Alert tone={finalInfo.over ? 'warning' : 'success'} title="Final output">
                      {finalInfo.text}
                      {finalInfo.over ? ' — over budget even at the lowest quality; simplify the design or raise the byte budget in Settings.' : ''}{' '}
                      <a href={finalInfo.url} target="_blank" rel="noreferrer" className="link">
                        Open the final file
                      </a>
                    </Alert>
                  ) : null}
                </div>
              ) : null}
            </Card>
            <p className="text-muted text-xs">
              {canvasView === 'edit'
                ? 'Drag to move · handles resize (Shift keeps the ratio) · top knob rotates (Shift: 15°) · arrows nudge 1 px (Shift: 10 px) · Delete · Ctrl+D duplicate · Ctrl+Z / Ctrl+Shift+Z · Alt: no snapping. “Real output” shows what the article pipeline produces.'
                : 'Real output: drawn by the production renderer, exactly what the article pipeline produces. Switch back to “Edit” to move layers.'}
            </p>
          </div>

          {/* Side panels: the selected layer first, so its settings sit next to the canvas. */}
          <div className="space-y-4">
            {selectedLayer ? (
              <Card
                title={`${selectedLayer.name || selectedLayer.type}`}
                actions={
                  <div className="flex gap-1">
                    <IconBtn label="Bring to front" onClick={() => order(selectedLayer.id, 'front')}><BringToFront className="h-4 w-4" /></IconBtn>
                    <IconBtn label="Send to back" onClick={() => order(selectedLayer.id, 'back')}><SendToBack className="h-4 w-4" /></IconBtn>
                    <IconBtn label="Duplicate (Ctrl+D)" onClick={() => duplicate(selectedLayer.id)}><Copy className="h-4 w-4" /></IconBtn>
                    <IconBtn label="Delete layer" onClick={() => removeLayer(selectedLayer.id)}><Trash2 className="h-4 w-4" /></IconBtn>
                  </div>
                }
              >
                <LayerProperties
                  layer={selectedLayer}
                  accent={template.accent}
                  fixedPhotos={fixedPhotos}
                  onPatch={(patch, key) => patchLayer(selectedLayer.id, patch, key ? `${selectedLayer.id}:${key}` : null)}
                  onReplace={(layer) => {
                    changeTemplate((t) => ({ ...t, layers: t.layers.map((x) => (x.id === selectedLayer.id ? layer : x)) }));
                    setSelected(layer.id);
                  }}
                />
              </Card>
            ) : (
              <Card>
                <p className="text-muted text-sm">Click a layer on the canvas or in the list below to edit it here.</p>
              </Card>
            )}
            <Card title="Layers" description="Top of the list is in front.">
              {template.layers.length === 0 ? <p className="text-muted text-sm">No layers yet — add one from the toolbar.</p> : null}
              <ul className="space-y-1">
                {template.layers
                  .map((l, i) => ({ l, i }))
                  .reverse()
                  .map(({ l, i }) => (
                    <li key={l.id} className={cx('flex items-center gap-1 rounded-lg border px-2 py-1 text-sm', selected === l.id ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/40' : 'border-app')}>
                      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setSelected(l.id)}>
                        <span className={cx(!l.visible && 'text-muted line-through')}>{l.name || l.type}</span> <span className="text-muted text-xs">{l.type === 'photo' ? `slot ${l.slot + 1}` : l.type}</span>
                      </button>
                      <IconBtn label={l.visible ? 'Hide' : 'Show'} onClick={() => patchLayer(l.id, { visible: !l.visible })}>{l.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</IconBtn>
                      <IconBtn label={l.locked ? 'Unlock' : 'Lock'} onClick={() => patchLayer(l.id, { locked: !l.locked })}>{l.locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}</IconBtn>
                      <IconBtn label="Bring forward" disabled={i === template.layers.length - 1} onClick={() => order(l.id, 'up')}><ArrowUp className="h-3.5 w-3.5" /></IconBtn>
                      <IconBtn label="Send backward" disabled={i === 0} onClick={() => order(l.id, 'down')}><ArrowDown className="h-3.5 w-3.5" /></IconBtn>
                    </li>
                  ))}
              </ul>
            </Card>

            <Card title="Template">
              <div className="space-y-3">
                <Field label="Name" htmlFor="tpl-name">
                  <Input id="tpl-name" value={template.name} maxLength={80} onChange={(e) => changeTemplate((t) => ({ ...t, name: e.target.value }), 'tpl:name')} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Accent color" htmlFor="tpl-accent">
                    <ColorPicker id="tpl-accent" wide ariaLabel="Accent color" value={template.accent} onChange={(hex) => changeSet((v) => ({ ...v, featured: { ...v.featured, accent: hex }, body: v.body ? { ...v.body, accent: hex } : null }), 'tpl:accent')} />
                  </Field>
                  <ColorField id="tpl-bg" label="Background" value={template.background} accent={template.accent} onChange={(v) => changeTemplate((t) => ({ ...t, background: v ?? '#111827' }), 'tpl:bg')} />
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Presets</p>
                  <div className="flex flex-wrap gap-2">
                    {which === 'featured' ? (
                      <>
                        <Button size="sm" onClick={() => changeSet((v) => ({ ...v, featured: presetSingle(v.featured.accent) }))}>Single photo · corner logo</Button>
                        <Button size="sm" onClick={() => changeSet((v) => ({ ...v, featured: presetSplit(v.featured.accent) }))}>Split photo · center logo</Button>
                        <Button size="sm" onClick={() => changeSet((v) => ({ ...v, featured: presetPhotoCircle(v.featured.accent) }))}>Photo with circle photo</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" onClick={() => changeSet((v) => ({ ...v, body: presetBodyCornerLogo(v.featured.accent) }))}>Photo with corner logo</Button>
                        <Button size="sm" onClick={() => changeSet((v) => ({ ...v, body: null }))}>Back to clean photo</Button>
                      </>
                    )}
                  </div>
                  <p className="text-muted mt-1.5 text-xs">A preset replaces this template (undo brings it back).</p>
                </div>
              </div>
            </Card>

            <Card title="Logo" description="PNG, JPEG, WebP or SVG (SVG is sanitized and rasterized). Used by every logo layer.">
              {activeLogoId ? <img src={`/api/media/${activeLogoId}`} alt="Current logo" className="surface-2 mb-3 max-h-24 rounded-lg p-2" /> : <p className="text-muted mb-3 text-sm">No logo yet — logo layers stay empty until you upload one.</p>}
              <FileButton label="Upload logo" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onFile={(f) => void uploadAsset('LOGO', f)} />
              {logos.length > 1 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {logos.map((l) => (
                    <div key={l.id} className={cx('rounded-lg border p-1', l.id === activeLogoId ? 'border-indigo-400' : 'border-app')}>
                      <button type="button" title={l.name} onClick={() => change((s) => ({ ...s, logoAssetId: l.id }))}>
                        <img src={`/api/media/${l.id}`} alt={l.name || 'Logo'} className="h-10 max-w-24 object-contain" />
                      </button>
                      <button type="button" className="text-muted block w-full text-[11px] hover:text-rose-600" onClick={() => setConfirmRemove(l)}>remove</button>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>

            <Card title="Fixed photos" description="Images that appear in every render (e.g. a background texture).">
              <FileButton label="Upload fixed photo" accept="image/png,image/jpeg,image/webp,image/gif" onFile={(f) => void uploadAsset('TEMPLATE_PHOTO', f)} />
              {fixedPhotos.length ? (
                <ul className="mt-3 space-y-2">
                  {fixedPhotos.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <img src={`/api/media/${p.id}`} alt="" className="h-10 w-16 rounded object-cover" />
                      <span className="min-w-0 flex-1 truncate">{p.name || p.id}</span>
                      <Button size="sm" variant="ghost" onClick={() => addLayer('fixed-photo', { assetId: p.id })}>
                        <ImagePlus className="h-4 w-4" /> Add
                      </Button>
                      <IconBtn label="Remove from library" onClick={() => setConfirmRemove(p)}><Trash2 className="h-4 w-4" /></IconBtn>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </div>
        </div>
      ) : null}

      <ImportDialog
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImport={async (t, notes, embedded) => {
          setImportOpen(false);
          const { template: stored, ids } = await storeEmbeddedPictures(t, embedded, notes);
          const fixed = normalizeImported(stored, new Set([...assetIds, ...ids]), notes);
          changeTemplate(() => ({ ...fixed, accent: template?.accent ?? fixed.accent }));
          setSelected(null);
          toast(notes.length ? 'info' : 'success', notes.length ? `Imported with notes: ${notes.join(' ')}` : 'Template imported (save to keep it).');
        }}
      />
      <ConfirmDialog open={Boolean(confirmRemove)} title="Remove from the template library?" confirmLabel="Remove" tone="danger" onCancel={() => setConfirmRemove(null)} onConfirm={() => confirmRemove && void retireAsset(confirmRemove)}>
        Layers that use it will render without it. The file itself is kept on disk.
      </ConfirmDialog>
    </div>
  );
}

function IconBtn({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="text-muted rounded p-1 hover:bg-black/5 hover:text-[var(--text)] disabled:opacity-30 dark:hover:bg-white/10">
      {children}
    </button>
  );
}

function FileButton({ label, accept, onFile }: { label: string; accept: string; onFile: (f: File | undefined) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button size="sm" onClick={() => ref.current?.click()}>
        <Upload className="h-4 w-4" /> {label}
      </Button>
    </>
  );
}

function PreviewControls({ data, photoIds, setPhotoIds, title, setTitle, hideTitle, compact }: { data: Data; photoIds: [string, string]; setPhotoIds: (v: [string, string]) => void; title: string; setTitle: (v: string) => void; hideTitle?: boolean; compact?: boolean }) {
  const pickPhoto = (slot: number, value: string) => setPhotoIds((slot === 0 ? [value, photoIds[1]] : [photoIds[0], value]) as [string, string]);
  if (compact) {
    return (
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Preview title ({{title}})" htmlFor="pv-title">
          <Input id="pv-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} className="px-2 py-1.5" />
        </Field>
        {[0, 1].map((slot) => (
          <Field key={slot} label={`Photo slot ${slot + 1}`} htmlFor={`pv-photo-${slot}`}>
            <Select id={`pv-photo-${slot}`} value={photoIds[slot]} onChange={(e) => pickPhoto(slot, e.target.value)} className="px-2 py-1.5">
              <option value="">Sample photo {slot + 1}</option>
              {data.previewPhotos.map((p) => (
                <option key={p.id} value={p.id}>
                  {(p.name || p.id).slice(0, 50)} ({p.width}×{p.height})
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {!hideTitle ? (
        <Field label="Preview title" htmlFor="pv-title" help="Fills {{title}}. Articles use their approved title.">
          <Textarea id="pv-title" rows={2} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      ) : null}
      {[0, 1].map((slot) => (
        <Field key={slot} label={`Photo slot ${slot + 1}`} htmlFor={`pv-photo-${slot}`}>
          <Select id={`pv-photo-${slot}`} value={photoIds[slot]} onChange={(e) => setPhotoIds((slot === 0 ? [e.target.value, photoIds[1]] : [photoIds[0], e.target.value]) as [string, string])}>
            <option value="">Sample photo {slot + 1}</option>
            {data.previewPhotos.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.name || p.id).slice(0, 50)} ({p.width}×{p.height})
              </option>
            ))}
          </Select>
        </Field>
      ))}
      <p className="text-muted text-xs">
        Output: {data.output.size.replace('x', '×')}, budget {(data.output.maxBytes / 1024).toFixed(0)} KB (Settings → SEO / images).
      </p>
    </div>
  );
}

/** A photo place's shape and border on the editing canvas (the production renderer draws the same). */
function frameStyle(l: { radius: number; shape: 'rect' | 'circle' | 'path'; points?: PenPoint[]; stroke: string | null; strokeWidth: number; width: number; height: number }, scale: number, accent: string): CSSProperties {
  // A pen-drawn place: the photo is cut to the drawn shape (its border is drawn by PenBorder).
  if (l.shape === 'path' && l.points?.length) return { clipPath: `path('${penPathD(l.points, true, l.width * scale, l.height * scale)}')` };
  return { borderRadius: l.shape === 'circle' ? '50%' : l.radius * scale, border: l.stroke && l.strokeWidth ? `${l.strokeWidth * scale}px solid ${resolve(l.stroke, accent)}` : undefined, boxSizing: 'border-box' };
}

/** The border of a pen-drawn photo place, inside the shape (as the renderer draws it). */
function PenBorder({ l, accent }: { l: { id: string; shape: string; points?: PenPoint[]; stroke: string | null; strokeWidth: number; width: number; height: number }; accent: string }) {
  if (l.shape !== 'path' || !l.points?.length || !l.stroke || !l.strokeWidth) return null;
  const d = penPathD(l.points, true, l.width, l.height);
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${l.width} ${l.height}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <clipPath id={`pen-${l.id}`}>
          <path d={d} />
        </clipPath>
      </defs>
      <path d={d} fill="none" stroke={resolve(l.stroke, accent)} strokeWidth={l.strokeWidth * 2} strokeLinejoin="round" clipPath={`url(#pen-${l.id})`} />
    </svg>
  );
}

function LayerVisual({ layer: l, template, scale, vars, photoUrl, logoUrl }: { layer: Layer; template: ImageTemplate; scale: number; vars: Record<string, string>; photoUrl: (slot: number) => string | null; logoUrl: string | null }) {
  const accent = template.accent;
  switch (l.type) {
    case 'photo': {
      const url = photoUrl(l.slot);
      const frame = frameStyle(l, scale, accent);
      return (
        <>
          {url ? (
            <img src={url} alt="" draggable={false} className="h-full w-full object-cover" style={{ ...frame, objectPosition: l.focus === 'top' ? 'top' : 'center' }} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/80" style={{ ...frame, background: l.slot ? 'linear-gradient(135deg,#f97316,#7c2d12)' : 'linear-gradient(135deg,#0ea5e9,#1e3a8a)', fontSize: Math.max(10, 48 * scale) }}>
              Photo {l.slot + 1}
            </div>
          )}
          <PenBorder l={l} accent={accent} />
        </>
      );
    }
    case 'fixed-photo':
      return l.assetId ? (
        <>
          <img src={`/api/media/${l.assetId}`} alt="" draggable={false} className="h-full w-full object-cover" style={frameStyle(l, scale, accent)} />
          <PenBorder l={l} accent={accent} />
        </>
      ) : (
        <div className="h-full w-full bg-slate-400/60" />
      );
    case 'logo':
      return (
        <div className="flex h-full w-full items-center justify-center" style={l.plate ? { background: resolve(l.plateColor, accent), borderRadius: l.plateRadius * scale, padding: l.platePadding * scale } : undefined}>
          {logoUrl ? <img src={logoUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain" /> : <span className="rounded border border-dashed border-current px-1 text-center text-slate-500" style={{ fontSize: Math.max(9, 28 * scale) }}>Logo</span>}
        </div>
      );
    case 'text': {
      const text = fill(l.text, vars);
      const font = fontChoice(l.fontFamily);
      return (
        <div
          className="h-full w-full overflow-hidden"
          style={{
            fontFamily: font.css,
            fontSize: l.fontSize * scale,
            // A bundled font has only some weights: show the one the renderer uses, never a faked bold.
            fontWeight: font.bundled ? nearestWeight(font, l.fontWeight) : l.fontWeight,
            fontSynthesis: font.bundled ? 'none' : undefined,
            color: resolve(l.color, accent),
            textAlign: l.align,
            lineHeight: l.lineHeight,
            textTransform: l.uppercase ? 'uppercase' : undefined,
            background: l.background ? resolve(l.background, accent) : undefined,
            padding: l.padding * scale,
            display: '-webkit-box',
            WebkitLineClamp: l.maxLines,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      );
    }
    case 'rect':
      return <div className="h-full w-full" style={{ background: resolve(l.fill, accent), borderRadius: l.radius * scale, border: l.stroke && l.strokeWidth ? `${l.strokeWidth * scale}px solid ${resolve(l.stroke, accent)}` : undefined, boxSizing: 'border-box' }} />;
    case 'circle':
      return <div className="h-full w-full rounded-[50%]" style={{ background: resolve(l.fill, accent), border: l.stroke && l.strokeWidth ? `${l.strokeWidth * scale}px solid ${resolve(l.stroke, accent)}` : undefined, boxSizing: 'border-box' }} />;
    case 'path':
      return (
        <svg className="h-full w-full" viewBox={`0 0 ${l.width} ${l.height}`} preserveAspectRatio="none" style={{ overflow: 'visible' }} aria-hidden>
          <path d={penPathD(l.points, l.closed, l.width, l.height)} fill={l.closed ? resolve(l.fill, accent) : 'none'} stroke={l.stroke && l.strokeWidth ? resolve(l.stroke, accent) : 'none'} strokeWidth={l.strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      );
    case 'svg': {
      const safe = sanitizeSvg(l.svg);
      return safe ? <img src={svgUrl(safe)} alt="" draggable={false} className={cx('h-full w-full', /^<svg[^>]*preserveAspectRatio="none"/.test(safe) ? 'object-fill' : 'object-contain')} /> : <div className="h-full w-full border border-dashed border-rose-400" />;
    }
  }
}

function NumberField({ id, label, value, min, max, step = 1, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        onBlur={() => setText(String(value))}
        className="px-2 py-1.5"
      />
    </Field>
  );
}

function ColorField({ id, label, value, accent, onChange, nullable }: { id: string; label: string; value: string | null; accent: string; onChange: (v: string | null) => void; nullable?: boolean }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const swatch = value === 'accent' ? accent : value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
  const invalid = text !== '' && !COLOR_RE.test(text.trim());
  return (
    <Field label={label} htmlFor={id} error={invalid ? 'Use #rrggbb, rgba(r,g,b,a), accent or transparent' : null}>
      <div className="flex items-center gap-1.5">
        <ColorPicker ariaLabel={`${label} picker`} value={swatch} onChange={(v) => onChange(v)} swatches={[{ color: accent, label: 'accent' }]} dim={!value || value === 'transparent' || (value !== 'accent' && !/^#[0-9a-fA-F]{6}$/.test(value))} />
        <Input
          id={id}
          value={text}
          invalid={invalid}
          placeholder={nullable ? 'none' : ''}
          onChange={(e) => {
            setText(e.target.value);
            const v = e.target.value.trim();
            if (v === '' && nullable) onChange(null);
            else if (COLOR_RE.test(v)) onChange(v);
          }}
          className="px-2 py-1.5"
        />
      </div>
      <div className="mt-1 flex gap-2 text-xs">
        <button type="button" className="link" onClick={() => onChange('accent')}>accent</button>
        {nullable ? <button type="button" className="link" onClick={() => onChange(null)}>none</button> : <button type="button" className="link" onClick={() => onChange('transparent')}>transparent</button>}
      </div>
    </Field>
  );
}

function LayerProperties({ layer: l, accent, fixedPhotos, onPatch, onReplace }: { layer: Layer; accent: string; fixedPhotos: Asset[]; onPatch: (patch: Record<string, unknown>, key?: string) => void; onReplace: (layer: Layer) => void }) {
  const id = (k: string) => `lp-${l.id}-${k}`;
  const num = (k: string, label: string, value: number, min: number, max: number, step = 1) => <NumberField id={id(k)} label={label} value={value} min={min} max={max} step={step} onChange={(v) => onPatch({ [k]: v }, k)} />;
  const [svgText, setSvgText] = useState(l.type === 'svg' ? l.svg : '');
  const [svgError, setSvgError] = useState<string | null>(null);
  useEffect(() => {
    if (l.type === 'svg') setSvgText(l.svg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l.id]);
  return (
    <div className="space-y-3">
      {/* A text layer's words and font first: what is edited most (owner: the text field was far down). */}
      {l.type === 'text' ? (
        <div className="space-y-2">
          <Field label="Text" htmlFor={id('text')} help="Tokens: {{title}}, {{site}}, {{keyword}}">
            <Textarea id={id('text')} rows={3} value={l.text} maxLength={400} onChange={(e) => onPatch({ text: e.target.value }, 'text')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Font" htmlFor={id('font')}>
              <Select id={id('font')} value={l.fontFamily} onChange={(e) => onPatch({ fontFamily: e.target.value })} className="px-2 py-1.5" style={{ fontFamily: fontChoice(l.fontFamily).css }}>
                {FONT_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {FONT_CHOICES.filter((f) => f.group === g).map((f) => (
                      <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>
                        {f.id === 'arimo' ? 'Arimo (Helvetica / Arial look)' : f.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <Field label="Weight" htmlFor={id('weight')}>
              <Select id={id('weight')} value={l.fontWeight} onChange={(e) => onPatch({ fontWeight: Number(e.target.value) })} className="px-2 py-1.5">
                {WEIGHTS.map(([w, name]) => {
                  const font = fontChoice(l.fontFamily);
                  const used = nearestWeight(font, w);
                  return (
                    <option key={w} value={w}>
                      {name}
                      {font.bundled && used !== w ? ` (this font: ${WEIGHTS.find(([x]) => x === used)?.[1] ?? used})` : ''}
                    </option>
                  );
                })}
              </Select>
            </Field>
            {num('fontSize', 'Size (max)', l.fontSize, 8, 400)}
            {num('maxLines', 'Max lines', l.maxLines, 1, 8)}
            {num('lineHeight', 'Line height', l.lineHeight, 0.8, 2.5, 0.05)}
            {num('padding', 'Padding', l.padding, 0, 200)}
            <Field label="Align" htmlFor={id('align')}>
              <Select id={id('align')} value={l.align} onChange={(e) => onPatch({ align: e.target.value })} className="px-2 py-1.5">
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </Select>
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox label="UPPERCASE" checked={l.uppercase} onChange={(e) => onPatch({ uppercase: e.target.checked })} />
            </div>
            <ColorField id={id('color')} label="Color" value={l.color} accent={accent} onChange={(v) => onPatch({ color: v ?? '#ffffff' }, 'color')} />
            <ColorField id={id('bg')} label="Background" value={l.background} accent={accent} nullable onChange={(v) => onPatch({ background: v }, 'background')} />
          </div>
          <p className="text-muted text-xs">Long titles shrink down to 60 % of the size, then end with “…”.</p>
        </div>
      ) : null}

      <Field label="Layer name" htmlFor={id('name')}>
        <Input id={id('name')} value={l.name} maxLength={60} onChange={(e) => onPatch({ name: e.target.value }, 'name')} className="px-2 py-1.5" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {num('x', 'X', l.x, -1920, 3840)}
        {num('y', 'Y', l.y, -1080, 2160)}
        {num('width', 'Width', l.width, 8, 3840)}
        {num('height', 'Height', l.height, 8, 2160)}
        {num('rotation', 'Rotation °', l.rotation, -360, 360)}
        <NumberField id={id('opacity')} label="Opacity %" value={Math.round(l.opacity * 100)} min={0} max={100} onChange={(v) => onPatch({ opacity: v / 100 }, 'opacity')} />
      </div>

      {l.type === 'photo' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Photo slot" htmlFor={id('slot')}>
            <Select id={id('slot')} value={l.slot} onChange={(e) => onPatch({ slot: Number(e.target.value) })} className="px-2 py-1.5">
              <option value={0}>Slot 1 (main photo)</option>
              <option value={1}>Slot 2 (second photo)</option>
            </Select>
          </Field>
          <Field label="Framing" htmlFor={id('focus')}>
            <Select id={id('focus')} value={l.focus} onChange={(e) => onPatch({ focus: e.target.value })} className="px-2 py-1.5">
              <option value="auto">Smart (attention)</option>
              <option value="center">Center</option>
              <option value="top">Top</option>
            </Select>
          </Field>
          <Field label="Shape" htmlFor={id('shape')}>
            <Select id={id('shape')} value={l.shape} onChange={(e) => onPatch({ shape: e.target.value })} className="px-2 py-1.5">
              <option value="rect">Rectangle</option>
              <option value="circle">Circle</option>
              {l.points?.length ? <option value="path">Pen shape</option> : null}
            </Select>
          </Field>
          {l.shape === 'rect' ? num('radius', 'Corner radius', l.radius, 0, 540) : <span />}
          <ColorField id={id('stroke')} label="Border" value={l.stroke} accent={accent} nullable onChange={(v) => onPatch({ stroke: v }, 'stroke')} />
          {num('strokeWidth', 'Border width', l.strokeWidth, 0, 100)}
          {l.shape === 'circle' && Math.abs(l.width - l.height) > 1 ? <p className="text-muted col-span-2 text-xs">Make the box square (same width and height) for a round circle.</p> : null}
        </div>
      ) : null}

      {l.type === 'fixed-photo' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Image" htmlFor={id('asset')} className="col-span-2">
            <Select id={id('asset')} value={l.assetId} onChange={(e) => onPatch({ assetId: e.target.value })} className="px-2 py-1.5">
              {!fixedPhotos.some((p) => p.id === l.assetId) ? <option value={l.assetId}>(missing image)</option> : null}
              {fixedPhotos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </Select>
          </Field>
          {num('radius', 'Corner radius', l.radius, 0, 540)}
        </div>
      ) : null}

      {l.type === 'logo' ? (
        <div className="space-y-2">
          <Checkbox label="Plate behind the logo" checked={l.plate} onChange={(e) => onPatch({ plate: e.target.checked })} />
          {l.plate ? (
            <div className="grid grid-cols-2 gap-2">
              <ColorField id={id('plateColor')} label="Plate color" value={l.plateColor} accent={accent} onChange={(v) => onPatch({ plateColor: v ?? '#ffffff' }, 'plateColor')} />
              {num('platePadding', 'Padding', l.platePadding, 0, 200)}
              {num('plateRadius', 'Plate radius', l.plateRadius, 0, 540)}
            </div>
          ) : null}
        </div>
      ) : null}

      {l.type === 'path' ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {l.closed ? <ColorField id={id('fill')} label="Fill" value={l.fill} accent={accent} onChange={(v) => onPatch({ fill: v ?? 'transparent' }, 'fill')} /> : null}
            <ColorField id={id('stroke')} label="Border" value={l.stroke} accent={accent} nullable onChange={(v) => onPatch({ stroke: v }, 'stroke')} />
            {num('strokeWidth', 'Border width', l.strokeWidth, 0, 100)}
            <div className="flex items-end pb-2">
              <Checkbox label="Closed shape" checked={l.closed} onChange={(e) => onPatch({ closed: e.target.checked, ...(!e.target.checked && !l.strokeWidth ? { stroke: l.stroke ?? 'accent', strokeWidth: 8 } : {}) })} />
            </div>
          </div>
          {l.closed && l.points.length >= 3 ? (
            <Button
              size="sm"
              onClick={() =>
                onReplace(
                  layerSchema.parse({ id: newLayerId('photo'), name: l.name ? `${l.name} (photo)` : 'Pen photo', type: 'photo', slot: 0, x: l.x, y: l.y, width: l.width, height: l.height, rotation: l.rotation, opacity: l.opacity, shape: 'path', points: l.points, stroke: l.stroke, strokeWidth: l.strokeWidth }),
                )
              }
            >
              <ImageIcon className="h-4 w-4" /> Use as photo slot
            </Button>
          ) : null}
        </div>
      ) : null}

      {l.type === 'rect' || l.type === 'circle' ? (
        <div className="grid grid-cols-2 gap-2">
          <ColorField id={id('fill')} label="Fill" value={l.fill} accent={accent} onChange={(v) => onPatch({ fill: v ?? 'transparent' }, 'fill')} />
          <ColorField id={id('stroke')} label="Border" value={l.stroke} accent={accent} nullable onChange={(v) => onPatch({ stroke: v }, 'stroke')} />
          {num('strokeWidth', 'Border width', l.strokeWidth, 0, 100)}
          {l.type === 'rect' ? num('radius', 'Corner radius', l.radius, 0, 540) : null}
        </div>
      ) : null}

      {l.type === 'svg' ? (
        <Field label="SVG markup" htmlFor={id('svg')} error={svgError} help="Plain shapes only: scripts, event handlers, images, fonts and external references are removed.">
          <Textarea
            id={id('svg')}
            rows={5}
            value={svgText}
            onChange={(e) => setSvgText(e.target.value)}
            onBlur={() => {
              const safe = sanitizeSvg(svgText);
              if (!safe) return setSvgError('Not a usable inline SVG (must start with <svg> and contain plain shapes).');
              setSvgError(null);
              setSvgText(safe);
              onPatch({ svg: safe });
            }}
            className="font-mono text-xs"
          />
        </Field>
      ) : null}
    </div>
  );
}

function ImportDialog({ open, onCancel, onImport }: { open: boolean; onCancel: () => void; onImport: (t: ImageTemplate, notes: string[], embedded: EmbeddedPicture[]) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setText('');
      setError(null);
    }
  }, [open]);
  function run() {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return setError('This is not valid JSON.');
    }
    const own = raw as { version?: unknown; layers?: unknown };
    if (own && own.version === 1 && Array.isArray(own.layers)) {
      const parsed = templateSchema.safeParse(raw);
      if (!parsed.success) return setError(`Not a valid template: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      return onImport(parsed.data, [], []);
    }
    const r = importForeignTemplate(raw);
    onImport(r.template, r.notes, r.embedded);
  }
  return (
    <ConfirmDialog open={open} title="Import a template" confirmLabel="Import" onCancel={onCancel} onConfirm={run}>
      <p className="mb-2">Paste a template exported here, or a Polotno design (pages are scaled proportionally into 1920×1080). Pictures inside the file (such as a logo) are kept and saved to this site's template library; image links are never fetched and become photo slots, as do images named “photo”. A design without a photo place gets photo slots behind it. SVG is sanitized; nothing in the file is executed.</p>
      <input
        type="file"
        accept="application/json,.json"
        className="mb-2 block text-xs"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }}
      />
      <textarea aria-label="Template JSON" className="surface w-full rounded-lg border p-2 font-mono text-xs" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      {error ? <p className="mt-1 text-xs font-medium text-rose-600" role="alert">{error}</p> : null}
    </ConfirmDialog>
  );
}
