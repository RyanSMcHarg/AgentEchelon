# AgentEchelon Design System

The design tokens and shared component classes described here are implemented in `frontend/packages/shared/src/styles/`. The [Migration Guide](#migration-guide) below is the reference for bringing a component's CSS onto the system.

## Aesthetic Direction

Precision engineering for an enterprise AI platform: engineered, not decorative. Dark sidebar chrome with light content areas, monospace accents for the technical register, and a violet accent against cool neutrals.

## Design Tokens

All tokens are CSS custom properties defined in `frontend/packages/shared/src/styles/design-tokens.css`.

### Color System

**Philosophy:** Cool neutral base with an electric violet accent. Dark surfaces for chrome (sidebar, header). Light surfaces for content. Violet for primary actions and "intelligence" signals.

**Surfaces, chrome and accent**

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--surface-0` | #FFFFFF | #09090B | Content background |
| `--surface-50` | #FAFAFA | #0F0F11 | Subtle background, `body` |
| `--surface-100` | #F4F4F5 | #18181B | Hover states, dividers |
| `--surface-200` | #E4E4E7 | #27272A | Borders |
| `--surface-300` | #D4D4D8 | #3F3F46 | Hover borders |
| `--chrome-bg` | #0A0A0B | same | Sidebar background |
| `--chrome-surface` | #141416 | same | Sidebar cards |
| `--chrome-border` | #27272A | same | Sidebar borders |
| `--chrome-text` / `--chrome-text-bright` | #A1A1AA / #FAFAFA | same | Sidebar text |
| `--accent-50` | #F5F3FF | same | Selected-card background |
| `--accent-400` | #A78BFA | same | Accent borders and highlights |
| `--accent-500` | #7C3AED | same | Primary border, hover fill, focus glow |
| `--accent-600` / `--accent-700` | #6D28D9 / #5B21B6 | same | Primary button fill and hover, link color |

The full accent ramp runs `--accent-50` through `--accent-700`.

**Text**

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--text-primary` | #09090B | #FAFAFA | Body text |
| `--text-secondary` | #71717A | #A1A1AA | Labels, secondary text |
| `--text-tertiary` | #A1A1AA | #71717A | Hints, disabled |
| `--text-inverse` | #FAFAFA | #09090B | Text on an inverted surface |
| `--text-on-accent` | #FAFAFA | same | Text on an accent fill |

**Semantic.** `--success` (#22C55E), `--warning` (#EAB308), `--error` (#EF4444) and `--info` (#3B82F6), each with a `-bg` and a `-border` companion that swaps in dark mode.

**Status (admin dashboard).** `--status-good` (#10b981), `--status-warn` (#f59e0b), `--status-bad` (#ef4444), `--status-info` (#3b82f6), `--status-neutral` (#6b7280).

**Classification badges.** A categorical palette of eight, `--cls-1` to `--cls-8`, each with a `-bg` companion and both redefined for dark mode: teal (#0F766E), blue (#1D4ED8), orange (#C2410C), slate (#475569), pink (#BE185D), amber (#A16207), green (#15803D) and purple (#7E22CE). The hues are of similar weight, so no color reads as higher than another. A classification's badge color is the token its definition names (`badgeToken` in `backend/lib/config/profiles.ts`), never its name: the shipped catalog declares `cls-1` for basic, `cls-2` standard, `cls-3` premium, `cls-5` guest and `cls-6` customer, and a classification declaring none takes the first token nobody declares (the admin plane takes `cls-4`). The clients read the deployment's set from `GET /classifications` once signed in (the chat app's registration screen, before sign-in, from its build's `VITE_CLASSIFICATIONS`), and `classificationBadgeStyle` (`frontend/packages/shared/src/config/classifications.ts`) sets the pair a badge reads, `--cls-fg` and `--cls-bg`. A value the deployment does not declare is drawn neutral.

**Audience.** A conversation at a classification whose `audience` is `outside` (a guest's, a customer's) carries `.conversation-header--outside` (a `--warning` rule along the header's top edge on a tinted background) and the `.conversation-header-audience` chip reading "Visible to the customer", and the composer's placeholder reads the same; an inside one shows "Internal". The copy is `conversation.audience.*` and `conversation.placeholderOutside` in the locale.

### Typography

**Font stacks:**
- **UI:** `--font-sans` names Geist first, then `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- **Code/Technical:** `--font-mono` names Geist Mono first, then `'SF Mono', 'Fira Code', 'Fira Mono', monospace` - for IDs, metadata, scores

Geist is not loaded by default. The app's Content Security Policy allows fonts only from `'self'` and `data:`, and the repo ships no `@font-face` for Geist, so the UI renders in the system stack. Geist applies only if a deployment self-hosts it (an `@font-face` with local woff2 files), as the comment in `design-tokens.css` describes.

**Scale:** `--text-xs` (11px) through `--text-3xl` (32px). `--text-base` is 13px for dense enterprise UI; `body` uses `--text-md` (14px).

**Admin console scale.** The admin console sets its own sizes in `frontend/packages/admin/src/admin-theme.css`, read by every console surface through the same tokens: `--text-md` 16px for body and form controls, `--text-base` 15px for tables and buttons, `--text-sm` 14px for help and secondary text, `--text-xs` 12px for monospace badges and counters only, and `--text-lg` 18px, `--text-xl` 20px and `--text-2xl` 24px for group, section and page headings. It also darkens `--text-secondary` and `--text-tertiary` so both meet WCAG AA, and in dark mode swaps `--accent-50` and `--accent-700` so accent text on an accent tint stays legible.

### Spacing

4px base unit. Use `--space-{n}` tokens where n = multiplier (1=4px, 2=8px, 3=12px, 4=16px...).

### Radius

`--radius-xs` (2px), `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (12px), `--radius-2xl` (16px), `--radius-full` (pill).

### Shadows

5 levels (`--shadow-xs` through `--shadow-xl`, deeper under the `prefers-color-scheme: dark` media query only; the `[data-theme="dark"]` block in `design-tokens.css` does not redefine them) plus `--shadow-glow`, `0 0 0 3px rgba(124, 58, 237, 0.18)`, a violet halo on focused inputs, primary-button hover and selected cards. `--shadow-glow-error` is the red equivalent for validation errors.

## Shared Components

Defined in `frontend/packages/shared/src/styles/components.css`:

### Controls

Every button, input and select shares `--control-height` (2rem by default, 2.5rem in the admin console), `--control-font-size`, a 1px `--control-border`, the same radius, a `--focus-ring` outline on `:focus-visible` and the same disabled state. A variant class works alone (`btn-primary`) or with the base (`btn btn-primary`).

### Buttons

| Class | Usage |
|-------|-------|
| `.btn-primary` | Violet fill (`--btn-primary-bg`, `--accent-600`) with light text (`--text-on-accent`), WCAG AA. The one action a view asks for. |
| `.btn-secondary` | White with border. Secondary actions. |
| `.btn-ghost` | Transparent. A quiet action beside a primary one (Cancel). |
| `.btn-link` | No box, link color. An action set in text or a table cell. |
| `.btn-chrome` | For dark sidebar. Border + hover. |
| `.btn-danger` | Red outline at rest (`--danger-text`, `--danger-border`), red fill on hover. Destructive actions. |
| `.btn-sm`, `.btn-lg` | Size variants. |
| `.btn-icon`, `.btn-icon-sm` | Square icon buttons. |

### Inputs

| Class | Usage |
|-------|-------|
| `.input` | Standard text input. Violet focus glow. |
| `.input-error` | Red border + glow on validation error. |
| `.textarea` | Multi-line input. |
| `.select` | Styled dropdown with an arrow (`--select-arrow`, redefined for dark mode). Stands alone; no `.input` needed. |
| `.label` | Uppercase, small, secondary color. |

### Cards

| Class | Usage |
|-------|-------|
| `.card` | Base card with border. |
| `.card-elevated` | Card with shadow. |
| `.card-interactive` | Hoverable card with a violet selected state. |

### Badges

Monospace font, compact. Variants: `.badge-neutral`, `.badge-accent`, `.badge-success`, `.badge-error`, `.badge-warning`, `.badge-info`, and the classification badge `.cls-badge`, colored by the pair `classificationBadgeStyle` sets from the classification's `badgeToken` (`.cls-dot` is the same color as a dot).

### Modal

| Class | Usage |
|-------|-------|
| `.modal-overlay` | Fixed backdrop with blur. |
| `.modal-content` | Card with scale-in animation. |
| `.modal-header` | Title + close button row. |
| `.modal-body` | Scrollable content area. |
| `.modal-footer` | Action buttons row. |

### Alerts

| Class | Usage |
|-------|-------|
| `.alert-error` | Red background, error border. |
| `.alert-success` | Green background, success border. |
| `.alert-warning` | Yellow background. |
| `.alert-info` | Blue background. |

## Migration Guide

To migrate existing components to the design system:

1. Replace hardcoded colors with `var(--token-name)` references
2. Replace hardcoded font-family with `var(--font-sans)` or `var(--font-mono)`
3. Replace hardcoded padding/margin with `var(--space-n)` tokens
4. Replace hardcoded border-radius with `var(--radius-n)` tokens
5. Replace hardcoded shadows with `var(--shadow-n)` tokens
6. Replace custom button styles with `.btn .btn-{variant}` classes
7. Replace custom input styles with `.input` class
8. Replace custom modal styles with `.modal-*` classes

### Remaining work

Component CSS that still carries hardcoded hex colors is the remaining migration work. `frontend/packages/admin/src/components/admin/AdminDashboard.css` holds the most, nearly all as `var()` fallbacks; `FunnelChart.css`, `ConversationInterface.css` and the battle components carry hex fallbacks the same way. Bare hex values remain in `DeploymentStatusBanner.css`, `LoginScreen.css`, `App.css`, `ConversationList.css`, `NewConversationModal.css` and a few other component files.

### Dark Mode

Dark mode activates via `prefers-color-scheme: dark` media query OR `data-theme="dark"` on `<html>`. The surface, text and semantic tokens swap automatically, and so does the classification palette (`--cls-*`); the accent and chrome tokens do not. The shadow tokens swap only under the media query: `data-theme="dark"` alone keeps the light-mode shadows. Chrome (sidebar) stays dark in both modes.

## Key Design Decisions

1. **Violet accent** - A single distinct accent for primary actions and intelligence signals, set against cool neutrals.
2. **System stack by default** - The CSP admits fonts only from the app's own origin, so the UI uses the system stack; Geist is the intended face where a deployment self-hosts it, and its mono variant gives code and metrics a distinct voice.
3. **13px base, 16px in the console** - The chat client is dense: more information visible per screen. The admin console is read for minutes at a time, so it reads at 16px body text and 14px help text.
4. **Dark sidebar, light content** - The sidebar is persistent chrome; dark keeps it recessive. The content area is light for readability.
5. **Violet focus** - Every `:focus-visible` element gets a 2px `--accent-500` outline (`design-tokens.css`), so focus is always visible. Inputs on focus, the primary button on hover, and a selected interactive card add the `--shadow-glow` halo.
