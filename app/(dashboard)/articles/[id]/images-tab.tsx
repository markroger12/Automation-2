'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { ImagePlus, LayoutTemplate, RefreshCcw, Trash2 } from 'lucide-react';
import { api, upload } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Alert, Card, Chip, EmptyState, StatusChip, buttonClasses } from '@/components/ui';

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

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f);
    setUploading(true);
    try {
      const res = await upload<{ added: string[]; skipped: string[] }>(`/api/tasks/${task.id}/images`, form);
      toast(res.skipped.length ? 'info' : 'success', `${res.added.length} photo(s) added.${res.skipped.length ? ` Skipped: ${res.skipped.join('; ')}` : ''} ${applyHint}`);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

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
        {data?.notes.length ? (
          <ul className="text-muted mt-3 list-disc space-y-0.5 pl-5 text-sm">
            {data.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
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
            <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void onFiles(e.target.files)} />
            <Button size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
              <ImagePlus className="h-4 w-4" /> Upload photos
            </Button>
          </>
        }
      >
        {uploads.length ? (
          <PhotoGrid items={uploads.map((u) => ({ id: u.id, title: u.notes ?? 'Upload', sub: `${u.width}×${u.height}`, used: usedIds.has(u.id), sourceUrl: null }))} onRemove={remove} />
        ) : (
          <p className="text-muted text-sm">No uploads. Upload photos when the automatic search finds nothing usable, or to choose the exact photos yourself.</p>
        )}
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
