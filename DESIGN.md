# CareerOS Design System

## Theme

CareerOS uses a light, low-glare operational workspace suited to long daytime job-search sessions on a laptop. Surfaces are softly tinted rather than pure white, with dark green-charcoal text, quiet separators, and a restrained rust accent.

## Color

- Canvas: `oklch(94.4% 0.015 100)`
- Working paper: `oklch(98.8% 0.007 100)`
- Primary ink: `oklch(25% 0.022 170)`
- Secondary ink: `oklch(47% 0.025 170)`
- Quiet text: `oklch(53% 0.022 170)`
- Separator: `oklch(87% 0.018 105)`
- Strong separator: `oklch(78% 0.025 105)`
- Action accent: `oklch(48% 0.13 34)`
- Information: `oklch(51% 0.09 174)`
- Success: `oklch(55% 0.12 145)`
- Warning: `oklch(64% 0.13 82)`
- Error: `oklch(57% 0.15 26)`

Use the rust accent sparingly for active navigation and primary commands. Green, amber, and red always require a textual or symbolic state cue.

## Typography

- Interface: Manrope with system sans-serif fallback.
- Dates, identifiers, small metadata, and state labels: DM Mono with monospace fallback.
- Normal working text must remain at least 12px on laptop surfaces and 14px on mobile where space permits.
- Compact metadata may reach 10px; never place essential instructions, failures, or editable content below 11px.
- Letter spacing is zero for headings and body text. Uppercase metadata may use modest positive spacing.
- CV document typography is independent from interface typography and must match PDF output exactly.

## Layout

- Use full-width operational bands and tables rather than collections of decorative cards.
- Keep the desktop sidebar stable at 244px and collapse it deliberately on narrow screens.
- Tracker and Discover tables may scroll horizontally when preserving readable columns is better than compression.
- Application Studio uses three purposeful regions: job evidence, the A4 document, and reviewable AI changes. At narrower widths these become navigable regions rather than illegibly narrow columns.
- Long descriptions belong in detail surfaces. Repeated rows keep stable heights and predictable controls.

## Components

- Corners are restrained, generally 5-8px. Pills are reserved for status or compact categorisation.
- Use Lucide icons for familiar commands and pair unfamiliar icons with tooltips or accessible labels.
- Buttons use icons for symbol-like commands and icon plus text for consequential actions.
- Inputs expose clear labels, visible focus, validation near the field, and durable error details.
- Status indicators include a dot or icon plus plain-language text. Online, offline, AI configured, and key missing states remain aligned horizontally.
- Drawers and overlays are reserved for focused review, setup, or sharing workflows and must trap focus and restore it on close.

## Motion

Use short ease-out transitions for hover, progress, and drawer state. Do not animate layout dimensions. Respect `prefers-reduced-motion` and avoid decorative motion.

## Content

Use direct operational language. Distinguish employer-posted, CareerOS-detected, last checked, deadline, and availability dates. Never call an attempted action verified unless an external provider confirmed it. AI copy must name the proposal, evidence, review state, model, duration, and failure reason where relevant.
