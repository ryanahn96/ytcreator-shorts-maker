---
name: Tonal Creator Studio
colors:
  surface: '#f6faff'
  surface-dim: '#d6dadf'
  surface-bright: '#f6faff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f0f4f9'
  surface-container: '#eaeef3'
  surface-container-high: '#e4e9ed'
  surface-container-highest: '#dfe3e8'
  on-surface: '#171c20'
  on-surface-variant: '#424654'
  inverse-surface: '#2c3135'
  inverse-on-surface: '#edf1f6'
  outline: '#737785'
  outline-variant: '#c3c6d6'
  surface-tint: '#0856cf'
  primary: '#0041a2'
  on-primary: '#ffffff'
  primary-container: '#0b57d0'
  on-primary-container: '#ced9ff'
  inverse-primary: '#b2c5ff'
  secondary: '#3f6377'
  on-secondary: '#ffffff'
  secondary-container: '#c0e5fd'
  on-secondary-container: '#43677b'
  tertiary: '#94001b'
  on-tertiary: '#ffffff'
  tertiary-container: '#c10027'
  on-tertiary-container: '#ffcecc'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2ff'
  primary-fixed-dim: '#b2c5ff'
  on-primary-fixed: '#001847'
  on-primary-fixed-variant: '#0040a1'
  secondary-fixed: '#c3e7ff'
  secondary-fixed-dim: '#a7cbe3'
  on-secondary-fixed: '#001e2c'
  on-secondary-fixed-variant: '#264b5e'
  tertiary-fixed: '#ffdad8'
  tertiary-fixed-dim: '#ffb3b0'
  on-tertiary-fixed: '#410006'
  on-tertiary-fixed-variant: '#92001b'
  background: '#f6faff'
  on-background: '#171c20'
  surface-variant: '#dfe3e8'
typography:
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 22px
    fontWeight: '500'
    lineHeight: 28px
  title-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.015em
  title-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  body-base:
    fontFamily: Noto Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-medium:
    fontFamily: Noto Sans
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-md:
    fontFamily: Noto Sans
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Noto Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  caption:
    fontFamily: Noto Sans
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
rounded:
  sm: 0.5rem
  DEFAULT: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 1.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system blends Google Material 3's intelligent editorial container system with high-velocity creative workbench utilities tailored for short-form video synthesis. The product balances calm, fatigue-reducing tonal workspaces during long creative sessions with energetic, high-contrast focal points that reflect creator momentum.

### Brand Personality
- **Intelligent & Fluid:** Multimodal AI assistance integrated seamlessly with precision controls.
- **Calm & Tonal:** Surface-first separation eliminates heavy shadows and harsh bounding borders.
- **Dynamic & Creator-Centric:** Electric blue interactions anchored with focused broadcast accents.

### Style Attributes
- **Design Archetype:** Corporate / Modern mixed with Google Material 3 and Gemini tonal architecture.
- **Physical Feel:** Tactile pill silhouettes, large rounded containers, and gentle surface stepping.
- **Visual Contrast:** High internal canvas discipline (pure black 9:16 stages with neon subtitle highlights) encased inside clean, low-contrast, light tonal workbench envelopes.

## Colors

The color system is organized around tonal surface hierarchy rather than dimensional elevation. Pure white anchors primary panels, while stepped neutral tints delineate toolbars, cards, and inspectors.

### Palette Architecture
- **Primary (`#0B57D0`):** Electric Blue for active states, key interactive indicators, tab selection markers, and input focus rings.
- **Secondary (`#C2E7FF`):** Tonal Ice Blue serving as high-comfort, low-strain container fills for active chips, segmented toggle selections, and subtle highlights.
- **Tertiary / Action Accent (`#EC0032`):** Broadcast Red reserved strictly for definitive creator publishing milestones, final video export triggers, and irreversible deletion flows.
- **Neutral Surface Foundations:**
  - `surface` (`#FFFFFF`): Base workspace viewport.
  - `surface-container-low` (`#F8FAFD`): Soft canvas framing.
  - `surface-container` (`#F0F4F9`): Main functional card surfaces.
  - `surface-container-high` (`#E9EEF6`): Segmented track backgrounds and elevated dialogues.
  - `surface-container-highest` (`#DDE3EA`): Inactive switch tracks, dividers, and slider grooves.
- **Text & Borders:**
  - `on-surface` (`#1F1F1F`): Primary copy, active numbers, and major section labels.
  - `on-surface-variant` (`#444746`): Secondary copy, hints, and timecode readouts.
  - `outline-variant` (`#C4C7C5`): Hairline structural separators.

### Video Overlay Contrast Tokens
The video stage adheres to dedicated broadcast canvas defaults: `#000000` base frame, `#3DDC4A` viral hook accents, `#F2E35A` high-luminance subtitles, and `#FFFFFF` 2px stroke boundaries.

## Typography

The typographic hierarchy combines **Plus Jakarta Sans** for friendly, geometric UI titles and numeric display with **Noto Sans** for robust, highly legible body data, editing forms, and internationalized scripts.

### Role Conventions
- **Plus Jakarta Sans (`headline-lg`, `title-lg`, `title-md`):** Used on workbench headers, modal crowns, and primary workflow titles. Its rounded curvature mirrors the system's pillular interface shells.
- **Noto Sans (`body-base`, `body-medium`, `label-md`):** Used throughout operational forms, transcript timelines, parameter readouts, and tooltips.
- **Tabular Figures:** All numeric readouts (timecodes, dimensions, duration scrubbers, audio decibels) must activate `font-variant-numeric: tabular-nums` to eliminate layout shift during playback.

## Layout & Spacing

The layout is grounded in a modular 4px baseline rhythm. Studio panels, floating dock tools, and parameter grids scale proportionally using explicit spacing tokens.

### Layout Model
- **Workbench Multi-Column Grid:** Desktop environments utilize an adaptive 3-column split:
  1. *Clip Sequencing & Asset Pipeline:* `minmax(340px, 1fr)`
  2. *Pinned 9:16 Video Preview Stage:* Fixed dynamic column scaled via viewport height: `min(420px, max(240px, calc((100dvh - 4rem - 16rem) * 9 / 16)))`
  3. *Inspector & Synthesis Panel:* `minmax(380px, 1.15fr)`
- **Responsive Adaptations:**
  - *Compact (< 1024px):* Stacks into a unified vertical column with playback controls pinned atop or below active trimmers.
  - *Tablet (1024px – 1279px):* Two-column split pinning the 9:16 player to the right column with sequential tabs in the primary column.
  - *Desktop (≥ 1280px):* Full 3-column panoramic workbench with independent scroll layers per column.

## Elevation & Depth

This system avoids dark, heavy drop shadows, instead using **Material 3 Tonal Stacking** paired with ultra-diffused atmospheric ambient occlusion.

### Tonal Stratification
- **Level 0 (Canvas Base):** `surface` (`#FFFFFF`).
- **Level 1 (Structural Workbench Panels):** `surface-container` (`#F0F4F9`) with no drop shadow.
- **Level 2 (Active Sub-Cards & Controls):** `surface-container-high` (`#E9EEF6`).
- **Level 3 (Popovers, Flyout Drawers, Sticky Menus):** `surface-container-highest` (`#DDE3EA`) paired with an ambient drop shadow: `0px 4px 16px rgba(11, 87, 208, 0.04)`.
- **Level 4 (Modal Dialogs):** Centered floating dialogs using `surface-container-high` backed by an overlay mask of `rgba(0, 0, 0, 0.45)` and ambient drop shadow `0px 24px 48px rgba(31, 31, 31, 0.12)`.
- **Level 5 (Action Toasts / Floating Snackbars):** `inverse-surface` (`#303030`) rendered with crisp white text (`#F2F2F2`) and an ambient shadow `0px 8px 24px rgba(0, 0, 0, 0.16)`.

## Shapes

The system relies on a pillular geometric design language (`roundedness: 3`). Containers employ organic, pebble-like curvature that softens complex parameter layouts and offsets the rigid rectangular aspect of the 9:16 video viewport.

### Geometry Guidelines
- **Buttons, Badges, and Chips:** Fully capsule-shaped (`border-radius: 9999px`).
- **Cards and Major Functional Panes:** Smooth sweeping curves (`border-radius: 28px` / `1.75rem`).
- **Input Fields & Steppers:** Soft capsule-approximated geometries (`border-radius: 12px` to `16px`).
- **Video Stage Exception:** The live 9:16 vertical render frame maintains a crisp internal boundary (`border-radius: 0px` to `8px`) inside its enclosing rounded pebble card.

## Components

### Buttons
- **Filled (Primary):** Solid `#0B57D0` fill with pure white label. Capsule silhouette (`rounded-full`), `px-5 py-2.5`, medium weight. Includes subtle state-layer tint (`currentColor` at 8% opacity on hover).
- **Tonal (Secondary):** Surface `#C2E7FF` fill with `#001D35` text. Used for contextual tool triggers and secondary timeline functions.
- **Outlined:** Transparent fill, `1px solid #747775` border, electric blue text.
- **Action / Export:** Broadcast red `#EC0032` fill, white text, reserved exclusively for publishing and video generation handoffs.
- **AI Synthesis Gradient Button:** Linear gradient (`#EC0032` → `#E01378` → `#9334E6` → `#0B57D0`), white text, reserved for one-click creative generation routines.

### Chips & Segmented Controls
- **Segmented Control:** Contained in a `surface-container-high` track (`rounded-full p-1`). The active option transitions using a smooth sliding `#C2E7FF` pill surface with high-contrast text.
- **Filter Chips:** Capsule outline with `#C4C7C5` border. On selection, shifts to `#D3E3FD` background with electric blue check indicator.

### Input Fields & Steppers
- **Text Inputs:** Height 36px to 40px, `rounded-xl` boundary with `1px solid #C4C7C5` border. On focus, transitions cleanly to a `2px solid #0B57D0` boundary without layout shift.
- **Numeric Fields:** Right-aligned tabular numeric displays with appended visual units (`초`, `px`, `%`) embedded inside the trailing margin.

### Checkboxes & Toggle Switches
- **Toggle Switches:** Track width 48px, height 28px (`rounded-full`). Unchecked: `#DDE3EA` with `#747775` thumb. Checked: `#0B57D0` track with `#FFFFFF` translated thumb.
- **Checkboxes:** 18px rounded square (`rounded-sm`), transitioning to solid `#0B57D0` fill with white check glyph on active state.

### Cards & Dialogs
- **Workbench Cards:** Layered using `surface-container` (`#F0F4F9`), padded with `1rem` to `1.5rem`, shaped at `28px` radius. Interior sections divide with hairline borders (`1px solid #C4C7C5` at 70% opacity).
- **Export & Settings Dialogs:** Floating `surface-container-high` cards with `28px` curvature, 24px inner padding, and top-aligned headline typography.

### Specialized Creator Tools
- **Conversational Agent Input Bar:** Outlined pill bar positioned directly beneath the live preview stage, housing a continuous microphone trigger, inline prompt field, and blue circular execution control.
- **9:16 Canvas Canvas Overlay:** Absolute-positioned bounding handles supporting direct click-and-drag re-positioning of yellow subtitles (`#F2E35A`) and lime-green hook titles (`#3DDC4A`).
