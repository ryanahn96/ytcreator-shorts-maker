/** Header menu that picks the color theme: system, light or dark. */

import {useEffect, useId, useRef, useState} from 'react';

import {useTheme, type ThemeChoice} from '../hooks/useTheme';
import {Icon, type IconName} from './Icon';
import {iconButtonClass, STATE_LAYER} from './ui';

const OPTIONS: readonly {value: ThemeChoice; label: string; icon: IconName}[] = [
  {value: 'system', label: '시스템', icon: 'brightness_auto'},
  {value: 'light', label: '라이트', icon: 'light_mode'},
  {value: 'dark', label: '다크', icon: 'dark_mode'},
];

export function ThemeMenu() {
  const {choice, choose} = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = OPTIONS.find((option) => option.value === choice) ?? OPTIONS[0];
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label="테마"
        title={`테마: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={iconButtonClass('standard', 'md')}
      >
        <Icon name={current.icon} size={22} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="테마"
          className="rise-in absolute end-0 top-full z-40 mt-2 min-w-44 rounded-2xl bg-surface py-2 shadow-lg ring-1 ring-outline-variant/50 dark:bg-surface-container-high"
        >
          {OPTIONS.map((option) => {
            const selected = option.value === choice;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  choose(option.value);
                  setOpen(false);
                }}
                className={`flex h-11 w-full items-center gap-3 px-4 text-sm text-on-surface ${STATE_LAYER}`}
              >
                <Icon name={option.icon} className="text-on-surface-variant" />
                <span className="flex-1 text-start">{option.label}</span>
                {selected && <Icon name="check" className="text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
