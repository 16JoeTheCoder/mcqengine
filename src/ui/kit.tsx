import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';

type BtnProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'ghost' | 'danger' | 'default';
  size?: 'sm' | 'lg';
  icon?: boolean;
  block?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Button({ variant = 'default', size, icon, block, class: cls, type = 'button', ...rest }: BtnProps) {
  const c = ['jy-btn', variant !== 'default' && `jy-btn--${variant}`, size && `jy-btn--${size}`, icon && 'jy-btn--icon', block && 'jy-btn--block', cls]
    .filter(Boolean)
    .join(' ');
  return <button type={type} class={c} {...rest} />;
}

export type Status = 'ok' | 'warn' | 'bad' | 'neutral' | 'ink';
/** Status is always shape + word + colour. */
export function Badge({ status, children }: { status: Status; children: ComponentChildren }) {
  return <span class={`jy-badge jy-badge--${status}`}>{children}</span>;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const openModals: HTMLElement[] = [];

/** Accessible modal: focus is trapped inside and restored on close; Esc closes. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
  dismissable = true,
  describedBy,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  size?: 'wide' | 'full';
  dismissable?: boolean;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    openModals.push(el);
    const first = el.querySelector<HTMLElement>('[autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== el) return;
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const a = items[0]!;
        const z = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      openModals.splice(openModals.indexOf(el), 1);
      if (!openModals.length) document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [dismissable]);
  return (
    <div class="backdrop" onMouseDown={(e) => dismissable && e.target === e.currentTarget && onClose()}>
      <div ref={ref} class={`modal${size ? ` modal--${size}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} aria-describedby={describedBy} tabIndex={-1}>
        <div class="modal-head">
          <h2 id={id}>{title}</h2>
          {dismissable && (
            <Button variant="ghost" icon onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </Button>
          )}
        </div>
        {children}
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label class="toggle">
      <span>
        {label}
        {hint && <span class="small subtle" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span class="track" aria-hidden="true" />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} key={o.value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Ring({ value, size = 56, label, stroke = 5, text }: { value: number | null; size?: number; label?: string; stroke?: number; text?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <svg class="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? (value === null ? 'No score yet' : `${Math.round(v * 100)}%`)}>
      <circle class="track" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={stroke} />
      <circle
        class="val"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke-width={stroke}
        stroke-dasharray={c}
        stroke-dashoffset={c * (1 - v)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        stroke-linecap="butt"
      />
      <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-size={Math.max(12, size * (text ? 0.22 : 0.26))}>
        {text ?? (value === null ? '—' : Math.round(v * 100))}
        {!text && value !== null && <tspan font-size={Math.max(12, size * 0.14)} fill="var(--ink-muted)">%</tspan>}
      </text>
    </svg>
  );
}

/** Counter roll for KPI numbers (instant under reduced motion). */
export function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');
    if (reduce) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 640);
      const e = 1 - Math.pow(1 - k, 4);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}

export function Popover({ label, children }: { label: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Icon name="help" size={16} /> {label}
      </Button>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)}>
          <div class="prose small">{children}</div>
        </Modal>
      )}
    </>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="jy-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div class="skel" style={{ height: `${h}px` }} aria-hidden="true" />;
}

/** Lazily loaded pages call this once rendered, so focus does not stay on <body>. */
export function focusMainIfLost() {
  requestAnimationFrame(() => {
    if (document.activeElement === document.body) document.getElementById('main')?.focus({ preventScroll: true });
  });
}

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}`);

export function fmtDate(t?: number): string {
  if (!t) return '—';
  return new Date(t).toISOString().slice(0, 10);
}
/** Numbers with thin-space thousands, per the standard. */
export const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
export const plural = (n: number, w: string) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;

export function relDay(t?: number, now = Date.now()): string {
  if (!t) return 'Not practised yet';
  const d = Math.floor((now - t) / 86_400_000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d} days ago`;
  return fmtDate(t);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; hidden?: boolean }
/**
 * A small action menu (button + list). Arrow keys move between items, Escape and outside clicks
 * close it, focus returns to the button. Used where secondary actions would clutter a card.
 */
export function Menu({ label, items, buttonLabel = 'More' }: { label: string; items: MenuItem[]; buttonLabel?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => { if (!list.current?.contains(e.target as Node) && e.target !== btn.current) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  if (!shown.length) return null;
  const close = () => { setOpen(false); btn.current?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    const els = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); els[e.key === 'Home' ? 0 : els.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div class="menu-wrap">
      <button ref={btn} type="button" class="jy-btn jy-btn--ghost jy-btn--sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} onClick={() => setOpen(!open)}>
        {buttonLabel} <Icon name="down" size={16} />
      </button>
      {open && (
        <div ref={list} id={id} class="menu" role="menu" aria-label={label} onKeyDown={onKey}>
          {shown.map((it) => (
            <button key={it.label} type="button" role="menuitem" class={`menu-item${it.danger ? ' menu-item--danger' : ''}`} onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
