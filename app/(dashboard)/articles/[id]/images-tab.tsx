'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, ImagePlus, LayoutTemplate, RefreshCcw, Trash2 } from 'lucide-react';
import { api, upload } from '@/lib/client/api';
import { MAX_PHOTOS_AT_ONCE, PHOTO_TYPES, pickPhotos } from '@/lib/client/image-input';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Alert, Card, Chip, EmptyState, StatusChip, buttonClasses, cx } from '@/components/ui';

interface ImagesData {
  slots: { slot: 'FEATURED' | 'BODY1' | 'BODY2'; mediaAssetId: string; alt: string; sourceAssetIds: string[]; width: number; height: number; bytes: number }[];
  gallery: { id: string; source: string; sourceUrl: string | null; title: string; used: boolean }[];
  plan?: { slot: string; direction: string; alt: string }[];
  notes: string[];
  warnings: string[];
}

const SLOT_LABEL: Record<string, string> = { FEATURED: 'Featured image', BODY1: 'Body image 1', BODY2: 'Body image 2' };

export function ImagesTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [regen, setRegen] = useState(false);
  const [busy, setBusy] = useState(false);
  const stage = task.stages.find((s) => s.key === 'IMAGES');
  const data = stage?.outputJson ? (JSON.parse(stage.outputJson) as ImagesData) : null;
  const assets = new Map(task.mediaAssets.map((m) => [m.id, m]));
  const uploads = task.mediaAssets.filter((m) => m.role === 'UPLOAD' && m.status !== 'REJECTED');
  const gallery = task.mediaAssets.filter((m) => m.role === 'GALLERY' && m.status !== 'REJECTED');
  const usedIds = new Set(data?.slots.flatMap((s) => s.sourceAssetIds) ?? []);
  const imagesOff = task.config && (task.config as { images?: boolean }).images === false;
  const running = task.group === 'queued' || task.group === 'running';
  // Before the Images step has run, uploads are simply used when it runs; afterwards a regeneration applies them.
  const ran = stage?.status === 'COMPLETED' || stage?.status === 'FAILED' || stage?.status === 'SKIPPED';
  const applyHint = ran ? 'Regenerate images to use them.' : 'They are used when the Images step runs.';

  // Owner request: besides the button, photos dropped anywhere on this tab or pasted with Ctrl+V are added too.
  const [dragging, setDragging] = useState(false);
  // One upload after another, so photos keep the order they were added in (it is their order in the article).
  const queue = useRef<Promise<void>>(Promise.resolve());

  function onFiles(list: File[], how: 'chosen' | 'dropped' | 'pasted') {
    const { photos, skipped } = pickPhotos(list, how);
    if (fileRef.current) fileRef.current.value = '';
    if (!photos.length) {
      if (skipped.length) toast('error', `No photo added. Skipped: ${skipped.join('; ')}`);
      return;
    }
    queue.current = queue.current.then(async () => {
      const form = new FormData();
      for (const f of photos) form.append('files', f);
      setUploading(true);
      try {
        const res = await upload<{ added: string[]; skipped: string[] }>(`/api/tasks/${task.id}/images`, form);
        const all = [...skipped, ...res.skipped];
        toast(all.length ? 'info' : 'success', `${res.added.length} photo(s) ${how === 'pasted' ? 'pasted' : how === 'dropped' ? 'dropped in' : 'added'}.${all.length ? ` Skipped: ${all.join('; ')}` : ''} ${applyHint}`);
        await onChanged();
      } catch (e) {
        toast('error', (e as Error).message);
      } finally {
        setUploading(false);
      }
    });
  }
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'));
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Without this the browser would open a photo dropped beside the box instead of adding it.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) {
        e.preventDefault();
        onFilesRef.current(files, 'dropped');
      } else if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('text/uri-list')) {
        // A picture dragged from another web page arrives as a link only.
        e.preventDefault();
        toast('info', 'That was a link to a picture, not the picture itself. Right-click the picture → Copy image, then press Ctrl+V here (or save it and drop the file).');
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      onFilesRef.current(files, 'pasted');
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [toast]);

  async function remove(id: string) {
    try {
      await api(`/api/tasks/${task.id}/images/${id}`, { method: 'DELETE' });
      toast('success', `This photo will not be used for this article.${ran ? ' Regenerate images to apply.' : ''}`);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/regenerate`, { body: { stageKey: 'IMAGES' } });
      toast('success', 'Images are being regenerated; the article is re-assembled and the same WordPress draft is updated.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setRegen(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Images"
        description={stage?.message ?? 'Featured image (site template) and two body images. Missing images are reported, never faked.'}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/image-templates?site=${task.websiteId}`} className={buttonClasses('secondary', 'sm')}>
              <LayoutTemplate className="h-4 w-4" /> Edit template
            </Link>
            <Button size="sm" onClick={() => setRegen(true)} disabled={running || !stage}>
              <RefreshCcw className="h-4 w-4" /> Regenerate images
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {stage ? <StatusChip status={stage.status} /> : <span className="text-muted">The Images step runs after the article text is written.</span>}
          {imagesOff ? <Chip tone="neutral">Images are off for this article</Chip> : null}
          {data ? <Chip tone={data.slots.length === 3 ? 'success' : 'warning'}>{data.slots.length} of 3 images</Chip> : null}
        </div>
        {data?.warnings.length ? (
          <div className="mt-3">
            <Alert tone="warning" title="Needs attention">
              <ul className="list-disc pl-5">{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </Alert>
          </div>
        ) : null}
        {data && !imagesOff ? (
          // Owner request (a cleaner page): which of the three images is there, at a glance.
          <ul className="mt-3 grid gap-2 sm:grid-cols-3" aria-label="Images">
            {(['FEATURED', 'BODY1', 'BODY2'] as const).map((slot) => {
              const ready = data.slots.find((x) => x.slot === slot);
              return (
                <li key={slot} className={cx('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', ready ? 'border-app' : 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30')}>
                  {ready ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <CircleDashed className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />}
                  <span className="font-medium">{SLOT_LABEL[slot]}</span>
                  <span className={cx('ml-auto text-xs', ready ? 'text-muted' : 'text-amber-800 dark:text-amber-300')}>{ready ? `${ready.width}×${ready.height}` : 'missing'}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {data?.notes.length ? (
          <details className="mt-3 text-sm">
            <summary className="text-muted cursor-pointer hover:text-[var(--text)]">How the images were made ({data.notes.length} steps)</summary>
            <ul className="text-muted mt-2 list-disc space-y-0.5 pl-5">
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      {data?.slots.length ? (
        <div className="grid gap-4 md:grid-cols-3">
          {data.slots.map((s) => {
            const a = assets.get(s.mediaAssetId);
            return (
              <Card key={s.slot} title={SLOT_LABEL[s.slot]} description={`${s.width}×${s.height} · ${(s.bytes / 1024).toFixed(0)} KB${a?.wpMediaId ? ` · WordPress media #${a.wpMediaId}` : ''}`}>
                <img src={`/api/media/${s.mediaAssetId}`} alt={s.alt} className="mb-2 w-full rounded" loading="lazy" />
                <p className="text-sm">
                  <span className="text-muted">Alt text:</span> {s.alt}
                </p>
              </Card>
            );
          })}
        </div>
      ) : stage ? (
        <Card>
          <EmptyState title="No rendered images yet" description={stage.status === 'SKIPPED' ? 'Images are switched off for this article or website.' : 'They appear after the Images stage runs.'} />
        </Card>
      ) : null}

      <Card
        title="Your photos"
        description="Uploaded photos are used before any searched or generated image (in upload order: featured, body 1, body 2). Max 12 MB each."
        actions={
          <>
            <input ref={fileRef} type="file" multiple accept={PHOTO_TYPES.join(',')} className="hidden" onChange={(e) => onFiles(Array.from(e.target.files ?? []), 'chosen')} />
            <Button size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
              <ImagePlus className="h-4 w-4" /> Upload photos
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {uploads.length ? <PhotoGrid items={uploads.map((u) => ({ id: u.id, title: u.notes ?? 'Upload', sub: `${u.width}×${u.height}`, used: usedIds.has(u.id), sourceUrl: null }))} onRemove={remove} /> : null}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Add photos: choose files, drop them here, or paste with Ctrl+V"
            className={cx(
              'flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 text-center text-sm transition',
              uploads.length ? 'py-5' : 'py-9',
              dragging ? 'border-[var(--text)] bg-[var(--surface-2)]' : 'border-app hover:bg-[var(--surface-2)]',
            )}
          >
            <ImagePlus className="text-muted h-6 w-6" aria-hidden />
            <span className="font-medium">{dragging ? 'Drop to add the photos' : 'Drop photos here, or paste one with Ctrl+V'}</span>
            <span className="text-muted text-xs">
              or click to choose files · PNG, JPEG, WebP or GIF · up to 12 MB each, {MAX_PHOTOS_AT_ONCE} at a time
              {uploads.length ? '' : ' · use this when the automatic search finds nothing usable, or to choose the exact photos yourself'}
            </span>
          </button>
        </div>
      </Card>

      {gallery.length ? (
        <Card title="Collected photos" description="Searched or generated source images. Source URLs are stored as technical provenance only.">
          <PhotoGrid
            items={gallery.map((g) => ({ id: g.id, title: (g.notes ?? g.origin).replace(/^File:/, ''), sub: `${g.origin === 'WIKIMEDIA' ? 'Wikimedia Commons' : g.origin === 'CHATGPT' ? 'ChatGPT image' : g.origin} · ${g.width}×${g.height}`, used: usedIds.has(g.id), sourceUrl: g.sourceUrl }))}
            onRemove={remove}
          />
        </Card>
      ) : null}

      {data?.plan?.length ? (
        <Card title="Image plan">
          <ul className="space-y-2 text-sm">
            {data.plan.map((p) => (
              <li key={p.slot}>
                <span className="font-medium">{SLOT_LABEL[p.slot] ?? p.slot}:</span> {p.direction} <span className="text-muted">· alt “{p.alt}”</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ConfirmDialog open={regen} title="Regenerate images?" confirmLabel="Regenerate" busy={busy} onCancel={() => setRegen(false)} onConfirm={() => void regenerate()}>
        Images are rendered again with your uploads and the current template, then the article is re-assembled and the same WordPress draft is updated.
        {task.editedHtml ? ' Your manual edits are kept in the revision history but the article is re-assembled from the generated text.' : ''}
        {task.moduleKey === 'tigram-writer' ? ' Slots without an uploaded image are generated again through ChatGPT.' : ''}
      </ConfirmDialog>
    </div>
  );
}

function PhotoGrid({ items, onRemove }: { items: { id: string; title: string; sub: string; used: boolean; sourceUrl: string | null }[]; onRemove: (id: string) => void }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((p) => (
        <li key={p.id} className="border-app overflow-hidden rounded-lg border">
          <img src={`/api/media/${p.id}`} alt="" className="aspect-video w-full object-cover" loading="lazy" />
          <div className="space-y-1 p-2 text-xs">
            <p className="truncate font-medium" title={p.title}>
              {p.title}
            </p>
            <p className="text-muted">{p.sub}</p>
            {p.sourceUrl ? (
              <p className="text-muted truncate" title={p.sourceUrl}>
                {p.sourceUrl.replace(/^https?:\/\//, '')}
              </p>
            ) : null}
            <div className="flex items-center justify-between">
              {p.used ? <Chip tone="success">used</Chip> : <span />}
              <button type="button" className="text-muted inline-flex items-center gap-1 hover:text-rose-600" onClick={() => onRemove(p.id)}>
                <Trash2 className="h-3.5 w-3.5" /> Don’t use
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
