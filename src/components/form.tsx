import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './ui';

const controlBase =
  'surface w-full rounded-lg border px-3 py-2 text-sm shadow-[inset_0_1px_1px_rgba(16,24,40,0.03)] placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900 disabled:opacity-60';

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
      <input type="checkbox" {...props} className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-indigo-600" />
      <span>
        <span className="font-medium">{label}</span>
        {help ? <span className="text-muted block text-xs">{help}</span> : null}
      </span>
    </label>
  );
}
