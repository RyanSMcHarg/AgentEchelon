/**
 * HOST THEMING: a host overrides a declared subset of the shared design tokens, nothing else (E12).
 *
 * The frame ships `@ae/shared`'s tokens. A host may set, through the loader's mount options, which reach
 * the frame as URL parameters:
 *
 *  - `accent`: `--accent-500`, a hex color;
 *  - `radius`: every `--radius-*` from one size in px (0 to 24);
 *  - `font`: the font family, a list of family names (fonts load only from the frame's own origin or
 *    `data:`, which its Content-Security-Policy enforces);
 *  - `theme`: `light` or `dark`. Absent, the frame follows `prefers-color-scheme`.
 *
 * A value that does not match its shape is dropped, so a host cannot inject CSS through a parameter.
 */

export interface HostTheme {
  accent?: string;
  radius?: number;
  font?: string;
  theme?: 'light' | 'dark';
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = /^[A-Za-z0-9 ,'"-]{1,120}$/;

export function readHostTheme(params: URLSearchParams): HostTheme {
  const out: HostTheme = {};
  const accent = params.get('accent');
  if (accent && HEX.test(accent)) out.accent = accent;
  const radius = Number(params.get('radius'));
  if (params.has('radius') && Number.isInteger(radius) && radius >= 0 && radius <= 24) out.radius = radius;
  const font = params.get('font');
  if (font && FONT.test(font)) out.font = font;
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') out.theme = theme;
  return out;
}

/** Apply a host theme to the frame's root element. */
export function applyHostTheme(root: HTMLElement, theme: HostTheme): void {
  if (theme.accent) root.style.setProperty('--accent-500', theme.accent);
  if (theme.radius !== undefined) {
    const r = theme.radius;
    const steps: Record<string, number> = { xs: 0.25, sm: 0.5, md: 0.75, lg: 1, xl: 1.5, '2xl': 2 };
    for (const [name, factor] of Object.entries(steps)) root.style.setProperty(`--radius-${name}`, `${Math.round(r * factor)}px`);
  }
  if (theme.font) root.style.setProperty('--font-sans', theme.font);
  if (theme.theme) root.setAttribute('data-theme', theme.theme);
}
