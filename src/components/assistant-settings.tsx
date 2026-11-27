'use client';

import { useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, PlugZap, Sparkles, Trash2 } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { Button, ConfirmDialog, useToast } from './client';
import { Field, Input, Select } from './form';
import { Card, formatDateTime } from './ui';
import { openAssistant } from './assistant';

export interface AssistantSettingsView {
  configured: boolean;
  keyHint: string | null;
  model: string;
  savedAt: string | null;
}

/**
 * The models offered: Google's “-latest” names always point to its newest Flash models, so they keep working when an
 * older version is retired. Any other model name can be typed under “Other model”.
 */
const MODELS = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (newest) · recommended' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (newest) · faster, more free questions' },
];
const OTHER = '__other__';

/**
 * Settings → Help assistant (owner request 2026-11-12). The owner's own Gemini API key, stored encrypted on this PC and
 * never shown again (only its last 4 characters), the model, and a connection test.
 */
export function AssistantSettingsCard({ initial }: { initial: AssistantSettingsView }) {
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [key, setKey] = useState('');
  const known = MODELS.some((m) => m.id === initial.model);
  const [choice, setChoice] = useState(known ? initial.model : OTHER);
  const [custom, setCustom] = useState(known ? '' : initial.model);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const model = choice === OTHER ? custom.trim() : choice;
  const dirty = Boolean(key.trim()) || model !== s.model;

  const save = async () => {
    setBusy('save');
    setError(null);
    setTested(null);
    try {
      const next = await api<AssistantSettingsView>('/api/assistant/settings', { method: 'PUT', body: { apiKey: key.trim() || undefined, model } });
      setS(next);
      setKey('');
      toast('success', key.trim() ? 'API key saved (encrypted on this PC).' : 'Model saved.');
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    setError(null);
    setTested(null);
    try {
      const r = await api<{ model: string; ms: number }>('/api/assistant/test', { method: 'POST' });
      setTested(`Gemini answered in ${(r.ms / 1000).toFixed(1)} s with ${r.model}.`);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'The test failed.');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      setS(await api<AssistantSettingsView>('/api/assistant/settings', { method: 'PUT', body: { remove: true } }));
      setTested(null);
      toast('success', 'API key removed from this PC.');
    } catch (e) {
      toast('error', e instanceof ApiClientError ? e.message : 'Could not remove the key.');
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  return (
    <Card
      id="assistant"
      title="Help assistant (Google Gemini)"
      className="mb-6 scroll-mt-20"
      description="Answers questions about this app from the top bar's Ask button, using the app's current state. It uses your own free Gemini API key."
      actions={
        s.configured ? (
          <Button size="sm" variant="secondary" onClick={() => openAssistant()}>
            <Sparkles className="h-3.5 w-3.5" /> Open the assistant
          </Button>
        ) : null
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <Field
            label="Gemini API key"
            htmlFor="assistant-key"
            error={error}
            help={
              s.configured ? (
                <>Saved <span suppressHydrationWarning>{s.savedAt ? formatDateTime(s.savedAt) : ''}</span> · ends in ••••{s.keyHint}. Paste a new key only to replace it.</>
              ) : (
                <>
                  Make a free key at{' '}
                  <a className="link inline-flex items-center gap-0.5" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">
                    aistudio.google.com <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>{' '}
                  → Get API key → Create API key.
                </>
              )
            }
          >
            <Input
              id="assistant-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={s.configured ? `••••••••••••${s.keyHint ?? ''}` : 'Paste your Gemini API key'}
              invalid={Boolean(error)}
            />
          </Field>
          <Field label="Model" htmlFor="assistant-model" help="Flash answers well and fast. Flash-Lite allows more free questions per day.">
            <Select id="assistant-model" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value={OTHER}>Other model…</option>
            </Select>
            {choice === OTHER ? <Input className="mt-2" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="A model name from aistudio.google.com" aria-label="Model name" /> : null}
          </Field>
          {tested ? (
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400" role="status">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> {tested}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" loading={busy === 'save'} disabled={!dirty || busy !== null || (choice === OTHER && !custom.trim())} onClick={() => void save()}>
              <KeyRound className="h-3.5 w-3.5" /> Save
            </Button>
            <Button size="sm" loading={busy === 'test'} disabled={!s.configured || busy !== null || dirty} tip={dirty ? 'Save first' : undefined} onClick={() => void test()}>
              <PlugZap className="h-3.5 w-3.5" /> Test connection
            </Button>
            {s.configured ? (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Remove key
              </Button>
            ) : null}
          </div>
        </div>
        <div className="surface-2 text-muted space-y-2 rounded-lg p-4 text-xs leading-relaxed">
          <p className="text-[var(--text)] font-medium">Privacy</p>
          <p>The key is encrypted on this PC (like your WordPress passwords) and is never shown again, logged or put in a backup.</p>
          <p>Each question goes to Google with a short status of the app: states, counts and recent error messages. Passwords, keys, cookies and article texts are never sent. The assistant panel shows exactly what is sent.</p>
          <p>On the free tier, Google may use questions to improve its products. Do not type private information in a question.</p>
        </div>
      </div>
      <ConfirmDialog open={confirmRemove} title="Remove the Gemini API key?" confirmLabel="Remove key" tone="danger" busy={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setConfirmRemove(false)}>
        The help assistant stops answering until you add a key again. The key stays valid at Google; delete it there too if you no longer need it.
      </ConfirmDialog>
    </Card>
  );
}
