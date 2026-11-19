import { useLayoutEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const themeKey = 'dfg2-migration-studio:theme:v1';

export default function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem(themeKey) === 'dark');
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  return <button className="button" title={`Switch to ${dark ? 'light' : 'dark'} mode`} onClick={() => {
    const next = !dark;
    localStorage.setItem(themeKey, next ? 'dark' : 'light');
    setDark(next);
  }}>{dark ? <Sun size={15} /> : <Moon size={15} />}{dark ? 'Light mode' : 'Dark mode'}</button>;
}
