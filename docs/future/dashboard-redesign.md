# Dashboard redesign — character-sheet direction

**Status**: design committed, implementation phased. Mockups at `/tmp/praxis-mockups/` (`character-sheet.html`, `home-as-chat.html`, `notebook.html`, `health.html`).

## Direction

The dashboard adopts a **character-sheet aesthetic** keyed off the logo's pixel-art letterforms and five-colour palette. Three structural moves:

1. **Each section gets its own visual language** matched to its content shape. Voice (atomic traits) reads differently than Accountabilities (sentences of responsibility) which reads differently than Inhibitions (red lines). No grid of equal panels.
2. **Logo colours encode semantics**, not urgency. Voice = peach. Accountabilities = pink. Capabilities = purple. Success criteria = lavender. Verbs / role tab = teal. Hard inhibitions = oxblood. Each dashboard surface "owns" one colour as the section-pill / nav-underline tint.
3. **Chrome carries personality** via the pixel-rendered PRAXIS logo on a dark brand strip, pixel-font accent labels, and chunky offset block-shadows on anchor cards. Body copy stays editorial (Fraunces display + Source Serif 4 prose + Inter for system UI).

`/home` collapses into `/chat` with a warm time-and-state-aware greeting from the role in their own voice. The old summary cards (Notebook count / Output count / Activity today / Role edits) are absorbed into their dedicated pages — `/notebook` headlines `+N this week`, `/activity` headlines `N today`, `/health` headlines the trend.

## Tokens

### Type
```
display:  'Fraunces' (variable, opsz 9..144, weights 500-700)
prose:    'Source Serif 4' (variable, opsz 8..60, weights 400/500/600, italic 400)
ui:       'Inter' (400/500/600)
mono:     'JetBrains Mono' (400/500)
accent:   'Departure Mono' (pixel — for tags, pills, numerals, status labels)
```

Self-host via `dashboard/public/fonts/` and a single `@font-face` block at the top of `global.css`. No remote fetch at runtime.

### Palette
```css
/* paper — warm cream */
--bg: #f9f5ed;
--surface: #ffffff;
--rule: #e7e0d1;
--rule-strong: #c8bca0;

/* ink */
--ink: #1a1610;
--ink-soft: #4a4438;
--ink-muted: #847b66;
--ink-faint: #b8ae96;

/* logo palette — semantic */
--peach:    #ec9c75;  /* memory / voice / activity-positive */
--pink:     #d68aaa;  /* accountabilities / escalations */
--purple:   #b48ad4;  /* capabilities / proposed-skills / activity-tools */
--lavender: #a692c8;  /* success criteria / autonomous edits */
--teal:     #6cb8b8;  /* verbs / role / performance / send-action */

/* washed fills (use sparingly — for panel bg or hover) */
--peach-soft:    #fce8d8;
--pink-soft:     #f6dce5;
--purple-soft:   #ecdcf3;
--lavender-soft: #e6dff0;
--teal-soft:     #d8ebeb;

/* hard limits */
--oxblood:      #8a2a20;  /* inhibitions only */
--oxblood-soft: #fce4df;

/* self-assessment status */
--good:   #4a7c3a;
--warn:   #b07628;
--danger: #8a2a20;  /* aliases oxblood */
```

### Per-surface colour
Each nav tab's active-underline + section-pill default uses one colour from the palette:

| Surface | Colour | Why |
|---|---|---|
| `/chat` (home) | teal | Primary runtime — the role's voice |
| `/triage`, `/escalations` | pink | Operator action — escalation kind |
| `/notebook` | peach | Memory writes |
| `/output` | purple | Work product |
| `/activity` | purple | Tool calls (sibling to output via "what the role did") |
| `/role` | teal | Identity / constitution |
| `/capabilities` | purple | What the role can do |
| `/health` | teal | Status of the role |

### Spacing
8px base. Page container `max-width: 1080-1180px`, padding `3rem 2.5rem`. Hero blocks `margin-bottom: 3-4rem`. Sections `margin-bottom: 3.5rem`.

## Component recipes

### Brand strip
Dark `--ink` background, pixel-rendered PRAXIS logo (each letter in a different palette colour), role name in mono caps, meta + refresh button right-aligned. See `home-as-chat.html` for canonical implementation.

### Nav
White background, monospace tabs, 3px coloured underline on `.current` (colour per surface from table above). Open-count badges are small peach pixel-shaped chips.

### Section pill
Pixel-font label (10-11px, letter-spacing 0.12-0.18em, uppercase) with a coloured background, paired with a Fraunces display title. The pill IS the section heading's anchor.

### Hero (per-surface)
- `/role`: pill + 56px Fraunces name + italic Fraunces title + purpose paragraph (left), bordered Facts card with offset block-shadow (right).
- `/notebook`: pill + 48px Fraunces title + italic sub (left), 4-stat strip with offset shadow (right). Stats: this week / total / since last / archived.
- `/health`: pill + 44px Fraunces title + italic sub + window-meta strip below.
- `/chat`: greeting in 34px Fraunces serif with `who · time` pixel label above + pending-chip row + recent threads + composer.

### Anchor cards (offset block-shadow)
Surface-coloured shadow 4-6px offset, ink border 2px. Used for:
- Hero Facts card on `/role`
- Stats strip on `/notebook`
- Composer on `/chat`
- Capability "ability" cards on `/role`

### PD panel shapes (the structural point)
Voice → chips with peach border + trait + qualifier
Accountabilities → numbered blocks (pixel-font numeral) on pink-soft
Capabilities → 2-column cards with `▶` markers + purple offset shadow
Success criteria → bordered list with status pip + text + status label
Inhibitions → oxblood left rail + dashed separators + `⊘` markers

### Entry treatment (`/notebook`)
14em gutter (category pill in palette colour + date+age + mono slug) + body (Source Serif 4 prose with H2 in Fraunces). Each entry separated by hairline rule only — no card chrome. Archived entries dim to 55%.

### Vital signs (`/health`)
2×2 grid of panels. Each: section pill + big Fraunces number + pixel sparkline (`▁▃▅▇` in section colour) + 4-row mono breakdown. Below: full-width criteria panel with one row per declared criterion (status pip + text + reasoning italic + trend strip + status badge).

## Phasing

### Phase 1 — Foundation + `/role`
Single PR. Establishes the design system and migrates `/role` fully.

- New `global.css` token block + font loading.
- `BaseLayout.astro` updated (font preconnect, body styles, default background).
- `RouteHeader.astro` rewritten: brand strip + nav with per-surface coloured underline. Replaces the current header + nav tabs. Self-loading badges (from PR #48) stay.
- New `SectionPill.astro` component for reuse across surfaces.
- `/role` page fully migrated to the character-sheet layout — hero, 5 PD sections with per-section visual treatments, verbs row, recent edits, reference data.
- Other surfaces keep their current page content for now but inherit the new chrome (BaseLayout + RouteHeader) — they look transitional but don't break.

### Phase 2 — Per-surface migrations
One PR per surface, in this order:
1. `/chat` (chat-as-home, greeting hero, composer w/ offset shadow)
2. `/notebook` (stats strip + gutter-rail entries)
3. `/health` (vital signs + criteria panel)
4. `/escalations` + `/triage` (pink section pills, escalation kind colour-coding)
5. `/capabilities` (already cleaner — just inherits the chrome)
6. `/output` + `/output/[type]` + `/output/[type]/[...slug]`
7. `/activity`

### Phase 3 — Polish
- Empty states across all surfaces
- Responsive (mobile breakpoint at 768px — single column hero, scrollable nav)
- Loading shimmer for /chat thread loading
- Component-level refinement based on usage

## What changes vs. what doesn't

- **What changes**: every page's visual treatment, tokens, fonts, layout, colour use, hero shape.
- **What stays**: routes, page-level logic, loaders, data shapes, API surface, autonomy model, tool catalog. The redesign is presentation-only. Tests for the underlying loaders/parsers stay green.
- **`/home` redirect**: `/` now redirects to `/chat` rather than rendering an index page. The summary cards are absorbed into per-surface stats.

## Open design questions to resolve as we go

- Greeting on `/chat`: static template (deterministic, instant) or one Anthropic call per page-load (richer, slower)? Start static; revisit if it feels lifeless.
- Empty-state language across surfaces: should match the role's voice? Currently neutral. Could template-substitute persona name + cadence into them.
- Trend strip glyphs (`▁▃▅▇`): Departure Mono renders them but they're pixel-coarse. Test on retina vs non-retina before committing.
- Pixel font fallback if Departure Mono fails to load: JetBrains Mono is the documented fallback; the visual character changes but readability stays.
