/**
 * UI primitives shared by the studio screens, in the Material 3 style of
 * the Gemini web app: pill buttons, large rounded cards, tonal selection
 * and state layers that take the content color.
 */

import {useEffect, useId, useRef, type ReactNode} from 'react';

import {Icon, type IconName} from './Icon';

/**
 * Hover/focus/press overlay in the content color (Material 3 state layer).
 * The element's own background stays below it and its content above.
 */
export const STATE_LAYER =
  'relative isolate overflow-hidden before:pointer-events-none ' +
  'before:absolute before:inset-0 before:-z-10 before:bg-current ' +
  'before:opacity-0 before:transition-opacity hover:before:opacity-8 ' +
  'focus-visible:before:opacity-10 active:before:opacity-12 ' +
  'disabled:before:hidden';

type ButtonVariant =
  | 'filled'
  | 'tonal'
  | 'outlined'
  | 'text'
  | 'danger'
  | 'gradient';

const FILLED_DISABLED =
  'disabled:bg-on-surface/12 disabled:bg-none disabled:text-on-surface/38 ' +
  'disabled:shadow-none';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  filled: `bg-primary text-on-primary hover:shadow-sm ${FILLED_DISABLED}`,
  tonal:
    'bg-secondary-container text-on-secondary-container hover:shadow-sm ' +
    FILLED_DISABLED,
  outlined:
    'border border-outline text-primary disabled:border-on-surface/12 ' +
    'disabled:text-on-surface/38',
  text: 'text-primary disabled:text-on-surface/38',
  danger: `bg-action text-white hover:shadow-md ${FILLED_DISABLED}`,
  gradient: `brand-gradient text-white hover:shadow-lg ${FILLED_DISABLED}`,
};

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 px-3 text-[13px]',
  md: 'h-10 gap-2 px-5 text-sm',
  lg: 'h-14 gap-2.5 px-8 text-base',
} as const;

export function buttonClass(
  variant: ButtonVariant = 'filled',
  size: keyof typeof BUTTON_SIZES = 'md',
): string {
  return [
    'inline-flex shrink-0 items-center justify-center rounded-full',
    'font-medium tracking-[0.01em] whitespace-nowrap transition-shadow',
    'disabled:cursor-not-allowed',
    STATE_LAYER,
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
  ].join(' ');
}

export function Button(props: {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
  icon?: IconName;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const iconSize = props.size === 'sm' ? 18 : 20;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={`${buttonClass(props.variant, props.size)} ${props.className ?? ''}`}
    >
      {props.icon && <Icon name={props.icon} size={iconSize} />}
      {props.children}
    </button>
  );
}

type IconButtonVariant = 'standard' | 'filled';

const ICON_BUTTON_VARIANTS: Record<IconButtonVariant, string> = {
  standard: 'text-on-surface-variant disabled:text-on-surface/38',
  filled:
    'bg-primary text-on-primary disabled:bg-on-surface/12 ' +
    'disabled:text-on-surface/38',
};

export function iconButtonClass(
  variant: IconButtonVariant = 'standard',
  size: 'sm' | 'md' = 'md',
): string {
  const box = {sm: 'h-8 w-8', md: 'h-10 w-10'}[size];
  return [
    'inline-grid shrink-0 place-items-center rounded-full',
    'disabled:cursor-not-allowed',
    STATE_LAYER,
    ICON_BUTTON_VARIANTS[variant],
    box,
  ].join(' ');
}

export function IconButton(props: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  variant?: IconButtonVariant;
  size?: 'sm' | 'md';
  filled?: boolean;
  className?: string;
}) {
  const iconSize = {sm: 18, md: 22}[props.size ?? 'md'];
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`${iconButtonClass(props.variant, props.size)} ${props.className ?? ''}`}
    >
      <Icon name={props.icon} size={iconSize} filled={props.filled} />
    </button>
  );
}

/** A large rounded surface that groups one part of the editor. */
export function Card(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] bg-surface-container p-4">
      {(props.title || props.actions) && (
        <header className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-2 pl-2">
          <h2 className="text-base font-medium text-on-surface">{props.title}</h2>
          {props.actions}
        </header>
      )}
      {props.children}
    </section>
  );
}

/**
 * A titled group of controls; groups after the first get a divider.
 * `anchor` names the section (data-anchor) so the preview's click-to-focus
 * can scroll to it (see lib/focus.ts).
 */
export function Section(props: {
  title: string;
  anchor?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-anchor={props.anchor}
      className="space-y-3 border-t border-outline-variant/70 pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-on-surface">{props.title}</h3>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

/** Class of a text input in the studio's outlined field style. */
export const TEXT_FIELD =
  'h-9 rounded-lg border border-outline-variant bg-surface px-2.5 text-sm ' +
  'text-on-surface tabular-nums transition-colors hover:border-outline ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:opacity-40';

/**
 * A number input that commits on blur or Enter. The input remounts when
 * `value` changes, and shows `value` again when an edit is rejected.
 */
export function NumberField(props: {
  label: string;
  value: number;
  step: number;
  min: number;
  digits: number;
  suffix: string;
  onCommit: (value: number) => void;
}) {
  const shown = props.value.toFixed(props.digits);
  const commit = (input: HTMLInputElement) => {
    const text = input.value.trim();
    const parsed = Number(text);
    if (text !== shown && text !== '' && Number.isFinite(parsed)) {
      const clamped = Math.max(props.min, parsed);
      if (clamped !== props.value) {
        props.onCommit(clamped);
      }
    }
    input.value = shown;
  };
  return (
    <label className="flex items-center justify-between gap-2 text-sm text-on-surface-variant">
      <span className="tabular-nums">{props.label}</span>
      <span className="flex items-center gap-1.5">
        <input
          key={shown}
          type="number"
          defaultValue={shown}
          step={props.step}
          min={props.min}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          className={`${TEXT_FIELD} w-24 text-right`}
        />
        <span className="text-on-surface-variant">{props.suffix}</span>
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
    <label
      className={`block text-sm text-on-surface-variant ${props.disabled ? 'opacity-40' : ''}`}
    >
      <span className="flex justify-between gap-2">
        <span>{props.label}</span>
        <span className="tabular-nums text-on-surface">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="mt-1 h-6 w-full cursor-pointer disabled:cursor-not-allowed"
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
    <div
      className={`flex items-center justify-between gap-2 text-sm text-on-surface-variant ${
        props.disabled ? 'opacity-40' : ''
      }`}
    >
      <span>{props.label}</span>
      <span className="flex items-center gap-2">
        <input
          type="color"
          aria-label={props.label}
          value={props.value.toLowerCase()}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value.toUpperCase())}
          className="h-8 w-8 cursor-pointer rounded-full border border-outline-variant bg-transparent p-0.5 disabled:cursor-not-allowed"
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
          className={`${TEXT_FIELD} w-24 uppercase`}
        />
      </span>
    </div>
  );
}

/** An on/off switch with a label. */
export function Toggle(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const {checked} = props;
  return (
    <label
      className={`flex items-center justify-between gap-2 text-sm text-on-surface-variant ${
        props.disabled ? 'opacity-40' : 'cursor-pointer'
      }`}
    >
      <span>{props.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full border-2 transition-colors disabled:cursor-not-allowed ${
          checked
            ? 'border-primary bg-primary'
            : 'border-outline bg-surface-container-highest'
        }`}
      >
        <span
          className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all ${
            checked
              ? 'left-[calc(100%-1.375rem)] h-5 w-5 bg-on-primary'
              : 'left-1 h-4 w-4 bg-outline'
          }`}
        />
      </button>
    </label>
  );
}


/** A button-styled file input. */
export function FilePicker(props: {
  label: string;
  accept: string;
  busy: boolean;
  icon: IconName;
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
  onFile: (file: File) => void;
}) {
  return (
    <label
      className={`${buttonClass(props.variant ?? 'tonal', props.size ?? 'sm')} cursor-pointer has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-primary ${
        props.busy ? 'pointer-events-none opacity-50' : ''
      }`}
    >
      <Icon name={props.icon} size={props.size === 'md' ? 20 : 18} />
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

/** A row of mutually exclusive options in a tonal pill. */
export function Segmented<T extends string>(props: {
  label: string;
  options: readonly {value: T; label: string}[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className="flex gap-1 rounded-full bg-surface-container-high p-1"
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            className={`h-8 min-w-0 flex-1 truncate rounded-full px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${STATE_LAYER} ${
              selected
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A linear progress bar: `value` 0..1, or indeterminate when omitted. */
export function ProgressBar(props: {
  value?: number;
  gradient?: boolean;
  className?: string;
  label: string;
}) {
  const {value} = props;
  const tone = props.gradient ? 'brand-gradient' : 'text-primary';
  if (value === undefined) {
    return (
      <div
        role="progressbar"
        aria-label={props.label}
        className={`progress-track progress-indeterminate ${tone} ${props.className ?? ''}`}
      />
    );
  }
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={`progress-track ${props.className ?? ''}`}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-200"
        style={{width: `${clamped * 100}%`}}
      />
    </div>
  );
}

/** An inline message; `onClose` adds a close button. */
export function Notice(props: {
  tone: 'error' | 'warning';
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  const error = props.tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`flex items-start gap-3 rounded-2xl px-4 py-3 text-sm ${
        error
          ? 'bg-error-container text-on-error-container'
          : 'bg-surface-container-high text-on-surface'
      } ${props.className ?? ''}`}
    >
      <Icon
        name={error ? 'error' : 'warning'}
        className={error ? 'mt-px' : 'mt-px text-warning'}
      />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{props.children}</div>
      {props.onClose && (
        <IconButton
          label="닫기"
          icon="close"
          size="sm"
          onClick={props.onClose}
          className="-my-1 -mr-2"
        />
      )}
    </div>
  );
}

/**
 * A modal dialog on the native <dialog> element: focus is trapped, Escape
 * and a click on the backdrop close it.
 */
export function Dialog(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
  /** Max width in CSS pixels. */
  width: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (props.open && !dialog.open) {
      dialog.showModal();
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
      className="w-[calc(100vw-2rem)] rounded-[28px] border-0 bg-surface-container-high p-0 text-on-surface shadow-2xl backdrop:bg-[rgb(0_0_0/0.45)]"
      style={{maxWidth: props.width}}
    >
      {props.open && (
        <div className="flex max-h-[calc(100dvh-4rem)] flex-col">
          <h2 id={titleId} className="px-6 pt-6 text-2xl font-normal text-on-surface">
            {props.title}
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-2 text-sm text-on-surface-variant">
            {props.children}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-6 pt-2 pb-6">
            {props.actions}
          </div>
        </div>
      )}
    </dialog>
  );
}

/** A short message at the bottom of the screen that hides itself after 10 s. */
export function Snackbar(props: {
  message: string;
  onClose: () => void;
}) {
  const {onClose} = props;
  useEffect(() => {
    const timer = window.setTimeout(onClose, 10000);
    return () => window.clearTimeout(timer);
  }, [onClose, props.message]);
  return (
    <div
      role="status"
      className="rise-in fixed bottom-6 left-1/2 z-50 flex w-max max-w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl bg-inverse-surface py-3 pr-2 pl-4 text-sm text-inverse-on-surface shadow-lg"
    >
      <p className="line-clamp-3 min-w-0 flex-1 py-1 whitespace-pre-wrap" title={props.message}>
        {props.message}
      </p>
      <button
        type="button"
        aria-label="닫기"
        title="닫기"
        onClick={onClose}
        className={iconButtonClass('standard', 'sm')}
      >
        <Icon name="close" size={18} className="text-inverse-on-surface" />
      </button>
    </div>
  );
}
