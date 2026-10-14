'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
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
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, cx } from '@/components/ui';
import { api, apiBlob, upload } from '@/lib/client/api';
import {
  CANVAS,
  importForeignTemplate,
  presetBodyCornerLogo,
  presetSingle,
  presetSplit,
  sanitizeSvg,
  templateSchema,
  type ImageTemplate,
  type Layer,
  type SiteImageSettings,
} from '@/lib/image-template';
import {
  anchorRotatedResize,
  clampToCanvas,
  commit,
  commitFrom,
  createLayer,
  duplicateLayer,
  initHistory,
  newLayerId,
  redo,
  reorderLayer,
  replacePresent,
  resizeRect,
  rotationFromPointer,
  round,
  snapMove,
  snapResize,
  toLocal,
  undo,
  updateLayer,
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

const FONTS: Record<string, string> = {
  sans: "Inter, 'Segoe UI', Arial, Helvetica, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  condensed: "'Arial Narrow', 'Roboto Condensed', Arial, sans-serif",
  mono: "Consolas, 'Courier New', monospace",
};
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|accent|transparent|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
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
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [fitScale, setFitScale] = useState(0.4);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [previewTitle, setPreviewTitle] = useState(SAMPLE_TITLE);
  const [photoIds, setPhotoIds] = useState<[string, string]>(['', '']);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Asset | null>(null);

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
  const template = settings ? settings[which] : null;
  const dirty = settings ? JSON.stringify(settings) !== saved : false;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---- state changes (all through the history)
  const change = useCallback((fn: (s: SiteImageSettings) => SiteImageSettings, key: string | null = null) => setHist((h) => (h ? commit(h, fn(h.present), key) : h)), []);
  const changeTemplate = useCallback(
    (fn: (t: ImageTemplate) => ImageTemplate, key: string | null = null) =>
      change((s) => {
        const t = s[which];
        return t ? { ...s, [which]: fn(t) } : s;
      }, key),
    [change, which],
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
  const observer = useRef<ResizeObserver | null>(null);
  const wrapRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const update = () => {
      if (el.clientWidth > 0) setFitScale(Math.min(1, Math.max(0.1, (el.clientWidth - 2) / CANVAS.width)));
    };
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(el);
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
    setHist((h) => (h ? replacePresent(h, { ...h.present, [which]: updateLayer(h.present[which]!, d.id, patch) }) : h));
  }
  function endDrag() {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (d?.moved) setHist((h) => (h ? commitFrom(h, d.before) : h));
  }

  // ---- layer actions
  const addLayer = (type: NewLayerType, opts: { slot?: number; assetId?: string } = {}) => {
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

  // ---- keyboard: nudge, delete, undo/redo, duplicate
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.closest('input, textarea, select, [contenteditable="true"]') || el.closest('dialog[open]'))) return;
      const mod = e.ctrlKey || e.metaKey;
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
  const previewKey = settings ? JSON.stringify([which, template, previewTitle, photoIds, activeLogoId]) : '';
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
                a.download = `${data.website.name}-${which}-template.json`.replace(/[^\w.-]+/g, '-');
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
      </Card>

      {which === 'body' && !settings.body ? (
        <Card title="Body images: clean photo" description="Body images are normally clean 16:9 crops of the photo or illustration — no text, no logo, no watermark.">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div>
              {preview.url ? <img src={preview.url} alt="Body image preview" className="border-app w-full rounded-lg border" /> : <div className="surface-2 aspect-video rounded-lg" />}
              <p className="text-muted mt-2 text-xs">Preview rendered by the production renderer (smart crop of the sample or chosen photo).</p>
            </div>
            <div className="space-y-3 text-sm">
              <p>To brand body images too, start a body template:</p>
              <Button onClick={() => change((s) => ({ ...s, body: presetBodyCornerLogo(s.featured.accent) }))}>
                <LayoutTemplate className="h-4 w-4" /> Photo with corner logo
              </Button>
              <PreviewControls data={data} photoIds={photoIds} setPhotoIds={setPhotoIds} title={previewTitle} setTitle={setPreviewTitle} hideTitle />
            </div>
          </div>
        </Card>
      ) : template ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            {/* Toolbar */}
            <Card padded={false}>
              <div className="flex flex-wrap items-center gap-1.5 p-2">
                <span className="text-muted px-1 text-xs font-medium uppercase">Add</span>
                <Button size="sm" variant="ghost" onClick={() => addLayer('photo', { slot: template.layers.some((l) => l.type === 'photo' && l.slot === 0) ? 1 : 0 })}>
                  <ImageIcon className="h-4 w-4" /> Photo slot
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
              </div>
            </Card>

            {/* Canvas */}
            <div ref={wrapRef} className="border-app surface-2 max-h-[75vh] overflow-auto rounded-xl border">
              <div
                ref={stageRef}
                role="application"
                aria-label={`${which === 'featured' ? 'Featured' : 'Body'} image canvas, 1920 by 1080`}
                className="relative select-none"
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
              </div>
            </div>
            <p className="text-muted text-xs">
              Drag to move · handles resize (Shift keeps the ratio) · top knob rotates (Shift: 15° steps) · arrows nudge 1 px (Shift: 10 px) · Delete removes · Ctrl+D duplicates · Ctrl+Z / Ctrl+Shift+Z undo/redo · Alt bypasses snapping. The canvas is an editing view; the preview on the right is the real output.
            </p>

            <Card title="Live preview" description="Drawn by the production renderer — exactly what the article pipeline produces." actions={<Button size="sm" onClick={() => void finalRender()}>Check final size</Button>}>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="relative">
                  {preview.url ? <img src={preview.url} alt="Rendered preview" className="border-app w-full rounded-lg border" /> : <div className="surface-2 aspect-video rounded-lg" />}
                  {preview.busy ? <span className="absolute right-2 top-2"><Chip>rendering…</Chip></span> : null}
                  {preview.error ? <div className="mt-2"><Alert tone="danger">{preview.error}</Alert></div> : null}
                  {finalInfo ? (
                    <div className="mt-3 space-y-2">
                      <Alert tone={finalInfo.over ? 'warning' : 'success'} title="Final output">{finalInfo.text}{finalInfo.over ? ' — over budget even at the lowest quality; simplify the design or raise the byte budget in Settings.' : ''}</Alert>
                      <a href={finalInfo.url} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 underline">Open the final file</a>
                    </div>
                  ) : null}
                </div>
                <PreviewControls data={data} photoIds={photoIds} setPhotoIds={setPhotoIds} title={previewTitle} setTitle={setPreviewTitle} />
              </div>
            </Card>
          </div>

          {/* Side panels */}
          <div className="space-y-4">
            <Card title="Template">
              <div className="space-y-3">
                <Field label="Name" htmlFor="tpl-name">
                  <Input id="tpl-name" value={template.name} maxLength={80} onChange={(e) => changeTemplate((t) => ({ ...t, name: e.target.value }), 'tpl:name')} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Accent color" htmlFor="tpl-accent">
                    <input id="tpl-accent" type="color" value={template.accent} onChange={(e) => change((s) => ({ ...s, featured: { ...s.featured, accent: e.target.value }, body: s.body ? { ...s.body, accent: e.target.value } : null }), 'tpl:accent')} className="border-app h-9 w-full cursor-pointer rounded-lg border" />
                  </Field>
                  <ColorField id="tpl-bg" label="Background" value={template.background} accent={template.accent} onChange={(v) => changeTemplate((t) => ({ ...t, background: v ?? '#111827' }), 'tpl:bg')} />
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Presets</p>
                  <div className="flex flex-wrap gap-2">
                    {which === 'featured' ? (
                      <>
                        <Button size="sm" onClick={() => change((s) => ({ ...s, featured: presetSingle(s.featured.accent) }))}>Single photo · corner logo</Button>
                        <Button size="sm" onClick={() => change((s) => ({ ...s, featured: presetSplit(s.featured.accent) }))}>Split photo · center logo</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" onClick={() => change((s) => ({ ...s, body: presetBodyCornerLogo(s.featured.accent) }))}>Photo with corner logo</Button>
                        <Button size="sm" onClick={() => change((s) => ({ ...s, body: null }))}>Back to clean photo</Button>
                      </>
                    )}
                  </div>
                  <p className="text-muted mt-1.5 text-xs">A preset replaces this template (undo brings it back).</p>
                </div>
              </div>
            </Card>

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
                <LayerProperties layer={selectedLayer} accent={template.accent} fixedPhotos={fixedPhotos} onPatch={(patch, key) => patchLayer(selectedLayer.id, patch, key ? `${selectedLayer.id}:${key}` : null)} />
              </Card>
            ) : null}

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
        onImport={(t, notes) => {
          const fixed = normalizeImported(t, assetIds, notes);
          changeTemplate(() => ({ ...fixed, accent: template?.accent ?? fixed.accent }));
          setSelected(null);
          setImportOpen(false);
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

function PreviewControls({ data, photoIds, setPhotoIds, title, setTitle, hideTitle }: { data: Data; photoIds: [string, string]; setPhotoIds: (v: [string, string]) => void; title: string; setTitle: (v: string) => void; hideTitle?: boolean }) {
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

function LayerVisual({ layer: l, template, scale, vars, photoUrl, logoUrl }: { layer: Layer; template: ImageTemplate; scale: number; vars: Record<string, string>; photoUrl: (slot: number) => string | null; logoUrl: string | null }) {
  const accent = template.accent;
  switch (l.type) {
    case 'photo': {
      const url = photoUrl(l.slot);
      return url ? (
        <img src={url} alt="" draggable={false} className="h-full w-full object-cover" style={{ borderRadius: l.radius * scale, objectPosition: l.focus === 'top' ? 'top' : 'center' }} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-white/80" style={{ borderRadius: l.radius * scale, background: l.slot ? 'linear-gradient(135deg,#f97316,#7c2d12)' : 'linear-gradient(135deg,#0ea5e9,#1e3a8a)', fontSize: Math.max(10, 48 * scale) }}>
          Photo {l.slot + 1}
        </div>
      );
    }
    case 'fixed-photo':
      return l.assetId ? <img src={`/api/media/${l.assetId}`} alt="" draggable={false} className="h-full w-full object-cover" style={{ borderRadius: l.radius * scale }} /> : <div className="h-full w-full bg-slate-400/60" />;
    case 'logo':
      return (
        <div className="flex h-full w-full items-center justify-center" style={l.plate ? { background: resolve(l.plateColor, accent), borderRadius: l.plateRadius * scale, padding: l.platePadding * scale } : undefined}>
          {logoUrl ? <img src={logoUrl} alt="" draggable={false} className="max-h-full max-w-full object-contain" /> : <span className="rounded border border-dashed border-current px-1 text-center text-slate-500" style={{ fontSize: Math.max(9, 28 * scale) }}>Logo</span>}
        </div>
      );
    case 'text': {
      const text = fill(l.text, vars);
      return (
        <div
          className="h-full w-full overflow-hidden"
          style={{
            fontFamily: FONTS[l.fontFamily],
            fontSize: l.fontSize * scale,
            fontWeight: l.fontWeight,
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
    case 'svg': {
      const safe = sanitizeSvg(l.svg);
      return safe ? <img src={svgUrl(safe)} alt="" draggable={false} className="h-full w-full object-contain" /> : <div className="h-full w-full border border-dashed border-rose-400" />;
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
        <input type="color" aria-label={`${label} picker`} value={swatch} onChange={(e) => onChange(e.target.value)} className={cx('border-app h-8 w-9 shrink-0 cursor-pointer rounded border', !value || value === 'transparent' || (value !== 'accent' && !/^#[0-9a-fA-F]{6}$/.test(value)) ? 'opacity-30' : '')} />
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
        <button type="button" className="text-indigo-600 underline" onClick={() => onChange('accent')}>accent</button>
        {nullable ? <button type="button" className="text-indigo-600 underline" onClick={() => onChange(null)}>none</button> : <button type="button" className="text-indigo-600 underline" onClick={() => onChange('transparent')}>transparent</button>}
      </div>
    </Field>
  );
}

function LayerProperties({ layer: l, accent, fixedPhotos, onPatch }: { layer: Layer; accent: string; fixedPhotos: Asset[]; onPatch: (patch: Record<string, unknown>, key?: string) => void }) {
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
          {num('radius', 'Corner radius', l.radius, 0, 540)}
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

      {l.type === 'text' ? (
        <div className="space-y-2">
          <Field label="Text" htmlFor={id('text')} help="Tokens: {{title}}, {{site}}, {{keyword}}">
            <Textarea id={id('text')} rows={2} value={l.text} maxLength={400} onChange={(e) => onPatch({ text: e.target.value }, 'text')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Font" htmlFor={id('font')}>
              <Select id={id('font')} value={l.fontFamily} onChange={(e) => onPatch({ fontFamily: e.target.value })} className="px-2 py-1.5">
                <option value="sans">Sans</option>
                <option value="serif">Serif</option>
                <option value="condensed">Condensed</option>
                <option value="mono">Mono</option>
              </Select>
            </Field>
            <Field label="Weight" htmlFor={id('weight')}>
              <Select id={id('weight')} value={l.fontWeight} onChange={(e) => onPatch({ fontWeight: Number(e.target.value) })} className="px-2 py-1.5">
                <option value={400}>Regular</option>
                <option value={600}>Semibold</option>
                <option value={700}>Bold</option>
                <option value={800}>Extra bold</option>
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

function ImportDialog({ open, onCancel, onImport }: { open: boolean; onCancel: () => void; onImport: (t: ImageTemplate, notes: string[]) => void }) {
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
      return onImport(parsed.data, []);
    }
    const r = importForeignTemplate(raw);
    onImport(r.template, r.notes);
  }
  return (
    <ConfirmDialog open={open} title="Import a template" confirmLabel="Import" onCancel={onCancel} onConfirm={run}>
      <p className="mb-2">Paste a template exported here, or a Polotno-style design (pages are scaled proportionally into 1920×1080). Image URLs are never fetched — images become photo slots. SVG is sanitized; nothing in the file is executed.</p>
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
