'use client';

import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, FileJson, RefreshCw, Sparkles, Upload, User } from 'lucide-react';
import { api } from '@/lib/client/api';
import { MAX_WRITER_FILE_BYTES, type ImportAction, type ImportPreviewItem, type ImportResult } from '@/lib/writers/file-format';
import { Button, Modal, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select } from '@/components/form';
import { Alert, Chip, cx } from '@/components/ui';

/**
 * Writers → Import (owner request: “writer import export ka option add kr”). Choose a file made with Export; every writer
 * of the file is shown with what will happen (add as a new draft, update the same writer here, or skip) before
 * anything is saved.
 */
export function ImportWritersButton({ size = 'md', variant = 'secondary' }: { size?: 'sm' | 'md'; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)} tip="Add writers from a file made with Export (another PC, a backup)">
        <Upload className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> Import
      </Button>
      {open ? <ImportDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Choice = { action: ImportAction; name: string };

function ImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null);
  const [items, setItems] = useState<ImportPreviewItem[] | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [activate, setActivate] = useState(true);
  const [busy, setBusy] = useState<'read' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [dragging, setDragging] = useState(false);

  async function read(f: File | undefined) {
    if (!f) return;
    setError(null);
    setFieldErrors({});
    if (f.size > MAX_WRITER_FILE_BYTES) return setError(`“${f.name}” is larger than ${(MAX_WRITER_FILE_BYTES / 1_000_000).toFixed(1)} MB: it is not a writer file made with Export.`);
    let data: unknown;
    try {
      data = JSON.parse(await f.text());
    } catch {
      return setError(`“${f.name}” is not a writer file (it is not JSON). Choose a file made with Export.`);
    }
    setBusy('read');
    try {
      const res = await api<{ preview: ImportPreviewItem[] }>('/api/writers/import', { body: { file: data, fileName: f.name, preview: true } });
      setFile({ name: f.name, data });
      setItems(res.preview);
      setChoices(Object.fromEntries(res.preview.map((i) => [i.index, { action: i.defaultAction, name: i.suggestedName }])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void read(e.dataTransfer.files?.[0]);
  }

  const chosen = items?.filter((i) => (choices[i.index]?.action ?? 'skip') !== 'skip') ?? [];
  const activeInFile = chosen.some((i) => i.wasActive && choices[i.index]?.action === 'new');

  async function run() {
    if (!file || !items) return;
    setBusy('import');
    setFieldErrors({});
    try {
      const res = await api<ImportResult>('/api/writers/import', {
        body: { file: file.data, fileName: file.name, activate, choices: items.map((i) => ({ index: i.index, action: choices[i.index]?.action ?? 'skip', name: choices[i.index]?.action === 'new' ? choices[i.index]?.name.trim() || undefined : undefined })) },
      });
      const added = res.imported.filter((i) => i.action === 'new');
      const updated = res.imported.filter((i) => i.action === 'update');
      const drafts = added.filter((i) => i.status === 'DRAFT');
      const parts = [
        added.length ? `${added.length} writer${added.length === 1 ? '' : 's'} added (${added.map((i) => `“${i.name}”`).join(', ')})` : '',
        updated.length ? `${updated.length} updated (${updated.map((i) => `“${i.name}”`).join(', ')})` : '',
      ].filter(Boolean);
      const notes = res.imported.map((i) => i.note).filter(Boolean);
      toast(notes.length ? 'info' : 'success', `${parts.join('; ')}.${drafts.length ? ` New writers that are drafts: test them, then make them active.` : ''}${notes.length ? ` ${notes.join(' ')}` : ''}`);
      onClose();
      if (res.imported.length === 1) router.push(`/writers/${res.imported[0].key}`);
      router.refresh();
    } catch (e) {
      const err = e as Error & { fieldErrors?: Record<string, string[]> };
      if (err.fieldErrors) setFieldErrors(err.fieldErrors);
      toast('error', err.message);
      setBusy(null);
    }
  }

  const set = (index: number, patch: Partial<Choice>) => setChoices((c) => ({ ...c, [index]: { ...c[index], ...patch } }));

  return (
    <Modal
      open
      onClose={onClose}
      width={820}
      title="Import writers"
      description="From a file made with Export (on another PC, or a backup). You see every writer of the file before anything is saved; new writers start as drafts."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {items ? (
            <>
              <Button variant="secondary" onClick={() => input.current?.click()} loading={busy === 'read'}>
                <RefreshCw className="h-4 w-4" /> Another file
              </Button>
              <Button variant="primary" loading={busy === 'import'} disabled={!chosen.length} onClick={() => void run()}>
                <Upload className="h-4 w-4" /> {chosen.length ? `Import ${chosen.length} writer${chosen.length === 1 ? '' : 's'}` : 'Nothing to import'}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <input ref={input} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void read(e.target.files?.[0])} />
      {!items ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          disabled={busy === 'read'}
          className={cx('flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition', dragging ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40' : 'border-app hover:border-indigo-300')}
        >
          <FileJson className="text-muted h-8 w-8" aria-hidden />
          <span className="text-sm font-semibold">{busy === 'read' ? 'Reading the file…' : 'Choose a writer file, or drop it here'}</span>
          <span className="text-muted text-xs">A .json file made with Export — for example writer-celebrity-family.json or writers-2026-11-06.json</span>
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-muted text-xs">
            <span className="font-medium text-[var(--text)]">{file?.name}</span> · {items.length} writer{items.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-3">
            {items.map((item) => (
              <ImportRow key={item.index} item={item} choice={choices[item.index] ?? { action: 'skip', name: item.suggestedName }} onChange={(patch) => set(item.index, patch)} errors={fieldErrors[`choices.${item.index}`]} />
            ))}
          </ul>
          {activeInFile ? <Checkbox checked={activate} onChange={(e) => setActivate(e.target.checked)} label="Make the writers that are active in the file active here too" help="Each one only when its checklist is complete; the others stay drafts. Untick to keep every new writer a draft." /> : null}
        </div>
      )}
      {error ? (
        <Alert tone="danger" title="This file cannot be imported">
          {error}
        </Alert>
      ) : null}
    </Modal>
  );
}

function ImportRow({ item, choice, onChange, errors }: { item: ImportPreviewItem; choice: Choice; onChange: (patch: Partial<Choice>) => void; errors?: string[] }) {
  const m = item.match;
  const person = item.base === 'person';
  const id = `imp-${item.index}`;
  return (
    <li className={cx('rounded-lg border p-3', item.error ? 'border-rose-200 dark:border-rose-500/30' : choice.action === 'skip' ? 'border-app opacity-75' : 'border-app')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-lg', person ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300')} aria-hidden>
          {person ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1 basis-60">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{item.name}</span>
            {item.base ? <Chip>{person ? 'about a person' : 'any topic'}</Chip> : null}
            {item.wasActive ? <Chip tone="success">active in the file</Chip> : null}
          </p>
          {item.summary.length ? <p className="text-muted mt-0.5 text-xs">{item.summary.join(' · ')}</p> : null}
          {item.description ? <p className="text-muted mt-0.5 truncate text-xs">{item.description}</p> : null}
        </div>
        <div className="w-full sm:w-60">
          <label htmlFor={`${id}-action`} className="sr-only">
            What to do with {item.name}
          </label>
          <Select id={`${id}-action`} value={choice.action} disabled={Boolean(item.error)} onChange={(e) => onChange({ action: e.target.value as ImportAction })}>
            {m && !m.updateBlocked ? <option value="update">Update “{m.name}”</option> : null}
            {!item.error ? <option value="new">Add as a new writer</option> : null}
            <option value="skip">Skip</option>
          </Select>
        </div>
      </div>
      <div className="mt-2 space-y-2 pl-0 text-xs sm:pl-12">
        {item.error ? (
          <p className="flex items-start gap-1.5 font-medium text-rose-700 dark:text-rose-300">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Cannot be imported: {item.error}
          </p>
        ) : null}
        {m ? (
          <p className="text-muted">
            {m.promptChanged || m.settingsChanged
              ? `Your writer “${m.name}” (${m.status.toLowerCase()}) ${m.by === 'key' ? 'is the same writer' : 'has the same name'}; the file's ${[m.promptChanged ? 'prompt' : '', m.settingsChanged ? 'settings' : ''].filter(Boolean).join(' and ')} differ${m.promptChanged && m.settingsChanged ? '' : 's'}.`
              : `Same as your writer “${m.name}”: nothing to update.`}
            {m.updateBlocked ? ` Update is not possible now: ${m.updateBlocked}` : ''}
          </p>
        ) : null}
        {choice.action === 'update' && m ? <p className="text-muted">Its prompt becomes a new version (the old one stays under Versions); its rules and settings are replaced by the file's. Its name and status ({m.status.toLowerCase()}) stay.</p> : null}
        {choice.action === 'new' ? (
          <Field label="Name here" htmlFor={`${id}-name`} help={item.suggestedName.toLowerCase() !== item.name.toLowerCase() ? `“${item.name}” is already used here, so the new writer gets another name (change it if you like).` : 'Added as a new writer, with its prompts and settings from the file.'}>
            <Input id={`${id}-name`} value={choice.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} invalid={Boolean(errors?.length)} />
          </Field>
        ) : null}
        {item.warnings.length && choice.action !== 'skip' ? (
          <details>
            <summary className="cursor-pointer font-medium text-amber-700 dark:text-amber-300">
              {item.warnings.length} note{item.warnings.length === 1 ? '' : 's'} about its prompts
            </summary>
            <ul className="text-muted mt-1 list-disc space-y-0.5 pl-5">
              {item.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {errors?.length ? (
          <p className="font-medium text-rose-700 dark:text-rose-300" role="alert">
            {errors.join(' ')}
          </p>
        ) : null}
      </div>
    </li>
  );
}
