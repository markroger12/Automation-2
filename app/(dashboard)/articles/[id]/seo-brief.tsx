'use client';

import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Input, Select, Textarea } from '@/components/form';
import { Card, Chip } from '@/components/ui';
import { INTENTS, INTENT_LABEL, type SearchIntent } from '@/lib/seo/intent-labels';

interface Brief {
  intent: SearchIntent;
  confidence: string;
  reason: string;
  sections: string[];
  titleGuidance: string;
  metaGuidance: string;
  faqFocus: string;
  keywordGuideline: string;
  notes: string;
  editedByOwner: boolean;
}
interface BriefState {
  brief: Brief;
  suggested: Brief;
  coverage: { covered: string[]; missing: string[] } | null;
}

/** The article's search intent and SEO brief (upgrade 04): editable; used by the writing prompt and an informational check. */
export function SeoBriefCard({ taskId, readOnly }: { taskId: string; readOnly: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<BriefState | null>(null);
  const [draft, setDraft] = useState<Brief | null>(null);
  const [sections, setSections] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const apply = useCallback((s: BriefState) => {
    setState(s);
    setDraft(s.brief);
    setSections(s.brief.sections.join('\n'));
  }, []);
  useEffect(() => {
    api<BriefState>(`/api/tasks/${taskId}/seo-brief`)
      .then(apply)
      .catch((e: Error) => toast('error', e.message));
  }, [taskId, apply, toast]);
  if (!state || !draft) return <Card title="SEO brief"><p className="text-muted text-sm">Loading…</p></Card>;
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setDraft({ ...draft, [k]: v });
  async function save() {
    setBusy('save');
    try {
      apply(await api<BriefState>(`/api/tasks/${taskId}/seo-brief`, { method: 'PUT', body: { ...draft, sections: sections.split('\n').map((x) => x.trim()).filter(Boolean) } }));
      toast('success', 'SEO brief saved. It is used by the next writing prompt (regenerate the article to apply it).');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function reset() {
    setBusy('reset');
    try {
      apply(await api<BriefState>(`/api/tasks/${taskId}/seo-brief`, { method: 'DELETE' }));
      toast('success', 'Back to the suggested brief.');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          SEO brief <Chip tone="info">{INTENT_LABEL[state.brief.intent]}</Chip>
          {state.brief.editedByOwner ? <Chip>edited by you</Chip> : <Chip>suggested</Chip>}
        </span>
      }
      description={`Search intent suggested: ${INTENT_LABEL[state.suggested.intent]} (${state.suggested.confidence} — ${state.suggested.reason}). The brief guides the writing prompt; it never makes the app add facts or repeat the keyword.`}
    >
      <div className="grid gap-4 text-sm lg:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Search intent</span>
          <Select aria-label="Search intent" value={draft.intent} disabled={readOnly} onChange={(e) => set('intent', e.target.value as SearchIntent)}>
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {INTENT_LABEL[i]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Keyword guideline</span>
          <Input aria-label="Keyword guideline" value={draft.keywordGuideline} disabled={readOnly} maxLength={400} onChange={(e) => set('keywordGuideline', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 lg:row-span-2">
          <span className="text-muted text-xs">Sections to cover (one per line)</span>
          <Textarea aria-label="Sections to cover" rows={6} value={sections} disabled={readOnly} onChange={(e) => setSections(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Title guidance</span>
          <Input aria-label="Title guidance" value={draft.titleGuidance} disabled={readOnly} maxLength={400} onChange={(e) => set('titleGuidance', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Meta description guidance</span>
          <Input aria-label="Meta description guidance" value={draft.metaGuidance} disabled={readOnly} maxLength={400} onChange={(e) => set('metaGuidance', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">FAQ focus</span>
          <Input aria-label="FAQ focus" value={draft.faqFocus} disabled={readOnly} maxLength={400} onChange={(e) => set('faqFocus', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Notes for the writer</span>
          <Input aria-label="Notes for the writer" value={draft.notes} disabled={readOnly} maxLength={1000} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>
      {state.coverage ? (
        <p className="text-muted mt-3 text-sm">
          Written article covers {state.coverage.covered.length} of {state.brief.sections.length} sections
          {state.coverage.missing.length ? ` — not found as a heading: ${state.coverage.missing.join('; ')}` : ''}.
        </p>
      ) : null}
      {!readOnly ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void save()}>
            <Save className="h-4 w-4" /> Save brief
          </Button>
          <Button size="sm" variant="ghost" loading={busy === 'reset'} onClick={() => void reset()}>
            <RotateCcw className="h-4 w-4" /> Back to suggestion
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
