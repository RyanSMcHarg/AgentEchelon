# AgentEchelon Design System

The design tokens and shared component classes described here are implemented in `frontend/packages/shared/src/styles/`. Some component CSS is still being migrated onto them - the [Migration Guide](#migration-guide) below is the reference for bringing a component onto the system.

## Aesthetic Direction: Precision Engineering

Enterprise AI platform that feels like Linear meets Vercel. Engineered precision, not decorative. Dark sidebar chrome with light content areas, monospace accents for the technical register, amber warmth against cool neutrals.

## Design Tokens

All tokens are CSS custom properties defined in `frontend/packages/shared/src/styles/design-tokens.css`.

### Color System

**Philosophy:** Cool neutral base with warm amber accent. Dark surfaces for chrome (sidebar, header). Light surfaces for content. Amber for primary actions and "intelligence" signals.

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--surface-0` | #FFFFFF | #09090B | Content background |
| `--surface-50` | #FAFAFA | #0F0F11 | Subtle background |
| `--surface-100` | #F4F4F5 | #18181B | Hover states, dividers |
| `--surface-200` | #E4E4E7 | #27272A | Borders |
| `--chrome-bg` | #0A0A0B | same | Sidebar background |
| `--chrome-surface` | #141416 | same | Sidebar cards |
| `--accent-400` | #FBBF24 | same | Primary button fill |
| `--accent-500` | #E5A00D | same | Primary border, focus glow |

### Typography

**Font pairing:**
- **UI:** Geist (Vercel's typeface) - clean geometric sans
- **Code/Technical:** Geist Mono - monospace for IDs, metadata, scores

**Scale:** Dense enterprise UI base (13px), not web-standard 16px.

### Spacing

4px base unit. Use `--space-{n}` tokens where n = multiplier (1=4px, 2=8px, 3=12px, 4=16px...).

### Shadows

5 levels (xs through xl) plus `--shadow-glow` for focus states (amber halo).

## Shared Components

Defined in `frontend/packages/shared/src/styles/components.css`:

### Buttons

| Class | Usage |
|-------|-------|
| `.btn-primary` | Amber fill, dark text. Main CTAs. |
| `.btn-secondary` | White with border. Secondary actions. |
| `.btn-ghost` | Transparent. Tertiary/inline actions. |
| `.btn-chrome` | For dark sidebar. Border + hover. |
| `.btn-danger` | Red. Destructive actions. |
| `.btn-sm`, `.btn-lg` | Size variants. |
| `.btn-icon`, `.btn-icon-sm` | Square icon buttons. |

### Inputs

| Class | Usage |
|-------|-------|
| `.input` | Standard text input. Amber focus glow. |
| `.input-error` | Red border + glow on validation error. |
| `.textarea` | Multi-line input. |
| `.select` | Styled dropdown with custom arrow. |
| `.label` | Uppercase, small, secondary color. |

### Cards

| Class | Usage |
|-------|-------|
| `.card` | Base card with border. |
| `.card-elevated` | Card with shadow. |
| `.card-interactive` | Hoverable card with amber selected state. |

### Badges

Monospace font, compact. Variants: `.badge-neutral`, `.badge-accent`, `.badge-success`, `.badge-error`, `.badge-warning`, `.badge-info`, `.badge-basic`, `.badge-standard`, `.badge-premium`.

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

### Priority Order

1. **LoginScreen.css** - first impression, highest impact
2. **ConversationInterface.css + ConversationList.css** - most-used screens
3. **MessageInput.css** - core interaction
4. **NewConversationModal.css + ModelSelector.css** - channel creation flow
5. **AdminDashboard.css + DataTable.css** - admin experience
6. **RegistrationScreen.css** - onboarding
7. **EmailVerificationScreen.css** - remove purple gradient, align with system
8. Remaining component CSS files

### Dark Mode

Dark mode activates via `prefers-color-scheme: dark` media query OR `data-theme="dark"` on `<html>`. The design tokens swap automatically. Chrome (sidebar) stays dark in both modes.

## Key Design Decisions

1. **Amber accent, not blue** - Blue is overused in enterprise tools. Amber signals warmth and intelligence without the "generic SaaS" feel.
2. **Geist font family** - Vercel's typeface. Technical, modern, highly legible at small sizes. The mono variant gives code/metrics a distinct voice.
3. **13px base, not 16px** - Dense enterprise UI. More information visible, professional feel, respects the user's attention.
4. **Dark sidebar, light content** - The sidebar is persistent chrome; dark keeps it recessive. Content area is light for readability. Same pattern as Linear, Notion, Slack.
5. **Amber focus glow** - Every focusable element gets a `0 0 0 3px rgba(229, 160, 13, 0.15)` halo. This is the one micro-interaction the user will notice and remember.
