/**
 * The color theme. It follows the device until the user picks light or
 * dark; the choice is saved in localStorage under the key that the
 * pre-paint script in index.html reads.
 */

import {useCallback, useEffect, useState} from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    // Storage can be blocked; the device setting applies then.
    return 'system';
  }
}

function applyTheme(choice: ThemeChoice): void {
  const dark =
    choice === 'dark' || (choice === 'system' && matchMedia(DARK_QUERY).matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);

  useEffect(() => {
    applyTheme(choice);
    if (choice !== 'system') {
      return;
    }
    const query = matchMedia(DARK_QUERY);
    const follow = () => applyTheme('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    try {
      if (next === 'system') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Without storage the choice lasts until the page reloads.
    }
    setChoice(next);
  }, []);

  return {choice, choose};
}
