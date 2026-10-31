'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Eye, EyeOff, Globe, KeyRound, LogIn, Plus, SlidersHorizontal } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { PRESET_COUNTRIES } from '@/lib/domain';
import { Button, DialogSection, Modal, useToast } from '@/components/client';
import { Field, Input, Select } from '@/components/form';
import { cx } from '@/components/ui';

const LANGS = [
  { id: 'en', label: 'English', country: 'United States', timezone: 'America/New_York', line: 'Also read:' },
  { id: 'de', label: 'German', country: 'Germany', timezone: 'Europe/Berlin', line: 'Das könnte Ihnen gefallen:' },
] as const;

/** “https://www.celeb-news.de/” → “Celeb News”: a first name for the website from its address. */
export function nameFromUrl(url: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    const base = host.split('.').slice(0, -1).join(' ') || host;
    return base
      .split(/[-_. ]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  } catch {
    return '';
  }
}

/**
 * Websites → Add website (owner request: a cleaner window, and the WordPress user name and password with it so the
 * app logs in by itself). Only what is needed is open: the address, name, language, country and time zone, then the
 * sign-in; everything else is under “More options” and on the website's Settings tab later.
 */
export function AddWebsite({ startOpen }: { startOpen: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(startOpen);
  const [publicUrl, setPublicUrl] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  const [country, setCountry] = useState<string>('United States');
  const [timezone, setTimezone] = useState('America/New_York');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [more, setMore] = useState(false);
  const [adminUrl, setAdminUrl] = useState('');
  const [linkLine, setLinkLine] = useState('');
  const [editor, setEditor] = useState<'AUTO' | 'GUTENBERG' | 'CLASSIC'>('AUTO');
  const [gsc, setGsc] = useState('');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['Europe/Berlin', 'America/New_York', 'Europe/London', 'Asia/Karachi', 'UTC'];
    }
  }, []);
  const lang = LANGS.find((l) => l.id === language)!;
  const host = (() => {
    try {
      return new URL(/^https?:\/\//i.test(publicUrl) ? publicUrl : `https://${publicUrl}`).hostname;
    } catch {
      return '';
    }
  })();
  const halfLogin = Boolean(username.trim()) !== Boolean(password);
  const err = (k: string) => errors[k];

  function reset() {
    setPublicUrl('');
    setName('');
    setNameTouched(false);
    setUsername('');
    setPassword('');
    setShowPassword(false);
    setErrors({});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (halfLogin) {
      setErrors({ [username.trim() ? 'login.password' : 'login.username']: [username.trim() ? 'Enter the password too (or leave both empty).' : 'Enter the user name too (or leave both empty).'] });
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const url = publicUrl.trim() && !/^https?:\/\//i.test(publicUrl.trim()) ? `https://${publicUrl.trim()}` : publicUrl.trim();
      const res = await api<{ website: { id: string }; loginQueued: boolean }>('/api/websites', {
        body: {
          name: name.trim(),
          publicUrl: url,
          adminUrl: adminUrl.trim() || null,
          language,
          targetCountry: country,
          timezone,
          internalLinkLine: linkLine.trim() || null,
          editorType: editor,
          searchConsoleProperty: gsc.trim() || null,
          ...(username.trim() ? { login: { username: username.trim(), password } } : {}),
        },
      });
      toast('success', res.loginQueued ? 'Website added. The app is logging in to WordPress now.' : 'Website added. Save its WordPress sign-in on the Session tab to log in.');
      setOpen(false);
      reset();
      router.push(`/websites/${res.website.id}`);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError && error.fieldErrors) setErrors(error.fieldErrors);
      toast('error', (error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add website
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={760}
        title="Add WordPress website"
        description="The address and language, then the WordPress sign-in: the app logs in by itself and keeps the session."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="add-website" variant="primary" loading={saving}>
              {username.trim() ? <LogIn className="h-4 w-4" /> : <Plus className="h-4 w-4" />} {username.trim() ? 'Add and log in' : 'Add website'}
            </Button>
          </>
        }
      >
        <form id="add-website" onSubmit={submit} noValidate className="space-y-5">
          <DialogSection icon={<Globe className="h-4 w-4" />} title="Website">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Address" htmlFor="aw-url" required error={err('publicUrl')} help="The home page, e.g. https://example.com">
                <Input
                  id="aw-url"
                  value={publicUrl}
                  autoFocus
                  inputMode="url"
                  placeholder="https://example.com"
                  invalid={Boolean(err('publicUrl'))}
                  onChange={(e) => {
                    setPublicUrl(e.target.value);
                    if (!nameTouched) setName(nameFromUrl(e.target.value));
                  }}
                />
              </Field>
              <Field label="Name" htmlFor="aw-name" required error={err('name')} help="How the app shows it.">
                <Input
                  id="aw-name"
                  value={name}
                  placeholder="Celebrity News"
                  invalid={Boolean(err('name'))}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTouched(true);
                  }}
                />
              </Field>
              <Field label="Language" htmlFor="aw-lang" required help="Articles, headings and metadata.">
                <div id="aw-lang" role="radiogroup" aria-label="Language" className="surface-2 grid grid-cols-2 gap-1 rounded-lg p-1">
                  {LANGS.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      role="radio"
                      aria-checked={language === l.id}
                      onClick={() => {
                        setLanguage(l.id);
                        setCountry(l.country);
                        setTimezone(l.timezone);
                      }}
                      className={cx('h-8 rounded-md text-sm font-medium transition', language === l.id ? 'surface border shadow-sm' : 'text-muted hover:text-[var(--text)]')}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Target country" htmlFor="aw-country" required error={err('targetCountry')}>
                <Select id="aw-country" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {PRESET_COUNTRIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Time zone of the WordPress site" htmlFor="aw-tz" required error={err('timezone')} help="For publishing times.">
                <Input id="aw-tz" list="aw-timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} invalid={Boolean(err('timezone'))} />
                <datalist id="aw-timezones">
                  {timezones.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </Field>
            </div>
          </DialogSection>

          <DialogSection icon={<KeyRound className="h-4 w-4" />} title="WordPress login">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="User name or email" htmlFor="aw-user" error={err('login.username')}>
                <Input id="aw-user" value={username} autoComplete="off" spellCheck={false} placeholder="admin" invalid={Boolean(err('login.username'))} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label="Password" htmlFor="aw-pass" error={err('login.password')}>
                <div className="relative">
                  <Input
                    id="aw-pass"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    autoComplete="new-password"
                    className="pr-10"
                    invalid={Boolean(err('login.password'))}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} className="text-muted absolute inset-y-0 right-0 grid w-10 place-items-center hover:text-[var(--text)]" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
            </div>
            <p className="text-muted mt-3 text-xs">
              Saved encrypted on this computer only (in the data folder, never in a log or backup) and typed only into {host ? <strong>{host}</strong> : 'the website'}’s own login page, with “Remember me”. When WordPress asks for a CAPTCHA or a 2-step code, a window opens for that step. Leave both empty to sign in yourself.
            </p>
          </DialogSection>

          <div className="border-app rounded-lg border">
            <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium">
              <SlidersHorizontal className="text-muted h-4 w-4" aria-hidden /> More options
              <span className="text-muted text-xs font-normal">admin address, internal-link line, editor, Search Console</span>
              <ChevronDown className={cx('text-muted ml-auto h-4 w-4 transition', more && 'rotate-180')} aria-hidden />
            </button>
            {more ? (
              <div className="border-app grid gap-4 border-t p-4 sm:grid-cols-2">
                <Field label="Admin address" htmlFor="aw-admin" error={err('adminUrl')} help={`Empty: ${host ? `https://${host}` : '<address>'}/wp-admin/`}>
                  <Input id="aw-admin" value={adminUrl} placeholder="https://example.com/wp-admin/" onChange={(e) => setAdminUrl(e.target.value)} />
                </Field>
                <Field label="Internal-link line" htmlFor="aw-line" help={`Last line of every article. Empty: “${lang.line}”`}>
                  <Input id="aw-line" value={linkLine} placeholder={lang.line} onChange={(e) => setLinkLine(e.target.value)} />
                </Field>
                <Field label="Editor" htmlFor="aw-editor" help="Auto uses the editor the site has.">
                  <Select id="aw-editor" value={editor} onChange={(e) => setEditor(e.target.value as typeof editor)}>
                    <option value="AUTO">Auto-detect</option>
                    <option value="GUTENBERG">Block editor (Gutenberg)</option>
                    <option value="CLASSIC">Classic editor</option>
                  </Select>
                </Field>
                <Field label="Search Console property" htmlFor="aw-gsc" error={err('searchConsoleProperty')} help="Optional, e.g. sc-domain:example.com">
                  <Input id="aw-gsc" value={gsc} onChange={(e) => setGsc(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </div>
        </form>
      </Modal>
    </>
  );
}
