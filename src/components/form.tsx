import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './ui';

const controlBase =
  'surface w-full rounded-md border px-3 py-2 text-sm placeholder:text-[var(--text-muted)] focus:border-[color-mix(in_oklab,var(--text)_40%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--text)_12%,transparent)] disabled:opacity-60';

export function Field({
  label,
  htmlFor,
  required,
  help,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  help?: ReactNode;
  error?: string | string[] | null;
  children: ReactNode;
  className?: string;
}) {
  const errors = Array.isArray(error) ? error : error ? [error] : [];
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
        {required ? (
          <span className="ml-0.5 text-rose-600" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {help && errors.length === 0 ? (
        <p id={htmlFor ? `${htmlFor}-help` : undefined} className="text-muted text-xs">
          {help}
        </p>
      ) : null}
      {errors.map((e, i) => (
        <p key={i} id={htmlFor && i === 0 ? `${htmlFor}-error` : undefined} className="text-xs font-medium text-rose-600" role="alert">
          {e}
        </p>
      ))}
    </div>
  );
}

export function Input({ className, invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...props} aria-invalid={invalid || undefined} className={cx(controlBase, invalid && 'border-rose-400', className)} />;
}

export function Textarea({ className, invalid, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...props} aria-invalid={invalid || undefined} className={cx(controlBase, 'min-h-[80px]', invalid && 'border-rose-400', className)} />;
}

export function Select({ className, invalid, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...props} aria-invalid={invalid || undefined} className={cx(controlBase, 'pr-8', invalid && 'border-rose-400', className)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, help, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; help?: ReactNode }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-2.5 text-sm', className)}>
      <input type="checkbox" {...props} className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-[var(--primary)]" />
      <span>
        <span className="font-medium">{label}</span>
        {help ? <span className="text-muted block text-xs">{help}</span> : null}
      </span>
    </label>
  );
}

/**
 * An on/off setting as a bordered row with a switch on the right (as in the reference dashboard's “Status: Active”).
 * It is a real checkbox with role="switch", so forms, labels and keyboards work as before.
 */
export function Switch({ label, help, className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; help?: ReactNode }) {
  return (
    <label className={cx('border-app flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-3', className)}>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {help ? <span className="text-muted block text-xs">{help}</span> : null}
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <input type="checkbox" role="switch" {...props} className="peer sr-only" />
        <span className="h-5 w-9 rounded-full bg-zinc-300 transition peer-checked:bg-[var(--primary)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color-mix(in_oklab,var(--text)_55%,transparent)] peer-disabled:opacity-50 dark:bg-zinc-600" aria-hidden />
        <span className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4 dark:peer-checked:bg-[var(--primary-fg)]" aria-hidden />
      </span>
    </label>
  );
}
