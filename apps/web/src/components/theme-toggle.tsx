"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "cascade-theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Runs before paint (inline in <head>) so a stored theme never flashes. */
export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(readTheme()), []);
  const cycle = (): void => {
    const next = NEXT[theme];
    setTheme(next);
    applyTheme(next);
    try {
      if (next === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // Storage can be blocked; the theme still applies for this page view.
    }
  };
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <button type="button" onClick={cycle} className="grid size-11 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink active:bg-surface-2 sm:size-9" aria-label={`Theme: ${theme}. Switch to ${NEXT[theme]}.`} title={`Theme: ${theme}`}>
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
