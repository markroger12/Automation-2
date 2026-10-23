'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { PRESET_COUNTRIES } from '@/lib/domain';
import { Button, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';

export interface WebsiteFormValues {
  id?: string;
  name: string;
  publicUrl: string;
  adminUrl: string;
  language: 'en' | 'de';
  targetCountry: string;
  timezone: string;
  internalLinkLine: string;
  editorType: 'AUTO' | 'GUTENBERG' | 'CLASSIC';
  defaultCategoryId: string;
  searchConsoleProperty: string;
  queueQuota: number;
  priority: number;
  paused: boolean;
  active: boolean;
  notes: string;
  settingsOverrides: {
    content: { maxArticleWordCount?: number; faqCount?: number; quickBioRows?: number; humanizerEnabled?: boolean };
    seo: { articleImages?: boolean; imagesRequired?: boolean; externalLinks?: boolean; internalLinks?: boolean; rankMathTargetScore?: number; reviewThreshold?: number; rankMathMode?: 'required' | 'if-installed' | 'off' };
    workflow: { manualTitleApproval?: boolean; manualArticleApproval?: boolean };
  };
}

export const EMPTY_WEBSITE: WebsiteFormValues = {
  name: '',
  publicUrl: '',
  adminUrl: '',
  language: 'en',
  targetCountry: 'United States',
  timezone: 'America/New_York',
  internalLinkLine: '',
  editorType: 'AUTO',
  defaultCategoryId: '',
  searchConsoleProperty: '',
  queueQuota: 0,
  priority: 0,
  paused: false,
  active: true,
  notes: '',
  settingsOverrides: { content: {}, seo: {}, workflow: {} },
};

type Tri = '' | 'on' | 'off';
const tri = (v: boolean | undefined): Tri => (v === undefined ? '' : v ? 'on' : 'off');
const fromTri = (v: Tri): boolean | undefined => (v === '' ? undefined : v === 'on');
const optNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export function WebsiteForm({ initial, categories = [], onSaved }: { initial: WebsiteFormValues; categories?: { id: string; name: string }[]; onSaved?: (id: string) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['Europe/Berlin', 'America/New_York', 'Europe/London', 'Asia/Karachi', 'UTC'];
    }
  }, []);
  const customCountry = !(PRESET_COUNTRIES as readonly string[]).includes(values.targetCountry);
  const set = <K extends keyof WebsiteFormValues>(k: K, v: WebsiteFormValues[K]) => setValues((s) => ({ ...s, [k]: v }));
  const setOv = (group: 'content' | 'seo' | 'workflow', key: string, v: unknown) =>
    setValues((s) => {
      const next = { ...s.settingsOverrides[group] } as Record<string, unknown>;
      if (v === undefined || (typeof v === 'number' && Number.isNaN(v))) delete next[key];
      else next[key] = v;
      return { ...s, settingsOverrides: { ...s.settingsOverrides, [group]: next } };
    });
  const err = (k: string) => errors[k];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body = { ...values, adminUrl: values.adminUrl || null, defaultCategoryId: values.defaultCategoryId || null, searchConsoleProperty: values.searchConsoleProperty || null };
      delete (body as { id?: string }).id;
      const res = values.id
        ? await api<{ website: { id: string } }>(`/api/websites/${values.id}`, { method: 'PUT', body })
        : await api<{ website: { id: string } }>('/api/websites', { method: 'POST', body });
      toast('success', values.id ? 'Website saved.' : 'Website added. Next: Log in once in the visible window.');
      onSaved?.(res.website.id);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError && error.fieldErrors) setErrors(error.fieldErrors);
      toast('error', (error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Website name" htmlFor="ws-name" required error={err('name')}>
          <Input id="ws-name" value={values.name} onChange={(e) => set('name', e.target.value)} placeholder="Celebrity News DE" invalid={Boolean(err('name'))} />
        </Field>
        <Field label="Public URL" htmlFor="ws-url" required error={err('publicUrl')} help="The home page, e.g. https://example.com">
          <Input id="ws-url" value={values.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://example.com" invalid={Boolean(err('publicUrl'))} />
        </Field>
        <Field label="Admin URL" htmlFor="ws-admin" error={err('adminUrl')} help="Leave empty for <public URL>/wp-admin/">
          <Input id="ws-admin" value={values.adminUrl} onChange={(e) => set('adminUrl', e.target.value)} placeholder="https://example.com/wp-admin/" />
        </Field>
        <Field label="Language" htmlFor="ws-lang" required help="Article language, headings and metadata.">
          <Select
            id="ws-lang"
            value={values.language}
            onChange={(e) => {
              const language = e.target.value as 'en' | 'de';
              setValues((s) => ({ ...s, language, ...(s.id ? {} : { targetCountry: language === 'de' ? 'Germany' : 'United States', timezone: language === 'de' ? 'Europe/Berlin' : s.timezone }) }));
            }}
          >
            <option value="en">English</option>
            <option value="de">German</option>
          </Select>
        </Field>
        <Field label="Target country" htmlFor="ws-country" required error={err('targetCountry')}>
          <div className="flex gap-2">
            <Select id="ws-country" value={customCountry ? '__custom' : values.targetCountry} onChange={(e) => set('targetCountry', e.target.value === '__custom' ? '' : e.target.value)}>
              {PRESET_COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__custom">Custom…</option>
            </Select>
            {customCountry ? <Input aria-label="Custom country" value={values.targetCountry} onChange={(e) => set('targetCountry', e.target.value)} placeholder="Austria" /> : null}
          </div>
        </Field>
        <Field label="Timezone (WordPress site)" htmlFor="ws-tz" required error={err('timezone')} help="Used for DST-safe scheduling.">
          <Input id="ws-tz" list="bas-timezones" value={values.timezone} onChange={(e) => set('timezone', e.target.value)} invalid={Boolean(err('timezone'))} />
          <datalist id="bas-timezones">
            {timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </Field>
        <Field label="Internal-link line" htmlFor="ws-ill" help={`Last line of every article. Default: ${values.language === 'de' ? '“Das könnte Ihnen gefallen:”' : '“Also read:”'}`}>
          <Input id="ws-ill" value={values.internalLinkLine} onChange={(e) => set('internalLinkLine', e.target.value)} placeholder={values.language === 'de' ? 'Das könnte Ihnen gefallen:' : 'Also read:'} />
        </Field>
        <Field label="Editor" htmlFor="ws-editor" help="AUTO uses the detected editor.">
          <Select id="ws-editor" value={values.editorType} onChange={(e) => set('editorType', e.target.value as WebsiteFormValues['editorType'])}>
            <option value="AUTO">Auto-detect</option>
            <option value="GUTENBERG">Gutenberg (block editor)</option>
            <option value="CLASSIC">Classic Editor</option>
          </Select>
        </Field>
        {values.id ? (
          <Field label="Default category" htmlFor="ws-cat" error={err('defaultCategoryId')} help={categories.length ? 'Pre-selected for new articles.' : 'Sync categories first.'}>
            <Select id="ws-cat" value={values.defaultCategoryId} onChange={(e) => set('defaultCategoryId', e.target.value)} disabled={!categories.length}>
              <option value="">— none —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Search Console property" htmlFor="ws-gsc" error={err('searchConsoleProperty')} help="Optional, e.g. sc-domain:example.com">
          <Input id="ws-gsc" value={values.searchConsoleProperty} onChange={(e) => set('searchConsoleProperty', e.target.value)} />
        </Field>
        <Field label="Per-site queue quota" htmlFor="ws-quota" help="Max articles in flight for this site (0 = no limit).">
          <Input id="ws-quota" type="number" min={0} max={10} value={values.queueQuota} onChange={(e) => set('queueQuota', Number(e.target.value))} />
        </Field>
        <Field label="Priority" htmlFor="ws-prio" help="-10 … 10; higher runs first.">
          <Input id="ws-prio" type="number" min={-10} max={10} value={values.priority} onChange={(e) => set('priority', Number(e.target.value))} />
        </Field>
      </div>

      <fieldset className="border-app rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">Site overrides (empty = global default)</legend>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Max words (celebrity final)" htmlFor="ov-words">
            <Input id="ov-words" type="number" value={values.settingsOverrides.content.maxArticleWordCount ?? ''} onChange={(e) => setOv('content', 'maxArticleWordCount', optNum(e.target.value))} />
          </Field>
          <Field label="FAQ count" htmlFor="ov-faq">
            <Input id="ov-faq" type="number" value={values.settingsOverrides.content.faqCount ?? ''} onChange={(e) => setOv('content', 'faqCount', optNum(e.target.value))} />
          </Field>
          <Field label="Quick Bio rows" htmlFor="ov-bio">
            <Input id="ov-bio" type="number" value={values.settingsOverrides.content.quickBioRows ?? ''} onChange={(e) => setOv('content', 'quickBioRows', optNum(e.target.value))} />
          </Field>
          <Field label="Rank Math target" htmlFor="ov-rm">
            <Input id="ov-rm" type="number" value={values.settingsOverrides.seo.rankMathTargetScore ?? ''} onChange={(e) => setOv('seo', 'rankMathTargetScore', optNum(e.target.value))} />
          </Field>
          <Field label="Rank Math on this site" htmlFor="ov-rmmode">
            <Select
              id="ov-rmmode"
              value={values.settingsOverrides.seo.rankMathMode ?? ''}
              onChange={(e) => setOv('seo', 'rankMathMode', (e.target.value || undefined) as 'required' | 'if-installed' | 'off' | undefined)}
            >
              <option value="">Global default</option>
              <option value="required">Required</option>
              <option value="if-installed">Use when installed</option>
              <option value="off">Off</option>
            </Select>
          </Field>
          <Field label="SEO review threshold" htmlFor="ov-rt">
            <Input id="ov-rt" type="number" value={values.settingsOverrides.seo.reviewThreshold ?? ''} onChange={(e) => setOv('seo', 'reviewThreshold', optNum(e.target.value))} />
          </Field>
          {(
            [
              ['content', 'humanizerEnabled', 'Humanizer'],
              ['seo', 'articleImages', 'Article images'],
              ['seo', 'imagesRequired', 'Missing images → review'],
              ['seo', 'externalLinks', 'External links'],
              ['seo', 'internalLinks', 'Internal links'],
              ['workflow', 'manualTitleApproval', 'Manual title approval'],
              ['workflow', 'manualArticleApproval', 'Manual article approval'],
            ] as const
          ).map(([group, key, label]) => (
            <Field key={key} label={label} htmlFor={`ov-${key}`}>
              <Select
                id={`ov-${key}`}
                value={tri((values.settingsOverrides[group] as Record<string, boolean | undefined>)[key])}
                onChange={(e) => setOv(group, key, fromTri(e.target.value as Tri))}
              >
                <option value="">Inherit global</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            </Field>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-2">
        <Checkbox label="Active" help="Inactive sites are hidden from new tasks; history stays." checked={values.active} onChange={(e) => set('active', e.target.checked)} />
        <Checkbox label="Paused" help="Queued tasks for this site wait until unpaused." checked={values.paused} onChange={(e) => set('paused', e.target.checked)} />
      </div>
      <Field label="Notes" htmlFor="ws-notes">
        <Textarea id="ws-notes" rows={2} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={saving}>
          <Save className="h-4 w-4" /> {values.id ? 'Save website' : 'Add website'}
        </Button>
      </div>
    </form>
  );
}
