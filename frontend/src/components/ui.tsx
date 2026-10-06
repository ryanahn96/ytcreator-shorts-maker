/** Small UI primitives shared by the studio panels. */

import type {ReactNode} from 'react';

export function Panel(props: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">{props.title}</h2>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

export function IconButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}

export function TextButton(props: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'plain';
  children: ReactNode;
}) {
  const tone =
    props.tone === 'primary'
      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
      : 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {props.children}
    </button>
  );
}

/**
 * A number input that commits on blur or Enter. The input remounts when
 * `value` changes, and shows `value` again when an edit is rejected.
 */
export function NumberField(props: {
  label: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  digits?: number;
  suffix?: string;
  onCommit: (value: number) => void;
}) {
  const shown =
    props.digits === undefined ? String(props.value) : props.value.toFixed(props.digits);
  const commit = (input: HTMLInputElement) => {
    const text = input.value.trim();
    const parsed = Number(text);
    if (text !== shown && text !== '' && Number.isFinite(parsed)) {
      const low = props.min ?? Number.NEGATIVE_INFINITY;
      const high = props.max ?? Number.POSITIVE_INFINITY;
      const clamped = Math.min(high, Math.max(low, parsed));
      if (clamped !== props.value) {
        props.onCommit(clamped);
      }
    }
    input.value = shown;
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-zinc-300">
      <span>{props.label}</span>
      <span className="flex items-center gap-1">
        <input
          key={shown}
          type="number"
          defaultValue={shown}
          step={props.step}
          min={props.min}
          max={props.max}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          className="w-24 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-xs text-zinc-100"
        />
        {props.suffix && <span className="text-zinc-500">{props.suffix}</span>}
      </span>
    </label>
  );
}

export function SliderField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs text-zinc-300">
      <span className="flex justify-between">
        <span>{props.label}</span>
        <span className="font-mono text-zinc-400">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="mt-1 w-full accent-indigo-500 disabled:opacity-40"
      />
    </label>
  );
}

const HEX_DIGITS = '0123456789ABCDEF';

/** `#RRGGBB` in upper case, or null when `text` is not such a color. */
function parseHexColor(text: string): string | null {
  const value = text.trim().toUpperCase();
  const digits = value.startsWith('#') ? value.slice(1) : value;
  if (digits.length !== 6 || [...digits].some((digit) => !HEX_DIGITS.includes(digit))) {
    return null;
  }
  return `#${digits}`;
}

/**
 * A color swatch plus a hex text box. The text commits on blur or Enter;
 * an invalid entry shows the current color again.
 */
export function ColorField(props: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const commit = (input: HTMLInputElement) => {
    const parsed = parseHexColor(input.value);
    if (parsed && parsed !== props.value.toUpperCase()) {
      props.onChange(parsed);
    }
    input.value = props.value.toUpperCase();
  };
  return (
    <div className={`flex items-center justify-between gap-2 text-xs text-zinc-300 ${props.disabled ? 'opacity-40' : ''}`}>
      <span>{props.label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="color"
          aria-label={props.label}
          value={props.value.toLowerCase()}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value.toUpperCase())}
          className="h-6 w-8 cursor-pointer rounded border border-zinc-700 bg-zinc-950 p-0.5 disabled:cursor-not-allowed"
        />
        <input
          key={props.value}
          aria-label={`${props.label} 코드`}
          defaultValue={props.value.toUpperCase()}
          disabled={props.disabled}
          maxLength={7}
          spellCheck={false}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-xs text-zinc-100"
        />
      </span>
    </div>
  );
}

/** An on/off checkbox with a label. */
export function Toggle(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-2 text-xs text-zinc-300 ${
        props.disabled ? 'opacity-40' : 'cursor-pointer'
      }`}
    >
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="h-4 w-4 accent-indigo-500"
      />
    </label>
  );
}

/** Radio-style choice among catalog entries (framing, transition). */
export function ChoiceList(props: {
  name: string;
  entries: readonly {kind: string; label: string; description: string}[];
  value: string;
  onChange: (kind: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      {props.entries.map((entry) => (
        <label
          key={entry.kind}
          className={`flex cursor-pointer gap-2 rounded-lg border px-3 py-2 text-xs ${
            entry.kind === props.value
              ? 'border-indigo-500 bg-indigo-500/10'
              : 'border-zinc-800 hover:border-zinc-700'
          }`}
        >
          <input
            type="radio"
            name={props.name}
            checked={entry.kind === props.value}
            onChange={() => props.onChange(entry.kind)}
            className="mt-0.5 accent-indigo-500"
          />
          <span>
            <span className="font-semibold text-zinc-100">{entry.label}</span>
            <span className="block text-zinc-400">{entry.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** A button-styled file input. */
export function FilePicker(props: {
  label: string;
  accept: string;
  busy: boolean;
  icon: ReactNode;
  onFile: (file: File) => void;
}) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 ${
        props.busy ? 'pointer-events-none opacity-50' : ''
      }`}
    >
      {props.icon}
      {props.busy ? '올리는 중…' : props.label}
      <input
        type="file"
        accept={props.accept}
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            props.onFile(file);
          }
        }}
      />
    </label>
  );
}

/** A row of mutually exclusive buttons. */
export function Segmented<T extends string>(props: {
  label: string;
  options: readonly {value: T; label: string; disabled?: boolean}[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="flex gap-1">
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={props.disabled || option.disabled}
            onClick={() => props.onChange(option.value)}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
              selected
                ? 'border-indigo-500 bg-indigo-500/15 text-zinc-100'
                : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
