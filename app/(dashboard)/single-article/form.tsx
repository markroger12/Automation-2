'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, RotateCcw, Sparkles, X } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { PRESET_COUNTRIES } from '@/lib/domain';
import { Button, ConfirmDialog, CopyButton, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, cx } from '@/components/ui';

export interface SiteOption {
  id: string;
  name: string;
  language: 'en' | 'de';
  targetCountry: string;
  session: string;
  paused: boolean;
  defaultCategoryId: string | null;
  categories: { id: string; name: string }[];
}

interface Writer {
  key: string;
  name: string;
  description: string;
  highlights: string[];
  exampleTitle: 'always' | 'if-template-variable';
}

type Tri = '' | 'on' | 'off';

interface FormState {
  moduleKey: string;
  keyword: string;
  secondaryKeywords: string;
  exampleTitle: string;
  websiteId: string;
  categoryId: string;
  language: '' | 'en' | 'de';
  country: string;
  customCountry: boolean;
  maxWords: string;
  faqCount: string;
  quickBioRows: string;
  images: 'site' | 'on' | 'off';
  manualTitleApproval: Tri;
  manualArticleApproval: Tri;
  reviewThreshold: string;
  rankMathTargetScore: string;
  externalLinks: Tri;
  internalLinks: Tri;
  saveToWordPress: boolean;
}

const EMPTY: FormState = {
  moduleKey: '',
  keyword: '',
  secondaryKeywords: '',
  exampleTitle: '',
  websiteId: '',
  categoryId: '',
  language: '',
  country: '',
  customCountry: false,
  maxWords: '',
  faqCount: '',
  quickBioRows: '',
  images: 'site',
  manualTitleApproval: '',
  manualArticleApproval: '',
  reviewThreshold: '',
  rankMathTargetScore: '',
  externalLinks: '',
  internalLinks: '',
  saveToWordPress: true,
};

const DRAFT_KEY = 'bas:single-article:draft';
const REMEMBER_KEY = 'bas:single-article:remember';

function parseSecondary(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\n,;]+/)) {
    const v = part.replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

const tri = (v: Tri): boolean | undefined => (v === '' ? undefined : v === 'on');
const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

interface Preview {
  stageKey: string;
  name: string;
  version: string;
  customized: boolean;
  kind: string;
  text: string;
  missing: string[];
  unavailable: string[];
  notes: string[];
}

export function SingleArticleForm({
  sites,
  writers,
  defaults,
  health,
}: {
  sites: SiteOption[];
  writers: Writer[];
  defaults: { maxWords: number; faqCount: number; tigramFaqCount: number; quickBioRows: number; reviewThreshold: number; rankMathTargetScore: number };
  health: { worker: string; extension: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [preview, setPreview] = useState<{ previews: Preview[]; notes: string[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const submissionKey = useRef<string | null>(null);

  // Restore the autosaved draft (values survive a refresh) or remembered defaults.
  useEffect(() => {
    let next = { ...EMPTY };
    try {
      const remembered = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}') as Partial<FormState>;
      next = { ...next, ...remembered };
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as Partial<FormState> | null;
      if (draft) next = { ...next, ...draft };
    } catch {
      /* storage unavailable */
    }
    if (!next.moduleKey || !writers.some((w) => w.key === next.moduleKey)) next.moduleKey = writers[0]?.key ?? '';
    if (next.websiteId && !sites.some((s) => s.id === next.websiteId)) next.websiteId = '';
    if (!next.websiteId && sites.length === 1) next.websiteId = sites[0].id;
    setForm(next);
    setLoaded(true);
  }, [sites, writers]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
    } catch {
      /* ignore */
    }
  }, [form, loaded]);

  const site = sites.find((s) => s.id === form.websiteId) ?? null;
  const writer = writers.find((w) => w.key === form.moduleKey) ?? null;
  const secondary = useMemo(() => parseSecondary(form.secondaryKeywords), [form.secondaryKeywords]);
  const dirty = Boolean(form.keyword || form.secondaryKeywords || form.exampleTitle);
  const effectiveLanguage = form.language || site?.language || 'en';

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      const { [key as string]: _, ...rest } = e;
      return rest;
    });
    submissionKey.current = null;
  };

  // When the website changes: preselect its default category, language and country.
  function chooseSite(id: string) {
    const s = sites.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      websiteId: id,
      categoryId: s?.defaultCategoryId ?? '',
      language: '',
      country: '',
      customCountry: false,
    }));
    setErrors({});
    submissionKey.current = null;
  }

  function payload() {
    const country = form.country.trim();
    return {
      moduleKey: form.moduleKey,
      keyword: form.keyword,
      secondaryKeywords: form.secondaryKeywords,
      exampleTitle: form.exampleTitle,
      websiteId: form.websiteId,
      categoryId: form.categoryId || null,
      language: form.language || null,
      targetCountry: country || null,
      options: {
        maxWords: num(form.maxWords),
        faqCount: num(form.faqCount),
        quickBioRows: num(form.quickBioRows),
        images: form.images,
        manualTitleApproval: tri(form.manualTitleApproval),
        manualArticleApproval: tri(form.manualArticleApproval),
        reviewThreshold: num(form.reviewThreshold),
        rankMathTargetScore: num(form.rankMathTargetScore),
        externalLinks: tri(form.externalLinks),
        internalLinks: tri(form.internalLinks),
        saveToWordPress: form.saveToWordPress,
      },
    };
  }

  function validate(): boolean {
    const e: Record<string, string[]> = {};
    if (!form.moduleKey) e.moduleKey = ['Choose a writer'];
    if (form.keyword.trim().length < 2) e.keyword = ['Primary keyword is required (at least 2 characters)'];
    if (form.keyword.trim().length > 160) e.keyword = ['Primary keyword must be at most 160 characters'];
    if (!form.websiteId) e.websiteId = ['Choose a website'];
    if (form.moduleKey === 'celebrity-writer' && site && !form.categoryId && site.categories.length > 0) e.categoryId = ['Choose a category'];
    if (form.moduleKey === 'celebrity-writer' && site && site.categories.length === 0) e.categoryId = ['Sync categories for this website first'];
    if (form.exampleTitle.length > 200) e.exampleTitle = ['At most 200 characters'];
    if (secondary.length > 20) e.secondaryKeywords = ['At most 20 secondary keywords'];
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function generate(ev?: React.FormEvent) {
    ev?.preventDefault();
    if (submitting) return;
    if (!validate()) {
      toast('error', 'Please fix the highlighted fields.');
      return;
    }
    setSubmitting(true);
    submissionKey.current ??= `single:${crypto.randomUUID()}`;
    try {
      const res = await api<{ task: { id: string }; created: boolean; warnings: string[] }>('/api/tasks', { body: { ...payload(), idempotencyKey: submissionKey.current } });
      try {
        localStorage.setItem(REMEMBER_KEY, JSON.stringify({ moduleKey: form.moduleKey, websiteId: form.websiteId, categoryId: form.categoryId, language: form.language, country: form.country, customCountry: form.customCountry }));
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      toast('success', res.created ? 'Article queued.' : 'This submission was already queued — opening it.');
      for (const w of res.warnings) toast('info', w);
      router.push(`/articles/${res.task.id}`);
    } catch (error) {
      submissionKey.current = null;
      if (error instanceof ApiClientError && error.fieldErrors) setErrors(error.fieldErrors);
      toast('error', (error as Error).message);
      setSubmitting(false);
    }
  }

  async function showPreview() {
    setPreviewing(true);
    try {
      setPreview(await api<{ previews: Preview[]; notes: string[] }>('/api/prompts/preview', { body: payload() }));
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  function reset() {
    const remembered = { moduleKey: form.moduleKey, websiteId: form.websiteId, categoryId: form.categoryId, language: form.language, country: form.country, customCountry: form.customCountry };
    setForm({ ...EMPTY, ...remembered });
    setErrors({});
    submissionKey.current = null;
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    setConfirmReset(false);
  }

  if (!loaded) return <div className="surface-2 h-96 animate-pulse rounded-xl" aria-busy="true" />;

  if (sites.length === 0) {
    return (
      <Alert tone="warning" title="No WordPress website configured" action={<Link className="font-semibold underline" href="/websites?add=1">Add website</Link>}>
        A Single Article needs a destination website. Add one, log in once and sync its categories.
      </Alert>
    );
  }

  const presets = PRESET_COUNTRIES as readonly string[];
  const countryValue = form.customCountry ? '__custom' : form.country;

  return (
    <form onSubmit={generate} className="grid gap-6 xl:grid-cols-3" noValidate>
      <div className="space-y-6 xl:col-span-2">
        <Card title="Article Writer" description="Exactly two active writers. Your last choice is remembered.">
          <div role="radiogroup" aria-label="Article writer" className="grid gap-3 md:grid-cols-2">
            {writers.map((w) => (
              <label
                key={w.key}
                className={cx(
                  'cursor-pointer rounded-xl border p-4 transition',
                  form.moduleKey === w.key ? 'border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-200 dark:bg-indigo-950/40 dark:ring-indigo-900' : 'border-app hover:border-indigo-300',
                )}
              >
                <input type="radio" name="moduleKey" value={w.key} checked={form.moduleKey === w.key} onChange={() => set('moduleKey', w.key)} className="sr-only" />
                <div className="font-semibold">{w.name}</div>
                <p className="text-muted mt-1 text-xs">{w.description}</p>
              </label>
            ))}
          </div>
          {errors.moduleKey ? <p className="mt-2 text-xs font-medium text-rose-600">{errors.moduleKey[0]}</p> : null}
        </Card>

        <Card title="Keywords & guidance">
          <div className="space-y-4">
            <Field label="Primary Keyword" htmlFor="sa-keyword" required error={errors.keyword} help={`One keyword or phrase, e.g. “Tom Kaulitz Heidi Klum”. Spelling and capitalization are kept. ${form.keyword.trim().length}/160`}>
              <Input id="sa-keyword" value={form.keyword} onChange={(e) => set('keyword', e.target.value)} placeholder="Tom Kaulitz Heidi Klum" autoFocus invalid={Boolean(errors.keyword)} aria-describedby="sa-keyword-help" />
            </Field>
            <Field label="Secondary Keywords" htmlFor="sa-secondary" error={errors.secondaryKeywords} help="Optional. One per line or comma-separated. Order is kept; duplicates are removed.">
              <Textarea id="sa-secondary" rows={3} value={form.secondaryKeywords} onChange={(e) => set('secondaryKeywords', e.target.value)} placeholder={'Tokio Hotel\nGermany’s Next Topmodel\nwedding'} />
              {secondary.length ? (
                <div className="flex flex-wrap gap-1.5 pt-1" aria-label="Parsed secondary keywords">
                  {secondary.map((k, i) => (
                    <Chip key={k} tone="brand">
                      {i + 1}. {k}
                    </Chip>
                  ))}
                </div>
              ) : null}
            </Field>
            <Field
              label="Example Article Title"
              htmlFor="sa-example"
              error={errors.exampleTitle}
              help={
                writer?.exampleTitle === 'if-template-variable'
                  ? 'Guidance only — final title will be generated/approved. Tigram uses it only if the saved ARTICLE template contains {{example_title}} (Preview Prompts shows whether it is used).'
                  : 'Guidance only — final title will be generated/approved. Used in the TITLES prompt.'
              }
            >
              <Input id="sa-example" value={form.exampleTitle} onChange={(e) => set('exampleTitle', e.target.value)} placeholder="Tom Kaulitz and Heidi Klum: Their Love Story" />
            </Field>
          </div>
        </Card>

        <Card title="Destination">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Website" htmlFor="sa-site" required error={errors.websiteId}>
              <Select id="sa-site" value={form.websiteId} onChange={(e) => chooseSite(e.target.value)} invalid={Boolean(errors.websiteId)}>
                <option value="">Choose a website…</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.language === 'de' ? 'German' : 'English'} · {s.session === 'ACTIVE' ? 'session active' : s.session === 'LOGIN_REQUIRED' ? 'login required' : 'session unknown'}
                    {s.paused ? ' · paused' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Category"
              htmlFor="sa-category"
              required={form.moduleKey === 'celebrity-writer'}
              error={errors.categoryId}
              help={form.moduleKey === 'tigram-writer' ? 'Optional for Tigram: leave empty to let the CATEGORY stage pick one existing category.' : 'Real categories synchronized from WordPress.'}
            >
              <Select id="sa-category" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} disabled={!site || site.categories.length === 0} invalid={Boolean(errors.categoryId)}>
                <option value="">{site && site.categories.length === 0 ? 'No categories synced yet' : form.moduleKey === 'tigram-writer' ? 'Let the CATEGORY stage choose' : 'Choose a category…'}</option>
                {site?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.id === site.defaultCategoryId ? ' (site default)' : ''}
                  </option>
                ))}
              </Select>
              {site && site.categories.length === 0 ? (
                <Link className="text-xs font-semibold text-indigo-600 underline" href={`/websites/${site.id}`}>
                  Sync categories for {site.name} →
                </Link>
              ) : null}
            </Field>
            <Field label="Language" htmlFor="sa-lang" help={site ? `Site default: ${site.language === 'de' ? 'German' : 'English'}` : undefined}>
              <Select id="sa-lang" value={form.language} onChange={(e) => set('language', e.target.value as FormState['language'])}>
                <option value="">Site default{site ? ` (${site.language === 'de' ? 'German' : 'English'})` : ''}</option>
                <option value="en">English</option>
                <option value="de">German</option>
              </Select>
            </Field>
            <Field label="Target Country" htmlFor="sa-country" error={errors.targetCountry} help={site ? `Site default: ${site.targetCountry}` : undefined}>
              <div className="flex gap-2">
                <Select
                  id="sa-country"
                  value={countryValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({ ...f, customCountry: v === '__custom', country: v === '__custom' ? '' : v }));
                  }}
                >
                  <option value="">Site default{site ? ` (${site.targetCountry})` : ''}</option>
                  {presets.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="__custom">Custom…</option>
                </Select>
                {form.customCountry ? <Input aria-label="Custom country" value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="Austria" /> : null}
              </div>
            </Field>
          </div>
        </Card>

        <details className="surface rounded-xl border">
          <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold">Advanced options</summary>
          <div className="border-app grid gap-4 border-t p-5 md:grid-cols-3">
            {form.moduleKey === 'celebrity-writer' ? (
              <Field label="Final word-count limit" htmlFor="sa-words" help={`Default ${defaults.maxWords}`}>
                <Input id="sa-words" type="number" min={300} max={5000} value={form.maxWords} onChange={(e) => set('maxWords', e.target.value)} placeholder={String(defaults.maxWords)} />
              </Field>
            ) : null}
            <Field label="FAQ count" htmlFor="sa-faq" help={`Default ${form.moduleKey === 'tigram-writer' ? defaults.tigramFaqCount : defaults.faqCount}`}>
              <Input id="sa-faq" type="number" min={1} max={15} value={form.faqCount} onChange={(e) => set('faqCount', e.target.value)} placeholder={String(form.moduleKey === 'tigram-writer' ? defaults.tigramFaqCount : defaults.faqCount)} />
            </Field>
            {form.moduleKey === 'celebrity-writer' ? (
              <Field label="Quick Bio rows" htmlFor="sa-bio" help={`Default ${defaults.quickBioRows}`}>
                <Input id="sa-bio" type="number" min={6} max={20} value={form.quickBioRows} onChange={(e) => set('quickBioRows', e.target.value)} placeholder={String(defaults.quickBioRows)} />
              </Field>
            ) : null}
            <Field label="Images" htmlFor="sa-images">
              <Select id="sa-images" value={form.images} onChange={(e) => set('images', e.target.value as FormState['images'])}>
                <option value="site">Site default</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            </Field>
            {(
              [
                ['manualTitleApproval', 'Manual title approval'],
                ['manualArticleApproval', 'Manual article approval'],
                ['externalLinks', 'External links'],
                ['internalLinks', 'Internal links'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label} htmlFor={`sa-${key}`}>
                <Select id={`sa-${key}`} value={form[key]} onChange={(e) => set(key, e.target.value as Tri)}>
                  <option value="">Site / global default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
            ))}
            <Field label="SEO review threshold" htmlFor="sa-rt" help={`Default ${defaults.reviewThreshold}`}>
              <Input id="sa-rt" type="number" min={0} max={100} value={form.reviewThreshold} onChange={(e) => set('reviewThreshold', e.target.value)} placeholder={String(defaults.reviewThreshold)} />
            </Field>
            <Field label="Rank Math target" htmlFor="sa-rm" help={`Default ${defaults.rankMathTargetScore}`}>
              <Input id="sa-rm" type="number" min={0} max={100} value={form.rankMathTargetScore} onChange={(e) => set('rankMathTargetScore', e.target.value)} placeholder={String(defaults.rankMathTargetScore)} />
            </Field>
            <Checkbox className="md:col-span-3" label="Save to WordPress as a draft" help="Always a draft. Publishing is only possible through the per-site scheduler." checked={form.saveToWordPress} onChange={(e) => set('saveToWordPress', e.target.checked)} />
          </div>
        </details>
      </div>

      <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        <Card title="Generate">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted">Writer</span>
              <span className="text-right font-medium">{writer?.name ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted">Website</span>
              <span className="text-right">{site?.name ?? '—'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted">Language</span>
              <span>{effectiveLanguage === 'de' ? 'German' : 'English'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted">Secondary keywords</span>
              <span>{secondary.length}</span>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
              <Sparkles className="h-4 w-4" /> Generate Article
            </Button>
            <Button onClick={() => void showPreview()} loading={previewing}>
              <Eye className="h-4 w-4" /> Preview Prompts
            </Button>
            <Button variant="ghost" onClick={() => (dirty ? setConfirmReset(true) : reset())}>
              <RotateCcw className="h-4 w-4" /> Reset Form
            </Button>
          </div>
          <p className="text-muted mt-3 text-[11px]">The form autosaves in this browser, so a page refresh keeps your values. Reset never deletes queued or finished articles.</p>
        </Card>
        {health.worker !== 'online' ? (
          <Alert tone="danger" title="Worker not running">
            Start <code>npm run dev:all</code>. You can still queue; nothing is lost.
          </Alert>
        ) : null}
        {health.extension !== 'connected' ? (
          <Alert tone="warning" title="ChatGPT extension not connected" action={<Link className="font-semibold underline" href="/automation-chrome">Set up</Link>}>
            ChatGPT stages wait until Automation Chrome is running with the paired extension.
          </Alert>
        ) : null}
        {site && site.session !== 'ACTIVE' ? (
          <Alert tone="warning" title={`${site.name}: WordPress session ${site.session === 'LOGIN_REQUIRED' ? 'needs login' : 'not verified'}`} action={<Link className="font-semibold underline" href={`/websites/${site.id}`}>Log in</Link>}>
            Writing can start now; the draft step waits for a valid login.
          </Alert>
        ) : null}
        {site?.paused ? <Alert tone="warning" title="This website is paused">Tasks for it stay queued until it is unpaused.</Alert> : null}
      </div>

      <ConfirmDialog open={confirmReset} title="Reset the form?" confirmLabel="Reset form" onCancel={() => setConfirmReset(false)} onConfirm={reset}>
        Your unsaved keyword, secondary keywords and example title will be cleared. Queued and completed articles are not affected.
      </ConfirmDialog>

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" role="dialog" aria-modal="true" aria-label="Prompt preview">
          <div className="surface w-full max-w-4xl rounded-xl border shadow-2xl">
            <div className="border-app flex items-center justify-between border-b px-5 py-3">
              <div>
                <h2 className="font-semibold">Prompt preview — current saved templates</h2>
                <p className="text-muted text-xs">Exactly what would be sent. Values produced by earlier stages are labelled ⟦…⟧ — never invented.</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)} aria-label="Close preview">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4 p-5">
              {preview.notes.map((n, i) => (
                <Alert key={i} tone="info">
                  {n}
                </Alert>
              ))}
              {preview.previews.map((p) => (
                <section key={p.stageKey} className="border-app rounded-lg border">
                  <header className="border-app flex flex-wrap items-center gap-2 border-b px-3 py-2">
                    <code className="text-xs font-semibold">{p.stageKey}</code>
                    <span className="text-sm">{p.name}</span>
                    <Chip>{p.version}</Chip>
                    {p.customized ? <Chip tone="brand">customized</Chip> : <Chip>default</Chip>}
                    {p.missing.length ? <Chip tone="danger">missing: {p.missing.join(', ')}</Chip> : null}
                    {p.unavailable.length ? <Chip tone="warning">later: {p.unavailable.join(', ')}</Chip> : null}
                    <span className="ml-auto">
                      <CopyButton text={p.text} />
                    </span>
                  </header>
                  {p.notes.map((n, i) => (
                    <p key={i} className="border-app border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                      {n}
                    </p>
                  ))}
                  <pre className="max-h-72 overflow-auto p-3 text-xs whitespace-pre-wrap">{p.text}</pre>
                </section>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
