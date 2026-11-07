'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArrowLeft, CheckCircle2, Circle, CircleAlert, Download, Eye, FlaskConical, Image as ImageIcon, KeyRound, ListChecks, PenLine, Rocket, Save, Sparkles, Tags, Trash2, Type, Undo2, User, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { moduleDisplayName } from '@/lib/domain';
import { renderTemplate } from '@/lib/prompts/template';
import { checkPrompt } from '@/lib/writers/prompt-check';
import { OWN_TITLES_STARTER_PROMPT } from '@/lib/writers/starters';
import { CUSTOM_PROMPT_VARIABLES, photoPromptStages, PROMPT_STAGE_LABELS, type CustomWriterConfig, type CustomWriterInfo, type PhotoPromptStage, type WriterBase, type WriterPromptStage } from '@/lib/writers/types';
import type { CustomWriterDetail, LastTest } from '@/lib/writers/store';
import type { CustomArticleParse } from '@/modules/custom/parsers';
import { customManifest } from '@/modules/custom/manifest';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Field, Input, Select, Switch, Textarea } from '@/components/form';
import { Alert, Chip, buttonClasses, cx, formatDateTime } from '@/components/ui';
import { NewWriterButton, type StartOption } from '../new-writer';

/**
 * A writer the owner builds (owner request: add writers without code, “fully advanced + user friendly”). One page in
 * steps: what it is, its title step, its article prompt, what the answer must contain, its category, photos and links,
 * which keywords it takes, and a test with one real ChatGPT answer. The checklist on the side says what is missing
 * before it can be made active; nothing uses a writer until then.
 */

type Draft = { name: string; shortName: string; description: string; base: WriterBase; config: CustomWriterConfig; article: string; titles: string; photos: Record<PhotoPromptStage, string> };
type TestResponse = { parse: CustomArticleParse; result: LastTest; saved: boolean };

const toDraft = (d: CustomWriterDetail): Draft => ({
  name: d.writer.name,
  shortName: d.writer.shortName,
  description: d.writer.description,
  base: d.writer.base,
  config: d.writer.config,
  article: d.prompts.ARTICLE ?? '',
  titles: d.prompts.TITLES ?? '',
  photos: { IMAGE_PLAN: d.prompts.IMAGE_PLAN ?? '', IMAGE_GENERATION: d.prompts.IMAGE_GENERATION ?? '', IMAGE_SEARCH: d.prompts.IMAGE_SEARCH ?? '' },
});

/** What each photo prompt is for, on the writer page. */
const PHOTO_PROMPT_HELP: Record<PhotoPromptStage, string> = {
  IMAGE_PLAN: 'Plans the 3 pictures: image 1 is the featured image, 2 and 3 go into the article. Keep the answer lines “IMAGE 1 PROMPT: …”, “IMAGE 1 ALT: …” (also for 2 and 3): the app reads the pictures from them.',
  IMAGE_GENERATION: 'Sent once for each planned picture; ChatGPT draws it. {{image_brief}} is that picture’s description from the plan. The app adds the website logo and the image design afterwards.',
  IMAGE_SEARCH: 'Asks ChatGPT to search the web for photos of the person and show them as a gallery; the app saves the pictures, checks them and chooses the best ones (your uploads come first).',
};

const SECTIONS = [
  { id: 'basics', label: 'Basics', icon: PenLine },
  { id: 'titles', label: 'Title step', icon: Type },
  { id: 'prompt', label: 'Article prompt', icon: Sparkles },
  { id: 'rules', label: 'Answer rules', icon: ListChecks },
  { id: 'category', label: 'Category', icon: Tags },
  { id: 'media', label: 'Photos & links', icon: ImageIcon },
  { id: 'keywords', label: 'Keywords', icon: KeyRound },
  { id: 'test', label: 'Test', icon: FlaskConical },
] as const;

const STATUS_CHIP: Record<string, { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  ACTIVE: { tone: 'success', label: 'active' },
  DRAFT: { tone: 'warning', label: 'draft' },
  ARCHIVED: { tone: 'neutral', label: 'archived' },
};

const EXAMPLE_VALUES = Object.fromEntries(CUSTOM_PROMPT_VARIABLES.map((v) => [v.name, v.example]));

export function WriterBuilder({ initial, categoryNames, own }: { initial: CustomWriterDetail; categoryNames: string[]; own: StartOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [busy, setBusy] = useState<'save' | 'status' | 'delete' | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const key = saved.writer.key;
  const savedDraft = useMemo(() => toDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const c = draft.config;
  const person = draft.base === 'person';

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setConfig = (patch: Partial<CustomWriterConfig>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  const setRules = (patch: Partial<CustomWriterConfig['rules']>) => setDraft((d) => ({ ...d, config: { ...d.config, rules: { ...d.config.rules, ...patch } } }));

  const articleCheck = useMemo(() => checkPrompt(draft.article, 'ARTICLE'), [draft.article]);
  const titlesCheck = useMemo(() => (c.titles === 'own' ? checkPrompt(draft.titles, 'TITLES') : null), [c.titles, draft.titles]);
  const photoStages = c.images === 'on' && c.photoPrompts === 'own' ? photoPromptStages(draft.base) : [];
  const photoChecks = useMemo(() => photoStages.map((stage) => ({ stage, check: checkPrompt(draft.photos[stage], stage) })), [JSON.stringify(photoStages), JSON.stringify(draft.photos)]); // eslint-disable-line react-hooks/exhaustive-deps
  const photoError = photoChecks.find((p) => p.check.errors.length);
  /** Own photo prompts start from the app's current ones (as edited in Prompt Manager). */
  const usePhotoPrompts = (mode: CustomWriterConfig['photoPrompts']) =>
    setDraft((d) => ({
      ...d,
      config: { ...d.config, photoPrompts: mode },
      photos: mode === 'own' ? (Object.fromEntries((Object.keys(d.photos) as PhotoPromptStage[]).map((stage) => [stage, d.photos[stage].trim() ? d.photos[stage] : saved.photoDefaults[stage]])) as Draft['photos']) : d.photos,
    }));
  const info: CustomWriterInfo = { key, name: draft.name || 'Writer', shortName: draft.shortName || draft.name, description: draft.description, base: draft.base, status: saved.writer.status, startedFrom: saved.writer.startedFrom, config: c };
  const manifest = useMemo(() => customManifest(info), [JSON.stringify(info)]); // eslint-disable-line react-hooks/exhaustive-deps
  // Changes to the prompt or the rules make the last test out of date.
  const testedChanged = draft.article !== savedDraft.article || JSON.stringify(c.rules) !== JSON.stringify(savedDraft.config.rules) || c.titles !== savedDraft.config.titles;
  const testPassed = Boolean(saved.readiness.checks.find((x) => x.id === 'test')?.passed) && !testedChanged;
  const checklist = [
    { label: 'Name', ok: draft.name.trim().length >= 2, detail: draft.name.trim().length >= 2 ? undefined : 'At least 2 characters.', blocking: true, href: '#basics' },
    { label: 'Article prompt', ok: articleCheck.errors.length === 0, detail: articleCheck.errors[0] ?? articleCheck.warnings[0], blocking: true, href: '#prompt' },
    ...(titlesCheck ? [{ label: 'Title prompt', ok: titlesCheck.errors.length === 0, detail: titlesCheck.errors[0] ?? titlesCheck.warnings[0], blocking: true, href: '#titles' }] : []),
    ...(photoChecks.length ? [{ label: 'Photo prompts', ok: !photoError, detail: photoError ? `${PROMPT_STAGE_LABELS[photoError.stage]}: ${photoError.check.errors[0]}` : photoChecks.flatMap((p) => p.check.warnings)[0], blocking: true, href: '#media' }] : []),
    { label: 'Category rule', ok: c.category.mode !== 'fixed' || c.category.name.trim().length >= 2, detail: c.category.mode === 'fixed' && c.category.name.trim().length < 2 ? 'Type the category name.' : undefined, blocking: true, href: '#category' },
    { label: 'Answer rules', ok: c.rules.wordMax > c.rules.wordMin, detail: c.rules.wordMax > c.rules.wordMin ? undefined : 'The highest word count must be above the lowest.', blocking: true, href: '#rules' },
    { label: 'Tested with a ChatGPT answer', ok: testPassed, detail: testPassed ? undefined : testedChanged && saved.lastTest ? 'Changed since the last test — test again.' : saved.lastTest && !saved.lastTest.ok ? 'The last test found problems.' : 'Recommended before making it active.', blocking: false, href: '#test' },
  ];
  const ready = checklist.every((x) => x.ok || !x.blocking);

  async function save(): Promise<boolean> {
    setBusy('save');
    setErrors({});
    try {
      const res = await api<CustomWriterDetail>(`/api/writers/${key}`, {
        method: 'PUT',
        body: {
          name: draft.name,
          shortName: draft.shortName || draft.name,
          description: draft.description,
          base: draft.base,
          config: draft.config,
          prompts: { ARTICLE: draft.article, ...(c.titles === 'own' && draft.titles.trim() ? { TITLES: draft.titles } : {}), ...Object.fromEntries(photoStages.filter((stage) => draft.photos[stage].trim()).map((stage) => [stage, draft.photos[stage]])) },
        },
      });
      setSaved(res);
      setDraft(toDraft(res));
      toast('success', 'Saved.');
      router.refresh();
      return true;
    } catch (error) {
      const e = error as Error & { fieldErrors?: Record<string, string[]> };
      if (e.fieldErrors) setErrors(e.fieldErrors);
      toast('error', e.message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED') {
    if (dirty && !(await save())) return;
    setBusy('status');
    try {
      const res = await api<CustomWriterDetail>(`/api/writers/${key}/status`, { body: { status } });
      setSaved(res);
      setDraft(toDraft(res));
      toast('success', status === 'ACTIVE' ? `“${res.writer.name}” is active: choose it in Single Article, Workflow and Bulk Campaigns.` : status === 'ARCHIVED' ? 'Archived: hidden from the writer lists; its articles still finish.' : 'Back to draft: no longer offered.');
      router.refresh();
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    try {
      await api(`/api/writers/${key}`, { method: 'DELETE' });
      toast('success', 'Writer deleted.');
      router.push('/writers');
      router.refresh();
    } catch (error) {
      toast('error', (error as Error).message);
      setBusy(null);
    }
  }

  const status = STATUS_CHIP[saved.writer.status] ?? STATUS_CHIP.DRAFT;
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/writers" className="text-muted mb-2 inline-flex items-center gap-1 text-xs hover:text-[var(--text)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Writers
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            {draft.name || 'Writer'}
            <Chip tone={status.tone}>{status.label}</Chip>
            <Chip>{person ? 'about a person' : 'any topic'}</Chip>
          </h1>
          <p className="text-muted mt-1 text-sm">
            {saved.tasks} article{saved.tasks === 1 ? '' : 's'} · prompt version {saved.promptVersions.ARTICLE} · saved {formatDateTime(saved.updatedAt)} · <span className="font-mono text-xs">{key}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NewWriterButton own={[{ id: key, title: `Copy of ${saved.writer.name}`, kind: saved.writer.base, text: 'Its prompts and rules copied.' }, ...own]} initial={key} label="Duplicate" variant="secondary" size="sm" />
          {dirty ? (
            <Button size="sm" disabled tip="Save first: the file holds the saved settings and prompts">
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          ) : (
            <a className={buttonClasses('secondary', 'sm')} href={`/api/writers/export?key=${encodeURIComponent(key)}`} download title="This writer (its settings and prompts) as a file: a backup, or to import on another PC (Writers → Import)">
              <Download className="h-3.5 w-3.5" aria-hidden /> Export
            </a>
          )}
          {saved.writer.status === 'ACTIVE' ? (
            <>
              <Button size="sm" loading={busy === 'status'} onClick={() => void setStatus('DRAFT')} tip="No longer offered; its articles still finish">
                <Undo2 className="h-3.5 w-3.5" /> Back to draft
              </Button>
              <Button size="sm" loading={busy === 'status'} onClick={() => void setStatus('ARCHIVED')}>
                <Archive className="h-3.5 w-3.5" /> Archive
              </Button>
            </>
          ) : (
            <>
              {saved.writer.status === 'DRAFT' ? (
                <Button size="sm" loading={busy === 'status'} onClick={() => void setStatus('ARCHIVED')}>
                  <Archive className="h-3.5 w-3.5" /> Archive
                </Button>
              ) : null}
              <Button size="sm" variant="danger" disabled={saved.tasks > 0} tip={saved.tasks > 0 ? 'Articles use this writer: archive it instead' : 'Delete this writer and its prompts'} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
              <Button variant="primary" loading={busy === 'status'} disabled={!ready} tip={ready ? undefined : 'Complete the checklist first'} onClick={() => void setStatus('ACTIVE')}>
                <Rocket className="h-4 w-4" /> {saved.writer.status === 'ARCHIVED' ? 'Make active again' : dirty ? 'Save and make active' : 'Make active'}
              </Button>
            </>
          )}
          <Button variant={saved.writer.status === 'ACTIVE' ? 'primary' : 'secondary'} loading={busy === 'save'} disabled={!dirty} onClick={() => void save()}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[170px_minmax(0,1fr)_300px]">
        <nav aria-label="Writer sections" className="hidden 2xl:block">
          <ol className="sticky top-20 space-y-0.5">
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-muted flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
                  <span className="grid h-5 w-5 place-items-center rounded-full border text-[10px] font-semibold">{i + 1}</span>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0 space-y-6">
          <Section id="basics" n={1} title="Basics" description="The name every writer list shows, and what kind of articles it writes.">
            <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
              <Field label="Name" htmlFor="w-name" required error={errors.name}>
                <Input id="w-name" value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} invalid={Boolean(errors.name)} />
              </Field>
              <Field label="Short name" htmlFor="w-short" help="For tables and buttons.">
                <Input id="w-short" value={draft.shortName} maxLength={24} onChange={(e) => setDraft({ ...draft, shortName: e.target.value })} />
              </Field>
            </div>
            <Field label="Description" htmlFor="w-desc">
              <Textarea id="w-desc" rows={2} maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <Choice
              label="Kind of article"
              value={draft.base}
              onChange={(v) => setDraft({ ...draft, base: v as WriterBase })}
              options={[
                { value: 'person', title: 'About a person', text: 'Photos of the person (your uploads first), an optional facts table under its own H2, family-claim checks, the Celebrity image designs.', icon: <User className="h-4 w-4" /> },
                { value: 'general', title: 'Any topic', text: 'Generated images and the Tigram image designs; no facts table.', icon: <Sparkles className="h-4 w-4" /> },
              ]}
            />
            {saved.writer.startedFrom ? <p className="text-muted text-xs">Started from {startedFromLabel(saved.writer.startedFrom)}.</p> : null}
          </Section>

          <Section id="titles" n={2} title="Title step" description="Where the article's title comes from. The approved title goes into your prompt as {{selected_title}}.">
            <Choice
              value={c.titles}
              onChange={(v) => setConfig({ titles: v as CustomWriterConfig['titles'] })}
              options={[
                { value: 'app', title: 'The app’s title step', text: '6–10 title ideas and a recommended one, approved automatically or by you (Settings → manual title approval). Your example title guides it.' },
                { value: 'own', title: 'My own title prompt', text: 'You write the title prompt; its answer needs a final “Recommended Title: …” line.' },
                { value: 'off', title: 'No title step', text: 'The post title is your example title, else the article’s own # title, else its SEO title.' },
              ]}
            />
            {c.titles === 'own' ? (
              <PromptEditor id="w-titles" label="Title prompt" value={draft.titles} onChange={(v) => setDraft({ ...draft, titles: v })} check={titlesCheck} stage="TITLES" rows={9} starter={OWN_TITLES_STARTER_PROMPT} error={errors['prompts.TITLES']} />
            ) : null}
          </Section>

          <Section id="prompt" n={3} title="Article prompt" description="Your prompt, sent to ChatGPT as written with the inputs filled in. One answer writes the whole article.">
            <PromptEditor id="w-article" label="Article prompt" value={draft.article} onChange={(v) => setDraft({ ...draft, article: v })} check={articleCheck} stage="ARTICLE" rows={22} error={errors['prompts.ARTICLE']} />
            <p className="text-muted text-xs">Every save keeps the earlier version (Prompt Manager → {draft.name || 'this writer'} → history). The app adds only one line under it: the article language and country.</p>
          </Section>

          <Section id="rules" n={4} title="Answer rules" description="What ChatGPT’s answer must contain. Something missing that is required → the prompt is sent again; counts and lengths outside the rules → a note for your review.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Words from" htmlFor="w-min" error={errors['config.rules.wordMin']}>
                <Input id="w-min" type="number" min={200} max={10000} step={50} value={c.rules.wordMin} onChange={(e) => setRules({ wordMin: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Words to" htmlFor="w-max" error={c.rules.wordMax <= c.rules.wordMin ? 'Above “from”.' : errors['config.rules.wordMax']}>
                <Input id="w-max" type="number" min={300} max={15000} step={50} value={c.rules.wordMax} onChange={(e) => setRules({ wordMax: Number(e.target.value) || 0 })} invalid={c.rules.wordMax <= c.rules.wordMin} />
              </Field>
              <Field label="FAQs" htmlFor="w-faq" help="0: no FAQ section.">
                <Input id="w-faq" type="number" min={0} max={15} value={c.rules.faqCount} onChange={(e) => setRules({ faqCount: Math.max(0, Math.min(15, Number(e.target.value) || 0)) })} />
              </Field>
              <Field label="FAQ count is" htmlFor="w-faq-exact">
                <Select id="w-faq-exact" value={c.rules.exactFaqs ? 'exact' : 'about'} disabled={c.rules.faqCount === 0} onChange={(e) => setRules({ exactFaqs: e.target.value === 'exact' })}>
                  <option value="exact">exactly that many</option>
                  <option value="about">about (±2)</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Switch label="Conclusion section" help="A “Conclusion” H2 is expected." checked={c.rules.conclusion} onChange={(e) => setRules({ conclusion: e.target.checked })} />
              <Switch label="SEO lines at the top" help="SEO Title, Meta Description, URL Slug — taken out of the text into the SEO fields; missing ones are filled." checked={c.rules.seoLines} onChange={(e) => setRules({ seoLines: e.target.checked })} />
              <Switch label="No bullet lists" help="A note when the narrative has lists." checked={c.rules.noLists} onChange={(e) => setRules({ noLists: e.target.checked })} />
            </div>
            {person ? (
              <div className="border-app grid gap-4 rounded-lg border p-4 md:grid-cols-3">
                <Field label="Facts table about the person" htmlFor="w-table" help="Rebuilt as the app’s clean two-column table.">
                  <Select id="w-table" value={c.rules.table} onChange={(e) => setRules({ table: e.target.value as CustomWriterConfig['rules']['table'] })}>
                    <option value="required">Required (asked again without it)</option>
                    <option value="optional">Optional</option>
                    <option value="none">No table</option>
                  </Select>
                </Field>
                <Field label="Its H2 heading" htmlFor="w-th" help="Also {{table_heading}} in your prompt.">
                  <Input id="w-th" value={c.rules.tableHeading} maxLength={60} disabled={c.rules.table === 'none'} onChange={(e) => setRules({ tableHeading: e.target.value })} placeholder="Family Profile" />
                </Field>
                <Field label="German websites" htmlFor="w-th-de">
                  <Input id="w-th-de" value={c.rules.tableHeadingDe} maxLength={60} disabled={c.rules.table === 'none'} onChange={(e) => setRules({ tableHeadingDe: e.target.value })} placeholder="Familienprofil" />
                </Field>
              </div>
            ) : null}
          </Section>

          <Section id="category" n={5} title="Category" description="Which WordPress category its articles go into.">
            <Choice
              value={c.category.mode}
              onChange={(v) => setConfig({ category: { ...c.category, mode: v as CustomWriterConfig['category']['mode'] } })}
              options={[
                { value: 'celebrity', title: 'Always “Celebrity”', text: 'Like the celebrity writers: “Celebrity” (German websites: “Prominente”). Nothing to choose.' },
                { value: 'fixed', title: 'Always one category', text: 'A category by name; an article waits with a clear message on a website that lacks it.' },
                { value: 'chatgpt', title: 'Chosen per article', text: 'The category you choose; without one ChatGPT picks one of the website’s synced categories.' },
              ]}
            />
            {c.category.mode === 'fixed' ? (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Category name" htmlFor="w-cat" required error={errors['config.category.name']} help="As in WordPress (name or slug).">
                  <Input id="w-cat" list="w-cat-names" value={c.category.name} maxLength={80} onChange={(e) => setConfig({ category: { ...c.category, name: e.target.value } })} invalid={c.category.name.trim().length < 2} />
                </Field>
                <Field label="On German websites" htmlFor="w-cat-de" help="Optional: its German name.">
                  <Input id="w-cat-de" list="w-cat-names" value={c.category.nameDe} maxLength={80} onChange={(e) => setConfig({ category: { ...c.category, nameDe: e.target.value } })} />
                </Field>
                <datalist id="w-cat-names">
                  {categoryNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>
            ) : null}
          </Section>

          <Section id="media" n={6} title="Photos & links" description="The same steps as the built-in writers; turn off what this writer does not need.">
            <div className="grid gap-3 md:grid-cols-2">
              <Switch label="Photos" help={person ? 'Featured + two body images of the person, your uploads first, then ChatGPT’s photo search. The website’s image setting still applies.' : 'A featured image and body images as in the Tigram writer.'} checked={c.images === 'on'} onChange={(e) => setConfig({ images: e.target.checked ? 'on' : 'off' })} />
              <Switch label="Check the answer’s links" help="Every link is opened and checked; a failing one becomes plain text." checked={c.linkCheck} onChange={(e) => setConfig({ linkCheck: e.target.checked })} />
              <Switch label="Internal links" help="Relevant posts of the same website and an “Also read” line." checked={c.internalLinks} onChange={(e) => setConfig({ internalLinks: e.target.checked })} />
              <Switch label="Add the app’s SEO brief" help="Off: your prompt is sent as written (as Celebrity 2). On: the brief (search intent, entities) is added under it." checked={c.seoBrief} onChange={(e) => setConfig({ seoBrief: e.target.checked })} />
            </div>
            {c.images === 'on' ? (
              <div className="space-y-4 border-t border-[var(--border)] pt-4">
                <Choice
                  label="Photo prompts"
                  value={c.photoPrompts}
                  onChange={(v) => usePhotoPrompts(v as CustomWriterConfig['photoPrompts'])}
                  options={[
                    { value: 'app', title: 'The app’s photo prompts', text: person ? 'Celebrity’s photo search (Prompt Manager → Celebrity → Image search).' : 'Tigram’s image plan and image prompt (Prompt Manager → Tigram).' },
                    { value: 'own', title: 'My own photo prompts', text: person ? 'Your photo search prompt for this writer only. It starts as a copy of the app’s.' : 'Your image plan and image prompt for this writer only, for example another style. They start as a copy of the app’s.' },
                  ]}
                />
                {photoStages.map((stage) => (
                  <div key={stage} className="space-y-1">
                    <PromptEditor id={`w-${stage.toLowerCase()}`} label={`${PROMPT_STAGE_LABELS[stage]} prompt`} value={draft.photos[stage]} onChange={(v) => setDraft((d) => ({ ...d, photos: { ...d.photos, [stage]: v } }))} check={photoChecks.find((p) => p.stage === stage)?.check ?? null} stage={stage} rows={stage === 'IMAGE_PLAN' ? 16 : 7} starter={saved.photoDefaults[stage]} error={errors[`prompts.${stage}`]} />
                    <p className="text-muted text-xs">{PHOTO_PROMPT_HELP[stage]}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </Section>

          <Section id="keywords" n={7} title="Keywords" description="Which keywords get this writer by themselves in Workflow and Bulk Campaigns (you can always choose it by hand).">
            <PhraseInput value={c.routing.contains} onChange={(contains) => setConfig({ routing: { ...c.routing, contains } })} />
            {person ? <Switch label="Offer it for person keywords" help="With Celebrity and Celebrity 2 in “Person keywords” when you add keywords." checked={c.routing.personKeywords} onChange={(e) => setConfig({ routing: { ...c.routing, personKeywords: e.target.checked } })} /> : null}
          </Section>

          <TestSection writerKey={key} draft={draft} dirty={dirty} onSaved={(lastTest) => setSaved((s) => ({ ...s, lastTest, readiness: { ...s.readiness, checks: s.readiness.checks.map((x) => (x.id === 'test' ? { ...x, passed: lastTest.ok } : x)) } }))} />
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <div className="surface rounded-xl border p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              {ready ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <CircleAlert className="h-4 w-4 text-amber-500" />} {saved.writer.status === 'ACTIVE' ? 'In use' : ready ? 'Ready to make active' : 'Before it can be used'}
            </h2>
            <ul className="space-y-2 text-sm">
              {checklist.map((x) => (
                <li key={x.label}>
                  <a href={x.href} className="flex gap-2 hover:underline">
                    {x.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-label="done" /> : x.blocking ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-label="missing" /> : <Circle className="text-muted mt-0.5 h-4 w-4 shrink-0" aria-label="recommended" />}
                    <span className="min-w-0">
                      <span className="block">{x.label}</span>
                      {x.detail ? <span className="text-muted block text-xs">{x.detail}</span> : null}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="surface rounded-xl border p-4">
            <h2 className="mb-1 text-sm font-semibold">How an article runs</h2>
            <p className="text-muted mb-3 text-xs">Steps in order; grey ones are off for this writer.</p>
            <ol className="space-y-1 text-xs">
              {manifest.stages.map((s, i) => {
                const off = (s.key === 'TITLES' || s.key === 'TITLE_APPROVAL') && c.titles === 'off' ? true : s.key === 'EXTERNAL_LINKS' ? !c.linkCheck : s.key === 'INTERNAL_LINKS' ? !c.internalLinks : s.key === 'IMAGES' ? c.images === 'off' : false;
                return (
                  <li key={s.key} className={cx('flex gap-2', off && 'text-muted line-through')} title={s.description}>
                    <span className="text-muted w-4 text-right tabular-nums">{i + 1}</span>
                    <span className={cx('font-medium', s.kind === 'chatgpt' && !off && 'text-indigo-600 dark:text-indigo-300')}>{s.label}</span>
                    {s.kind === 'chatgpt' && !off ? <span className="text-muted">· ChatGPT</span> : null}
                  </li>
                );
              })}
            </ol>
          </div>
        </aside>
      </div>

      {dirty ? (
        <div className="surface border-app sticky bottom-4 z-30 mt-6 rounded-xl border px-4 py-3 shadow-xl" role="status">
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-muted mr-auto text-sm">Unsaved changes</span>
            <Button variant="ghost" onClick={() => setDraft(savedDraft)}>
              Discard
            </Button>
            <Button variant="primary" loading={busy === 'save'} onClick={() => void save()}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog open={confirmDelete} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} title={`Delete “${saved.writer.name}”?`} confirmLabel="Delete writer" tone="danger" busy={busy === 'delete'}>
        The writer and its prompts are deleted. No article used it.
      </ConfirmDialog>
    </div>
  );
}

const startedFromLabel = (from: string) =>
  ({ 'celebrity-writer': 'Celebrity', 'celebrity2-writer': 'Celebrity 2', 'tigram-writer': 'Tigram', 'blank-person': 'an empty person writer', 'blank-general': 'an empty general writer', import: 'a writer file (Import)' })[from] ?? moduleDisplayName(from);

function Section({ id, n, title, description, children }: { id: string; n: number; title: string; description: string; children: ReactNode }) {
  return (
    <section id={id} className="surface scroll-mt-20 rounded-xl border">
      <header className="border-app border-b px-5 py-4">
        <h2 className="flex items-center gap-2.5 text-base font-semibold">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--surface-2)] text-xs">{n}</span>
          {title}
        </h2>
        <p className="text-muted mt-0.5 text-sm">{description}</p>
      </header>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function Choice({ label, value, onChange, options }: { label?: string; value: string; onChange: (v: string) => void; options: { value: string; title: string; text: string; icon?: ReactNode }[] }) {
  return (
    <fieldset>
      {label ? <legend className="mb-2 block text-sm font-medium">{label}</legend> : null}
      <div className={cx('grid gap-2', options.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')} role="radiogroup">
        {options.map((o) => (
          <label key={o.value} className={cx('flex cursor-pointer gap-3 rounded-lg border p-3 transition', value === o.value ? 'border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-200 dark:bg-indigo-950/40 dark:ring-indigo-900' : 'border-app hover:border-indigo-300')}>
            <input type="radio" value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {o.icon ? <span className="mt-0.5 shrink-0">{o.icon}</span> : <span className={cx('mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2', value === o.value ? 'border-indigo-500 bg-indigo-500' : 'border-zinc-400')} aria-hidden />}
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{o.title}</span>
              <span className="text-muted block text-xs">{o.text}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A prompt with buttons that insert the app's variables where the cursor is, live checks and a preview with example values. */
function PromptEditor({ id, label, value, onChange, check, stage, rows, starter, error }: { id: string; label: string; value: string; onChange: (v: string) => void; check: ReturnType<typeof checkPrompt> | null; stage: WriterPromptStage; rows: number; starter?: string; error?: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const vars = CUSTOM_PROMPT_VARIABLES.filter((v) => !v.stage || v.stage === stage);
  const insert = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const rendered = useMemo(() => (preview ? renderTemplate(value, { ...EXAMPLE_VALUES, secondary_keywords: ['andrea soros husband', 'andrea soros children'] }) : null), [preview, value]);
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="text-muted text-xs">
          {words} words · {value.length.toLocaleString('en')} characters
        </span>
        <span className="ml-auto flex gap-2">
          {starter && !value.trim() ? (
            <Button size="sm" variant="ghost" onClick={() => onChange(starter)}>
              Use a starting prompt
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
            <Eye className="h-3.5 w-3.5" /> {preview ? 'Edit' : 'Preview with an example'}
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Insert a variable">
        {vars.map((v) => (
          <button key={v.name} type="button" onClick={() => insert(v.name)} title={`${v.label} — e.g. “${v.example}”`} className={cx('rounded-md border px-2 py-0.5 font-mono text-[11px] transition hover:border-indigo-400 hover:text-indigo-600', check?.used.includes(v.name) ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-200' : 'border-app text-muted')}>
            {`{{${v.name}}}`}
          </button>
        ))}
      </div>
      {preview && rendered ? (
        <pre className="surface-2 max-h-[560px] overflow-auto rounded-lg p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{rendered.text}</pre>
      ) : (
        <Textarea ref={ref} id={id} rows={rows} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} className="font-mono text-xs leading-relaxed" invalid={Boolean(check?.errors.length || error?.length)} />
      )}
      {[...(error ?? []), ...(check?.errors ?? [])].map((e) => (
        <p key={e} className="text-xs font-medium text-rose-600" role="alert">
          {e}
        </p>
      ))}
      {(check?.warnings ?? []).map((w) => (
        <p key={w} className="text-xs text-amber-700 dark:text-amber-300">
          {w}
        </p>
      ))}
    </div>
  );
}

function PhraseInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 2 && p.length <= 80 && !value.some((v) => v.toLowerCase() === p.toLowerCase()));
    if (parts.length) onChange([...value, ...parts].slice(0, 30));
    setText('');
  };
  return (
    <Field label="Keywords containing these words or phrases go to this writer" htmlFor="w-phrase" help="Whole words, any case: “net worth” matches “taylor swift net worth”. A website’s own routing rules come first.">
      <div className="surface flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5">
        {value.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs">
            {p}
            <button type="button" aria-label={`Remove ${p}`} onClick={() => onChange(value.filter((x) => x !== p))} className="text-muted hover:text-[var(--text)]">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          id="w-phrase"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={add}
          placeholder={value.length ? '' : 'e.g. family tree, net worth — Enter to add'}
          className="min-w-40 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-[var(--text-muted)]"
        />
      </div>
    </Field>
  );
}

function TestSection({ writerKey, draft, dirty, onSaved }: { writerKey: string; draft: Draft; dirty: boolean; onSaved: (t: LastTest) => void }) {
  const toast = useToast();
  const [answer, setAnswer] = useState('');
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TestResponse | null>(null);
  const [showArticle, setShowArticle] = useState(false);
  const r = draft.config.rules;

  async function run() {
    setBusy(true);
    try {
      const out = await api<TestResponse>(`/api/writers/${writerKey}/test`, { body: { answer, language, title: title || undefined, config: draft.config, base: draft.base, article: draft.article } });
      setRes(out);
      setShowArticle(false);
      if (out.saved) onSaved(out.result);
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const p = res?.parse;
  const wordsOk = p ? p.words >= r.wordMin * 0.85 && p.words <= r.wordMax * 1.2 : false;
  const faqsOk = p ? (r.faqCount === 0 ? true : r.exactFaqs ? p.faqs.length === r.faqCount : Math.abs(p.faqs.length - r.faqCount) <= 2) : false;
  return (
    <Section id="test" n={8} title="Test with a ChatGPT answer" description="Send your prompt to ChatGPT yourself once, paste the whole answer here and see what the article would get. Nothing is sent to ChatGPT or WordPress.">
      <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
        <Field label="Article language" htmlFor="w-test-lang">
          <Select id="w-test-lang" value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'de')}>
            <option value="en">English</option>
            <option value="de">German</option>
          </Select>
        </Field>
        <Field label="Approved title" htmlFor="w-test-title" help="Optional: the title ChatGPT was given (its # heading is compared with it).">
          <Input id="w-test-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </div>
      <Field label="ChatGPT’s answer" htmlFor="w-test-answer">
        <Textarea id="w-test-answer" rows={10} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Paste the complete answer (with its SEO lines, table and FAQs)…" className="font-mono text-xs" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={busy} disabled={!answer.trim()} onClick={() => void run()}>
          <FlaskConical className="h-4 w-4" /> Test this answer
        </Button>
        {dirty ? <span className="text-muted text-xs">Tested with your unsaved settings; save to keep the result in the checklist.</span> : null}
      </div>
      {res && p ? (
        <div className="space-y-4" aria-live="polite">
          {res.result.ok ? (
            <Alert tone="success" title="This answer would be used">
              {p.warnings.length ? `${p.warnings.length} note${p.warnings.length === 1 ? '' : 's'} would be review reasons (below).` : 'No notes.'}
            </Alert>
          ) : (
            <Alert tone="danger" title="This answer would be asked again">
              {p.problems.join(' ')}
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Words" value={p.words.toLocaleString('en')} hint={`asked: ${r.wordMin}–${r.wordMax}`} ok={wordsOk} />
            <Tile label="FAQs" value={String(p.faqs.length)} hint={r.faqCount ? `asked: ${r.exactFaqs ? '' : 'about '}${r.faqCount}` : 'none asked'} ok={faqsOk} />
            <Tile label="Table rows" value={draft.base === 'person' && r.table !== 'none' ? String(p.bioRows.length) : '—'} hint={draft.base === 'person' && r.table !== 'none' ? (r.table === 'required' ? 'required' : 'optional') : 'no table'} ok={draft.base !== 'person' || r.table === 'none' || p.bioRows.length > 0 || r.table === 'optional'} />
            <Tile label="SEO lines" value={`${[p.seoTitle, p.metaDescription, p.slug].filter(Boolean).length}/3`} hint={r.seoLines ? 'title, meta, slug' : 'not asked'} ok={!r.seoLines || Boolean(p.seoTitle && p.metaDescription && p.slug)} />
          </div>
          {p.warnings.length ? (
            <div>
              <h3 className="mb-1 text-sm font-semibold">Notes</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">
                {p.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">SEO fields</h3>
              <dl className="space-y-1 text-sm">
                <div><dt className="text-muted inline">SEO title: </dt><dd className="inline">{p.seoTitle ?? '— (the title is used)'}</dd></div>
                <div><dt className="text-muted inline">Meta description: </dt><dd className="inline">{p.metaDescription ?? '— (from the introduction)'}</dd></div>
                <div><dt className="text-muted inline">Slug: </dt><dd className="inline font-mono text-xs">{p.slug ?? '— (from the keyword)'}</dd></div>
                {p.h1 ? <div><dt className="text-muted inline">Its # title: </dt><dd className="inline">{p.h1}</dd></div> : null}
              </dl>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Sections (H2)</h3>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm">
                {p.h2.map((h, i) => (
                  <li key={`${h}-${i}`}>{h}</li>
                ))}
              </ol>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowArticle((s) => !s)}>
            <Eye className="h-3.5 w-3.5" /> {showArticle ? 'Hide the article' : 'Show the article'}
          </Button>
          {showArticle ? <iframe title="Article preview" sandbox="" className="border-app h-[640px] w-full rounded-lg border bg-white" srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#18181b}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e4e4e7;padding:6px 10px;text-align:left}h2{margin-top:1.6em}</style>${p.html}`} /> : null}
        </div>
      ) : null}
    </Section>
  );
}

function Tile({ label, value, hint, ok }: { label: string; value: string; hint: string; ok: boolean }) {
  return (
    <div className={cx('rounded-lg border p-3', ok ? 'border-app' : 'border-amber-400/70')}>
      <div className="text-muted flex items-center justify-between text-xs">
        {label}
        {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-label="as asked" /> : <CircleAlert className="h-3.5 w-3.5 text-amber-500" aria-label="not as asked" />}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-muted text-xs">{hint}</div>
    </div>
  );
}
