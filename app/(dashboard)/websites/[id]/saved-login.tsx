'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, KeyRound, LogIn, Pencil, Trash2 } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import type { SavedLogin as Saved } from '@/lib/wp-credentials';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Field, Input } from '@/components/form';
import { Chip, formatDateTime } from '@/components/ui';

/**
 * Website → Session tab → WordPress login (owner request: the app logs in by itself). Shows whether a sign-in is
 * saved, for which user and how the last automatic login went — the password is never sent back here.
 */
export function SavedLogin({ websiteId, host, initial }: { websiteId: string; host: string; initial: Saved | null }) {
  const router = useRouter();
  const toast = useToast();
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState(!initial);
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<'save' | 'login' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy('save');
    setErrors({});
    try {
      const r = await api<{ login: Saved }>(`/api/websites/${websiteId}/login`, { method: 'PUT', body: { username, password, logIn: true } });
      setSaved(r.login);
      setPassword('');
      setEditing(false);
      toast('success', 'Saved. The app is logging in to WordPress now.');
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError && error.fieldErrors) setErrors(error.fieldErrors);
      toast('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function logIn() {
    setBusy('login');
    try {
      await api(`/api/websites/${websiteId}/actions`, { body: { action: 'login' } });
      toast('success', 'Logging in. If WordPress asks for a code or a CAPTCHA, a window opens for that step.');
      router.refresh();
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    try {
      await api(`/api/websites/${websiteId}/login`, { method: 'DELETE' });
      setSaved(null);
      setUsername('');
      setEditing(true);
      setConfirmRemove(false);
      toast('success', 'The saved sign-in was removed. The browser session stays until WordPress ends it.');
      router.refresh();
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const last = saved?.last;
  return (
    <div className="space-y-4">
      {saved && !editing ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="surface-2 grid h-9 w-9 place-items-center rounded-lg" aria-hidden>
            <KeyRound className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              Saved for <span className="font-mono">{saved.username}</span>
            </div>
            <div className="text-muted text-xs">
              saved {formatDateTime(saved.savedAt)}
              {last ? (
                <>
                  {' · last automatic login '}
                  {formatDateTime(last.at)}{' '}
                  <Chip tone={last.ok ? 'success' : last.refused ? 'danger' : 'warning'}>{last.ok ? 'worked' : last.refused ? 'refused by WordPress' : 'needed your step'}</Chip>
                </>
              ) : null}
            </div>
            {last && !last.ok ? <p className="mt-1 text-xs text-amber-700">{last.detail}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" loading={busy === 'login'} onClick={() => void logIn()}>
              <LogIn className="h-3.5 w-3.5" /> Log in now
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Change
            </Button>
            <Button size="sm" variant="ghost" className="text-rose-600 dark:text-rose-400" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-3" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="User name or email" htmlFor="sl-user" error={errors.username}>
              <Input id="sl-user" value={username} autoComplete="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="sl-pass" error={errors.password}>
              <div className="relative">
                <Input id="sl-pass" type={show ? 'text' : 'password'} value={password} autoComplete="new-password" className="pr-10" onChange={(e) => setPassword(e.target.value)} />
                <button type="button" onClick={() => setShow((v) => !v)} className="text-muted absolute inset-y-0 right-0 grid w-10 place-items-center hover:text-[var(--text)]" aria-label={show ? 'Hide password' : 'Show password'}>
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={busy === 'save'} disabled={!username.trim() || !password}>
              <LogIn className="h-4 w-4" /> Save and log in
            </Button>
            {saved ? (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <p className="text-muted text-xs">
        Encrypted on this computer only (data folder; never in a log, backup or report) and typed only into <strong>{host}</strong>’s own login page, with “Remember me”. When the session ends, the app logs in again by itself. A CAPTCHA or a 2-step code opens a window for you; a password WordPress refuses is not tried again until you change it.
      </p>
      <ConfirmDialog open={confirmRemove} title="Remove the saved sign-in?" confirmLabel="Remove" tone="danger" busy={busy === 'remove'} onCancel={() => setConfirmRemove(false)} onConfirm={() => void remove()}>
        The app will no longer log in by itself on this website. The current browser session is not ended.
      </ConfirmDialog>
    </div>
  );
}
