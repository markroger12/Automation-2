'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, FileText, Plus, Sparkles, User, Wand2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, Modal, useToast } from '@/components/client';
import { Field, Input, Textarea } from '@/components/form';
import { cx } from '@/components/ui';

export interface StartOption {
  id: string;
  title: string;
  kind: 'person' | 'general';
  text: string;
}

/** Where a new writer can start (built-in writers first; the owner's own writers are added by the page). */
export const BUILT_IN_STARTS: StartOption[] = [
  { id: 'celebrity2-writer', title: 'Celebrity 2', kind: 'person', text: 'One prompt writes the whole person article (Family Profile table, five FAQs). Its prompt is copied — change what you like.' },
  { id: 'blank-person', title: 'Empty person writer', kind: 'person', text: 'A short starting prompt for articles about a person: facts table, sections, FAQs. Replace it with yours.' },
  { id: 'tigram-writer', title: 'Tigram', kind: 'general', text: 'General topics (how-to, reviews, guides) with generated images. Its prompt is copied; the title comes from the article.' },
  { id: 'blank-general', title: 'Empty general writer', kind: 'general', text: 'A short starting prompt for any topic. Replace it with yours.' },
  { id: 'celebrity-writer', title: 'Celebrity', kind: 'person', text: 'The Celebrity writer works in several steps; your copy writes the whole article in one answer to your prompt.' },
];

/**
 * Writers → New writer (owner request: add a writer without asking for code). A name and where to start; the writer is
 * created as a draft and its page opens, where the prompt, the rules and a test with a real ChatGPT answer follow.
 */
export function NewWriterButton({ own, initial, label = 'New writer', variant = 'primary', size = 'md' }: { own: StartOption[]; initial?: string; label?: string; variant?: 'primary' | 'secondary'; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {initial ? <Copy className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />} {label}
      </Button>
      {open ? <NewWriterDialog own={own} initial={initial} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NewWriterDialog({ own, initial, onClose }: { own: StartOption[]; initial?: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [description, setDescription] = useState('');
  const [startFrom, setStartFrom] = useState(initial ?? 'celebrity2-writer');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const options = [...BUILT_IN_STARTS, ...own];

  async function create() {
    if (name.trim().length < 2) {
      setErrors({ name: ['Give the writer a name (at least 2 characters).'] });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const res = await api<{ writer: { key: string } }>('/api/writers', { body: { name: name.trim(), shortName: shortName.trim() || undefined, description: description.trim() || undefined, startFrom } });
      toast('success', `“${name.trim()}” created as a draft. Add your prompt, test it, then make it active.`);
      router.push(`/writers/${res.writer.key}`);
    } catch (error) {
      const e = error as Error & { fieldErrors?: Record<string, string[]> };
      if (e.fieldErrors) setErrors(e.fieldErrors);
      toast('error', e.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      title="New writer"
      description="Your own writer with your own prompt. It starts as a draft: nothing uses it until you make it active."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create}>
            <Wand2 className="h-4 w-4" /> Create and open
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Name" htmlFor="nw-name" required error={errors.name} help="Shown in every writer list, e.g. “Celebrity Family” or “Tech Guides”.">
          <Input id="nw-name" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} placeholder="e.g. Celebrity Family" invalid={Boolean(errors.name)} />
        </Field>
        <Field label="Short name" htmlFor="nw-short" help="For tables (optional).">
          <Input id="nw-short" value={shortName} maxLength={24} onChange={(e) => setShortName(e.target.value)} placeholder={name.trim().slice(0, 24) || 'Same as the name'} />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-2 block text-sm font-medium">Start from</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          {options.map((o) => (
            <label key={o.id} className={cx('flex cursor-pointer gap-3 rounded-lg border p-3 transition', startFrom === o.id ? 'border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-200 dark:bg-indigo-950/40 dark:ring-indigo-900' : 'border-app hover:border-indigo-300')}>
              <input type="radio" name="nw-start" value={o.id} checked={startFrom === o.id} onChange={() => setStartFrom(o.id)} className="sr-only" />
              <span className={cx('mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md', o.kind === 'person' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300')} aria-hidden>
                {o.id.startsWith('custom-') ? <Copy className="h-4 w-4" /> : o.id.startsWith('blank') ? <FileText className="h-4 w-4" /> : o.kind === 'person' ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {o.title} <span className="text-muted text-xs font-normal">· {o.kind === 'person' ? 'about a person' : 'any topic'}</span>
                </span>
                <span className="text-muted block text-xs">{o.text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Description" htmlFor="nw-desc" help="Optional: what this writer is for.">
        <Textarea id="nw-desc" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}
