'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Pipette } from 'lucide-react';
import { cx } from './ui';

/**
 * Color picker in the app's theme (owner request: the browser's color popup does not match the app's look). Same
 * value as `<input type="color">`: '#rrggbb'. Saturation/brightness area and hue bar (mouse and keyboard), hex and
 * R G B fields, the screen eyedropper where the browser has one, and ready swatches.
 */

const PRESETS = ['#ffffff', '#000000', '#111827', '#6b7280', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e', '#10b981', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899'];

type Hsv = { h: number; s: number; v: number };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const HEX6 = /^#[0-9a-f]{6}$/i;

export function hexToRgb(hex: string): [number, number, number] {
  const h = HEX6.test(hex) ? hex.slice(1) : '000000';
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export function ColorPicker({
  id,
  value,
  onChange,
  ariaLabel,
  swatches = [],
  dim,
  wide,
  className,
}: {
  /** Id of the trigger button (for a <label htmlFor>). */
  id?: string;
  value: string;
  onChange: (hex: string) => void;
  ariaLabel: string;
  /** Extra swatches shown first (e.g. the template's accent). */
  swatches?: { color: string; label: string }[];
  /** The field's value is not this color (none, transparent, rgba): the swatch is shown faded. */
  dim?: boolean;
  /** Full-width trigger with the hex code. */
  wide?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(...hexToRgb(value)));
  const [hexText, setHexText] = useState(value);
  const [place, setPlace] = useState<{ up: boolean; right: boolean }>({ up: false, right: false });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const [hasDropper, setHasDropper] = useState(false);
  useEffect(() => setHasDropper('EyeDropper' in window), []);

  // Follow a value changed outside (typed hex, undo) unless it is the color shown now.
  useEffect(() => {
    if (HEX6.test(value) && rgbToHex(...hsvToRgb(hsv)) !== value.toLowerCase()) setHsv(rgbToHsv(...hexToRgb(value)));
    setHexText(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPlace({ up: r.bottom + 340 > window.innerHeight && r.top > 340, right: r.left + 264 > window.innerWidth - 8 });
    const outside = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    area.current?.focus();
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const apply = (next: Hsv) => {
    setHsv(next);
    const hex = rgbToHex(...hsvToRgb(next));
    setHexText(hex);
    onChange(hex);
  };
  const setHex = (hex: string) => {
    const h = hex.toLowerCase();
    setHsv(rgbToHsv(...hexToRgb(h)));
    setHexText(h);
    onChange(h);
  };

  const drag = (el: HTMLDivElement | null, e: ReactPointerEvent, pick: (x: number, y: number) => void) => {
    if (!el) return;
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      pick(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
    };
    el.setPointerCapture(e.pointerId);
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const keyStep = (e: KeyboardEvent, onArrow: (dx: number, dy: number) => void) => {
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      onArrow(...moves[e.key]);
    }
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const [r, g, b] = hsvToRgb(hsv).map(Math.round) as [number, number, number];
  const shown = rgbToHex(r, g, b);
  const hueColor = rgbToHex(...hsvToRgb({ h: hsv.h, s: 1, v: 1 }));

  return (
    <div ref={root} className={cx('relative', wide ? 'block' : 'inline-block shrink-0', className)}>
      <button
        ref={trigger}
        id={id}
        type="button"
        aria-label={`${ariaLabel}: ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx('border-app flex items-center gap-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-indigo-300 dark:focus:ring-indigo-800', wide ? 'surface h-9 w-full px-1.5 text-sm' : 'h-8 w-9 justify-center p-1')}
      >
        <span className={cx('h-full rounded', wide ? 'w-7' : 'w-full', dim && 'opacity-30')} style={{ background: value, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,.35)' }} />
        {wide ? <span className="font-mono text-xs uppercase">{value}</span> : null}
      </button>
      {open ? (
        <div
          id={dialogId}
          role="dialog"
          aria-label={ariaLabel}
          onKeyDown={(e) => {
            // Keys typed here belong to the picker (the designer would otherwise nudge or delete the layer).
            e.stopPropagation();
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          className={cx('surface absolute z-50 w-64 space-y-3 rounded-xl border p-3 shadow-[0_12px_32px_rgba(0,0,0,0.28)]', place.up ? 'bottom-full mb-1' : 'top-full mt-1', place.right ? 'right-0' : 'left-0')}
        >
          <div
            ref={area}
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(hsv.s * 100)}
            aria-valuetext={`saturation ${Math.round(hsv.s * 100)} %, brightness ${Math.round(hsv.v * 100)} %`}
            onPointerDown={(e) => drag(area.current, e, (x, y) => apply({ ...hsv, s: x, v: 1 - y }))}
            onKeyDown={(e) => keyStep(e, (dx, dy) => apply({ ...hsv, s: clamp(hsv.s + dx / 100, 0, 1), v: clamp(hsv.v + dy / 100, 0, 1) }))}
            className="relative h-36 cursor-crosshair touch-none rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
          >
            <span className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4)]" style={{ left: `${hsv.s * 100}%`, bottom: `${hsv.v * 100}%`, background: shown }} />
          </div>
          <div className="flex items-center gap-2">
            {hasDropper ? (
              <button
                type="button"
                aria-label="Pick a color from the screen"
                title="Pick a color from the screen"
                onClick={async () => {
                  try {
                    const result = await new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper().open();
                    if (HEX6.test(result.sRGBHex)) setHex(result.sRGBHex);
                  } catch {
                    // cancelled
                  }
                }}
                className="text-muted rounded-md p-1 hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10"
              >
                <Pipette className="h-4 w-4" />
              </button>
            ) : null}
            <span className="h-7 w-7 shrink-0 rounded-full" style={{ background: shown, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,.35)' }} aria-hidden />
            <div
              ref={bar}
              role="slider"
              tabIndex={0}
              aria-label="Hue"
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(hsv.h)}
              onPointerDown={(e) => drag(bar.current, e, (x) => apply({ ...hsv, h: Math.min(359.9, x * 360) }))}
              onKeyDown={(e) => keyStep(e, (dx, dy) => apply({ ...hsv, h: (hsv.h + dx + dy + 360) % 360 }))}
              className="relative h-3 flex-1 cursor-pointer touch-none rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              style={{ background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}
            >
              <span className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4)]" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
            </div>
          </div>
          <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-1.5 text-center text-[11px]">
            <label className="space-y-0.5">
              <input
                value={hexText}
                maxLength={7}
                aria-label="Hex"
                onChange={(e) => {
                  const t = e.target.value.trim();
                  setHexText(t);
                  const full = t.startsWith('#') ? t : `#${t}`;
                  if (HEX6.test(full)) setHex(full);
                }}
                className="surface w-full rounded-md border px-1.5 py-1 text-center font-mono text-xs uppercase focus:border-indigo-400 focus:outline-none"
              />
              <span className="text-muted">Hex</span>
            </label>
            {(['R', 'G', 'B'] as const).map((c, i) => (
              <label key={c} className="space-y-0.5">
                <input
                  type="number"
                  min={0}
                  max={255}
                  aria-label={c === 'R' ? 'Red' : c === 'G' ? 'Green' : 'Blue'}
                  value={[r, g, b][i]}
                  onChange={(e) => {
                    const rgb: [number, number, number] = [r, g, b];
                    rgb[i] = clamp(Number(e.target.value) || 0, 0, 255);
                    setHex(rgbToHex(...rgb));
                  }}
                  className="surface w-full rounded-md border px-1 py-1 text-center text-xs tabular-nums focus:border-indigo-400 focus:outline-none"
                />
                <span className="text-muted">{c}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label="Swatches">
            {[...swatches, ...PRESETS.map((c) => ({ color: c, label: c }))].map((s, i) => (
              <button
                key={`${s.color}-${i}`}
                type="button"
                title={s.label}
                aria-label={`Use ${s.label}`}
                onClick={() => setHex(s.color)}
                className={cx('h-5 w-5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400', s.color.toLowerCase() === shown && 'ring-2 ring-indigo-500 ring-offset-1 ring-offset-[var(--surface)]')}
                style={{ background: s.color, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,.35)' }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
