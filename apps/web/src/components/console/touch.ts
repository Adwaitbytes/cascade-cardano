/** Grows a Hash copy button's hit area to 44px on touch screens without moving the layout. */
export const HASH_TOUCH = "pointer-coarse:[&_button]:relative pointer-coarse:[&_button]:after:absolute pointer-coarse:[&_button]:after:-inset-[13px] pointer-coarse:[&_button]:after:content-['']";

/** Classes for the action block that is a fixed thumb-reach bar below lg and an inline card section from lg up. */
export const ACTION_BAR =
  "fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/85 px-4 pt-3 backdrop-blur-md sm:px-6 lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none";

/**
 * Keeps the bar's button above the home indicator. Inline because the inset is zero on desktop, and an
 * arbitrary `env()` class can be mangled by Tailwind scanning Turbopack's binary cache.
 */
export const SAFE_BOTTOM = { paddingBottom: "env(safe-area-inset-bottom)" } as const;
