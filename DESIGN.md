---
name: Tonal Creator Studio
colors:
  surface: '#ffffff'
  surface-container-low: '#f8fafd'
  surface-container: '#f0f4f9'
  surface-container-high: '#e9eef6'
  surface-container-highest: '#dde3ea'
  on-surface: '#1f1f1f'
  on-surface-variant: '#444746'
  outline: '#747775'
  outline-variant: '#c4c7c5'
  primary: '#0b57d0'
  on-primary: '#ffffff'
  primary-container: '#d3e3fd'
  on-primary-container: '#041e49'
  secondary-container: '#c2e7ff'
  on-secondary-container: '#001d35'
  error: '#b3261e'
  error-container: '#f9dedc'
  on-error-container: '#410e0b'
  warning: '#b06000'
  inverse-surface: '#303030'
  inverse-on-surface: '#f2f2f2'
  action: '#ec0032'
typography:
  headline-lg:
    fontFamily: Google Sans Flex
    fontSize: 24px
    fontWeight: '400'
    lineHeight: 32px
  title-lg:
    fontFamily: Google Sans Flex
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 28px
    letterSpacing: -0.025em
  title-md:
    fontFamily: Google Sans Flex
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  body-base:
    fontFamily: Google Sans Flex
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-medium:
    fontFamily: Google Sans Flex
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-md:
    fontFamily: Google Sans Flex
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 20px
  label-sm:
    fontFamily: Google Sans Flex
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  caption:
    fontFamily: Google Sans Flex
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  DEFAULT: 0.25rem
  lg: 0.5rem
  xl: 0.75rem
  2xl: 1rem
  card: 28px
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1rem
  margin-sm: 1.5rem
  header-height: 4rem
  card-padding: 1rem
  dialog-padding: 1.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

The studio follows Google Material 3 the way the Gemini web app uses it, with one YouTube red for the export action. Work areas are calm tonal surfaces, and color goes to what the creator acts on: blue for interaction, the brand gradient for a screen's main call to action, red for export. Stepped surface colors and hairline dividers separate areas. Shadows appear only on things that float.

There are two themes. The app follows the device by default, and the header theme menu (시스템, 라이트, 다크) saves a choice in `localStorage`. `index.html` sets `data-theme` on `<html>` before the first paint, and `frontend/src/index.css` holds one token set per theme.

The 9:16 Shorts canvas is a separate world. Its colors and fonts come from each Look (see CONTEXT.md), not from these tokens.

## Colors

The frontmatter lists the light theme. Each token is a CSS variable in `frontend/src/index.css` (`--surface` and so on), and `@theme inline` turns it into a Tailwind color. Components write classes such as `bg-surface-container` or `text-on-surface-variant` instead of hex values, so switching the theme changes no component.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `surface` | `#ffffff` | `#131314` | page, header, text field fill |
| `surface-container-low` | `#f8fafd` | `#1b1b1b` | quiet inset panels |
| `surface-container` | `#f0f4f9` | `#1e1f20` | cards, unselected Scenario chips |
| `surface-container-high` | `#e9eef6` | `#282a2c` | dialogs, segmented tracks, the 말로 편집 widget, warning notices |
| `surface-container-highest` | `#dde3ea` | `#333537` | switch track when off, progress track, placeholders |
| `on-surface` | `#1f1f1f` | `#e3e3e3` | main text |
| `on-surface-variant` | `#444746` | `#c4c7c5` | secondary text, labels, standard icon buttons |
| `outline` | `#747775` | `#8e918f` | outlined buttons, switch when off, hovered fields |
| `outline-variant` | `#c4c7c5` | `#444746` | field borders, dividers at 70%, scrollbars |
| `primary` | `#0b57d0` | `#a8c7fa` | filled and text buttons, selected tab, focus ring, sliders |
| `on-primary` | `#ffffff` | `#062e6f` | content on `primary` |
| `primary-container` | `#d3e3fd` | `#0842a0` | highlights, often translucent, such as the playing transcript line |
| `on-primary-container` | `#041e49` | `#d3e3fd` | content on `primary-container` |
| `secondary-container` | `#c2e7ff` | `#004a77` | tonal buttons, the selected segment and Scenario chip |
| `on-secondary-container` | `#001d35` | `#c2e7ff` | content on `secondary-container` |
| `error` | `#b3261e` | `#f2b8b5` | error text and icons |
| `error-container` | `#f9dedc` | `#8c1d18` | error notices |
| `on-error-container` | `#410e0b` | `#f9dedc` | content on `error-container` |
| `warning` | `#b06000` | `#fdd663` | the warning notice icon |
| `inverse-surface` | `#303030` | `#e3e3e3` | snackbar |
| `inverse-on-surface` | `#f2f2f2` | `#303030` | snackbar text |
| `action` | `#ec0032` | `#ec0032` | the 내보내기 button in the editor header |

Interaction states are shared:

- State layer: `currentColor` at 8% on hover, 10% on keyboard focus and 12% while pressed (`STATE_LAYER` in `ui.tsx`).
- Disabled: `on-surface` at 12% for fills and 38% for content.
- Focus: a 2px `primary` outline with a 2px offset.
- Text selection: `primary` mixed at 28%.

### Brand gradient

`brand-gradient` in `index.css` runs left to right through `#ec0032`, `#e01378` at 33%, `#9334e6` at 66% and `#0b57d0`. It is the only gradient. It fills a screen's main call to action ("Google / YouTube 계정으로 로그인", "Shorts 만들기") and the progress bar shown while 다시 분석 runs, and the analysis orb turns the same colors into a conic ring.

### Shorts canvas defaults

These are not UI tokens. They are the starting Look Style of a new Look (`default_look_style()` in `src/core/config.py`), and the user can change every one: canvas `#000000`; Headline first line `#3DDC4A` and the other lines `#FFFFFF`, size 84, black outline 2; captions `#F2E35A`, size 44, black outline 3; video-box border off, `#FFFFFF` and 6 wide when turned on; Headline and captions in the bundled Noto Sans KR. Sizes and widths are in 1080×1920 canvas units.

## Typography

One family covers the UI: Google Sans Flex, with Noto Sans KR for Hangul (`--font-sans: 'Google Sans Flex', 'Noto Sans KR', ui-sans-serif, system-ui, sans-serif`). `frontend/index.html` loads both from Google Fonts, Google Sans Flex as a variable font (opsz 6-144, wght 1-1000) and Noto Sans KR at weights 400-700. Body text is 14px on a 20px line. Sizes are Tailwind's `text-2xl`, `text-lg`, `text-base`, `text-sm` and `text-xs`, plus `text-[13px]` and `text-[11px]`.

| Role | Size and weight | Where |
| --- | --- | --- |
| `headline-lg` | 24/32, regular | dialog titles, the analysis status line; the login title uses medium weight and tight tracking |
| `title-lg` | 18/28, medium, tight tracking | the app name in the header |
| `title-md` | 16/24, medium | card titles, large buttons |
| `body-base` | 14/20, regular | default text, dialog content, notices, fields |
| `body-medium` | 14/20, medium | section titles, tool tabs, medium buttons |
| `label-md` | 13px, medium | small buttons, segmented options |
| `label-sm` | 12/16 | the most common size, for metadata, hints and secondary labels |
| `caption` | 11px, medium | badges and counters |

Buttons add 0.01em tracking. Numbers that change while editing or playing (times, sizes, field values) use `tabular-nums`; `TEXT_FIELD` and the slider readout already set it.

Icons are Material Symbols Rounded at optical size 24. `Icon.tsx` downloads only the glyphs in `ICON_NAMES`, which must stay in alphabetical order, so a new icon goes into that list first. A selected tool tab shows its icon filled.

## Layout & Spacing

Spacing follows Tailwind's 4px scale. Pages pad 1rem on the sides and 1.5rem from 640px. The header is sticky, 4rem tall, on `surface`. The editor caps its width at 1960px and the start screen at 56rem (`max-w-4xl`).

### Editor grid

`.editor-grid` in `index.css` places the editor with a 1rem gap:

- Below 1024px: one column, in the order clips, preview, tool tabs. The preview scrolls with the page.
- 1024-1279px: clips and tool tabs share the left column. The preview takes the right column and stays pinned under the header.
- From 1280px: three columns, clips at `minmax(340px, 1fr)`, the preview, tool tabs at `minmax(380px, 1.15fr)`.

The preview column is `--preview-w` plus 2rem, with `--preview-w = min(420px, max(240px, (100dvh - 4rem - --preview-chrome) * 9 / 16))`. `--preview-chrome` covers the transport under the frame and the gaps. It is 10rem, or 17rem at 1024-1279px so the folded 말로 편집 widget fits under the pinned preview. A strip of Scenario chips above the grid scrolls sideways and fades at the edges that hide more chips.

## Elevation & Depth

Depth comes from surface steps. Shadows mark only what floats.

- Page and header: `surface`.
- Cards: `surface-container`, no shadow.
- Controls inside cards: `surface-container-high` tracks (segmented control) and `surface` fields.
- Floating: the theme menu (`surface`, `surface-container-high` in dark, `shadow-lg` and a 50% `outline-variant` ring), the 말로 편집 widget (`surface-container-high`, `outline-variant` border, `shadow-lg`) and the snackbar (`inverse-surface`, `shadow-lg`).
- Modal: dialogs on `surface-container-high` with `shadow-2xl` over a `rgb(0 0 0 / 0.45)` backdrop.
- Buttons lift on hover: `shadow-sm` for filled and tonal, `shadow-md` for the export button, `shadow-lg` for the gradient button.

## Shapes

Workbench shapes are rounded, and the scale in the frontmatter maps to Tailwind classes.

- `rounded-full`: buttons, icon buttons, chips, segmented controls and their options, switches, the folded 말로 편집 widget.
- `rounded-[28px]`: cards, dialogs, the open 말로 편집 widget, the top of the tool tab row.
- `rounded-2xl` (16px): notices, the theme menu, the preview frame, the 말로 편집 input box.
- `rounded-xl` (12px): the snackbar, small inset panels and thumbnails.
- `rounded-lg` (8px): text and number fields.
- `rounded` (4px): tiny badges.

The 9:16 preview frame is a 16px-rounded window onto the Shorts canvas. Inside the canvas the video box always has square corners (Short Template in CONTEXT.md).

## Components

Shared pieces live in `frontend/src/components/ui.tsx`.

### Buttons

Every button is a pill with medium-weight text and a state layer. Sizes: `sm` is 32px tall with 13px text and 12px side padding, `md` 40px with 14px text and 20px padding, `lg` 56px with 16px text and 32px padding.

- `filled`: `primary` fill, `on-primary` text.
- `tonal`: `secondary-container` fill, `on-secondary-container` text.
- `outlined`: 1px `outline` border, `primary` text.
- `text`: `primary` text only.
- `danger`: `action` red fill with white text, used only for 내보내기 in the editor header.
- `gradient`: the brand gradient with white text, used large for a screen's main call to action.

Icon buttons are 32px or 40px circles, `standard` with an `on-surface-variant` icon or `filled` on `primary`.

### Tabs and chips

- Tool tabs (자막, 스타일, 소리, 반응·댓글): 56px tall, equal widths, 14px medium text with an icon. The selected tab turns `primary`, fills its icon and gets a 3px `primary` bar at the bottom.
- Scenario chips: pills with 16px side padding. The selected chip is `secondary-container` with a small check in a `primary` circle; the others are `surface-container` and step up to `surface-container-high` on hover.
- Segmented control: a `surface-container-high` pill track with 4px padding. Options are 32px pills with 13px medium text, and the selected one fills with `secondary-container`.

### Fields and switches

- Text field (`TEXT_FIELD`): 36px tall, `rounded-lg`, a 1px `outline-variant` border on `surface`, 14px tabular text. Hover darkens the border to `outline`. Focus turns it `primary` and adds a 1px `primary` ring, so nothing shifts.
- Number field: a 96px right-aligned text field with its unit after it (초, px, %). It commits on blur or Enter.
- Slider: a native range input tinted `primary`, with the label on the left and the value in tabular numbers on the right.
- Color field: a round 32px swatch next to a hex text field.
- Switch: a 48×28 track with a 2px border. Off, the track is `surface-container-highest` with an `outline` border and a 16px `outline` thumb. On, track and border are `primary` with a 20px `on-primary` thumb.

There are no checkboxes in the studio.

### Cards, dialogs and messages

- Card: `surface-container`, `rounded-[28px]`, 16px padding, an optional 16px medium title.
- Section: a titled group inside a card. Each section after the first starts with an `outline-variant` divider at 70%.
- Dialog: a native `<dialog>` that traps focus and closes on Escape or a backdrop click. `surface-container-high`, `rounded-[28px]`, 24px padding, a 24px regular title and actions on the right.
- Notice: an inline `rounded-2xl` message. Errors use `error-container`; warnings use `surface-container-high` with a `warning` icon.
- Snackbar: bottom center, `inverse-surface`, `rounded-xl`, hides itself after 10 seconds.
- Progress bar: a 4px `surface-container-highest` track with a `primary` or brand-gradient bar, indeterminate when it has no value.

### Studio pieces

- 말로 편집 widget (`EditAgentBar.tsx`): floats at the bottom right, 16px from the edges and 24px from 640px. Folded, it is a pill with the 말로 편집 button and the mic. Open, it is a card up to 26rem wide with the latest reply, the input and a 지난 대화 popover. It writes its height plus a gap to `--edit-agent-space`, and the tool tabs pad their bottom by that much.
- Canvas overlay (`preview/OverlayLayer.tsx`): Headline lines, captions and Image Overlays can be dragged in the preview. Images get resize and rotate handles when selected, and the video box moves by its edges and resizes by its corners. A click on an item opens its control in the right panel.
- Analysis orb: a 9rem ring in the brand colors with a blurred glow, turning while the analysis runs.
- Full-screen preview: a black stage with the frame as large as the screen allows and the controls below. It sets `data-theme="dark"` on itself.

### Motion

New content rises in over 220ms with `cubic-bezier(0.2, 0, 0, 1)`, and dialogs open over 180ms. Under `prefers-reduced-motion: reduce` the orb, the indeterminate progress, the rise-in and the dialog animation stop.
