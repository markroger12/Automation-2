'use client';

import { useState } from 'react';
import { Plus, Save, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Input, Select } from '@/components/form';
import { Chip } from '@/components/ui';
import { resolveWriter, type SiteRoutingRule } from '@/lib/campaigns/router';

const WRITER_LABEL: Record<string, string> = { 'celebrity-writer': 'Celebrity Article Writer', 'tigram-writer': 'Tigram Article Writer' };

/** Per-website writer rules for bulk campaigns and the workflow (a row's own writer choice still wins). */
export function RoutingRules({ websiteId, language, initial }: { websiteId: string; language: string; initial: SiteRoutingRule[] }) {
  const toast = useToast();
  const [rules, setRules] = useState<SiteRoutingRule[]>(initial);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState('');
  const decision = probe.trim() ? resolveWriter({ keyword: probe, language, siteRules: rules.filter((r) => r.contains.trim().length >= 2) }) : null;

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ rules: SiteRoutingRule[] }>(`/api/websites/${websiteId}/routing-rules`, { method: 'PUT', body: { rules } });
      setRules(res.rules);
      toast('success', `Saved ${res.rules.length} rule(s).`);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      {rules.length === 0 ? <p className="text-muted">No rules: the Smart Router decides, and asks you when unsure.</p> : null}
      <ul className="space-y-2">
        {rules.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Keyword contains</span>
            <Input aria-label={`Rule ${i + 1} phrase`} className="w-48" value={r.contains} maxLength={80} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, contains: e.target.value } : x)))} />
            <span className="text-muted">→</span>
            <Select aria-label={`Rule ${i + 1} writer`} className="w-56" value={r.writer} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, writer: e.target.value as SiteRoutingRule['writer'] } : x)))}>
              <option value="celebrity-writer">{WRITER_LABEL['celebrity-writer']}</option>
              <option value="tigram-writer">{WRITER_LABEL['tigram-writer']}</option>
            </Select>
            <Button size="sm" variant="ghost" aria-label={`Remove rule ${i + 1}`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>
              <X className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={rules.length >= 50} onClick={() => setRules([...rules, { contains: '', writer: 'tigram-writer' }])}>
          <Plus className="h-4 w-4" /> Add rule
        </Button>
        <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
          <Save className="h-4 w-4" /> Save rules
        </Button>
      </div>
      <div className="border-app border-t pt-3">
        <label className="mb-1 block font-medium" htmlFor={`probe-${websiteId}`}>
          Try a keyword
        </label>
        <Input id={`probe-${websiteId}`} value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="e.g. best vpn apps" />
        {decision ? (
          <p className="mt-2" role="status">
            {decision.writer ? <Chip tone="brand">{WRITER_LABEL[decision.writer]}</Chip> : <Chip tone="warning">You choose (unclear)</Chip>} <span className="text-muted">{decision.rationale}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
