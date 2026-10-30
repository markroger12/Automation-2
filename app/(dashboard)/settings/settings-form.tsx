'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save, RotateCcw } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { SETTING_GROUPS, type SettingField } from '@/lib/settings-fields';
import type { Settings } from '@/lib/settings-schema';
import { Button, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Card, cx } from '@/components/ui';

type GroupId = (typeof SETTING_GROUPS)[number]['id'];
type Draft = Record<GroupId, Record<string, unknown>>;

function toDraft(settings: Settings): Draft {
  const draft = {} as Draft;
  for (const group of SETTING_GROUPS) {
    const values = settings[group.id] as Record<string, unknown>;
    draft[group.id] = {};
    for (const field of group.fields) {
      const v = values[field.key];
      draft[group.id][field.key] =
        field.type === 'list' ? (v as number[]).join(', ') : field.type === 'json' ? JSON.stringify(v, null, 2) : v;
    }
  }
  return draft;
}

function fromDraft(group: GroupId, fields: SettingField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.type === 'number') out[field.key] = typeof raw === 'number' ? raw : Number(raw);
    else if (field.type === 'list')
      out[field.key] = String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    else if (field.type === 'json') {
      try {
        out[field.key] = JSON.parse(String(raw || '{}'));
      } catch {
        throw new Error(`${group}.${field.key}: invalid JSON`);
      }
    } else out[field.key] = raw;
  }
  return out;
}

export function SettingsForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState(() => toDraft(initial));
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<GroupId | null>(null);
  // Owner request (less scrolling): one group at a time, picked on the left; unsaved changes of the others are kept.
  const [active, setActive] = useState<GroupId>(SETTING_GROUPS[0].id);
  const dirtyGroups = useMemo(
    () => new Set(SETTING_GROUPS.filter((g) => JSON.stringify(draft[g.id]) !== JSON.stringify(saved[g.id])).map((g) => g.id)),
    [draft, saved],
  );

  async function save(groupId: GroupId) {
    const group = SETTING_GROUPS.find((g) => g.id === groupId)!;
    setBusy(groupId);
    setErrors({});
    try {
      const values = fromDraft(groupId, group.fields, draft[groupId]);
      const res = await api<{ settings: Settings }>('/api/settings', { method: 'PUT', body: { settings: { [groupId]: values } } });
      const next = toDraft(res.settings);
      setSaved(next);
      setDraft(next);
      toast('success', `${group.title} saved.`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError && error.fieldErrors) setErrors(error.fieldErrors);
      toast('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="Settings groups" className="flex gap-1 overflow-x-auto lg:sticky lg:top-20 lg:flex-col">
        {SETTING_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            aria-current={active === group.id ? 'true' : undefined}
            onClick={() => setActive(group.id)}
            className={cx(
              'flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition',
              active === group.id ? 'bg-[var(--surface-2)] font-medium' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
            )}
          >
            {group.title}
            {dirtyGroups.has(group.id) ? <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Unsaved changes" aria-label="unsaved" /> : null}
          </button>
        ))}
      </nav>
      {SETTING_GROUPS.filter((group) => group.id === active).map((group) => (
        <Card
          key={group.id}
          title={
            <span className="flex items-center gap-2">
              {group.title}
              {dirtyGroups.has(group.id) ? <span className="rounded bg-amber-100 px-1.5 text-[11px] font-medium text-amber-800">unsaved</span> : null}
            </span>
          }
          description={group.description}
          actions={
            <>
              <Button size="sm" variant="ghost" disabled={!dirtyGroups.has(group.id)} onClick={() => setDraft((d) => ({ ...d, [group.id]: saved[group.id] }))}>
                <RotateCcw className="h-3.5 w-3.5" /> Discard
              </Button>
              <Button size="sm" variant="primary" disabled={!dirtyGroups.has(group.id)} loading={busy === group.id} onClick={() => save(group.id)}>
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
            </>
          }
        >
          <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
            {group.fields.map((field) => {
              const id = `${group.id}-${field.key}`;
              const value = draft[group.id][field.key];
              const error = errors[`settings.${group.id}.${field.key}`] ?? errors[`${group.id}.${field.key}`];
              const set = (v: unknown) => setDraft((d) => ({ ...d, [group.id]: { ...d[group.id], [field.key]: v } }));
              if (field.type === 'boolean') {
                return <Checkbox key={id} id={id} label={field.label} help={field.help} checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />;
              }
              const warn = field.warnAbove && Number(value) > field.warnAbove.value ? field.warnAbove.message : null;
              return (
                <Field key={id} label={field.label} htmlFor={id} help={warn ?? field.help} error={error} className={field.type === 'json' ? 'md:col-span-2' : undefined}>
                  {field.type === 'select' ? (
                    <Select id={id} value={String(value)} onChange={(e) => set(e.target.value)}>
                      {field.options!.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : field.type === 'json' ? (
                    <Textarea id={id} className="font-mono text-xs" rows={5} value={String(value)} onChange={(e) => set(e.target.value)} />
                  ) : (
                    <Input
                      id={id}
                      type={field.type === 'number' ? 'number' : 'text'}
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={String(value ?? '')}
                      onChange={(e) => set(field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
                      invalid={Boolean(error)}
                    />
                  )}
                  {warn ? <p className="text-xs font-medium text-amber-700">⚠ {warn}</p> : null}
                </Field>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}
