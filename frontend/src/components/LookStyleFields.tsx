/**
 * The colors and fonts of a Look (LookStyle): the canvas background, the
 * border around a boxed video, and how the Headline and captions are
 * drawn. Every change goes to the Look being edited, so it follows the
 * same 모든 클립 / 이 클립만 scope as the rest of the Look.
 */

import {useState, type ReactNode} from 'react';

import {fontStack, useFonts} from '../lib/fonts';
import {sameJson} from '../lib/history';
import type {FontEntry, HeadlineStyle, LookStyle, TextStyle, VideoFit} from '../types';
import {Icon} from './Icon';
import {ColorField, IconButton, Section, SliderField, STATE_LAYER, Toggle} from './ui';

// The same limits as TextStyle / LookStyle in src/core/models.py.
const MIN_TEXT_SIZE = 16;
const MAX_TEXT_SIZE = 200;
const MAX_TEXT_OUTLINE = 12;
const MAX_BORDER_WIDTH = 40;

const FONT_SAMPLE = '가나다 ABC 123';

function StyleSection(props: {
  title: string;
  anchor?: string;
  changed: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <Section
      title={props.title}
      anchor={props.anchor}
      actions={
        <IconButton
          label={`${props.title} 기본값으로`}
          icon="undo"
          size="sm"
          disabled={!props.changed}
          onClick={props.onReset}
        />
      }
    >
      {props.children}
    </Section>
  );
}

/**
 * The font list, folded by default. Opening it loads every font so each
 * choice shows in its own face; closed, only the chosen font loads.
 */
function FontChooser(props: {
  label: string;
  fonts: readonly FontEntry[];
  value: string;
  onChange: (fontId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inUse = open ? props.fonts.map((entry) => entry.fontId) : [props.value];
  useFonts(props.fonts, inUse);
  const current = props.fonts.find((entry) => entry.fontId === props.value);
  return (
    <details
      className="group overflow-hidden rounded-2xl bg-surface"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className={`flex h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm ${STATE_LAYER}`}
      >
        <span className="text-on-surface-variant">{props.label}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className="truncate text-sm text-on-surface"
            style={{fontFamily: fontStack(props.value)}}
          >
            {current?.label ?? props.value}
          </span>
          <Icon
            name="expand_more"
            className="text-on-surface-variant transition-transform group-open:rotate-180"
          />
        </span>
      </summary>
      <div role="radiogroup" aria-label={props.label} className="grid gap-1 p-1.5 pt-0">
        {props.fonts.map((entry) => {
          const selected = entry.fontId === props.value;
          return (
            <button
              key={entry.fontId}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onChange(entry.fontId)}
              className={`flex items-baseline justify-between gap-2 rounded-xl px-3 py-1.5 text-start ${STATE_LAYER} ${
                selected
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'text-on-surface'
              }`}
            >
              <span className="text-xs opacity-80">{entry.label}</span>
              <span
                className="truncate text-base"
                style={{fontFamily: fontStack(entry.fontId)}}
              >
                {FONT_SAMPLE}
              </span>
            </button>
          );
        })}
      </div>
    </details>
  );
}

/** Font, size, colors, outline and background box of one text block. */
function TextStyleFields<T extends TextStyle>(props: {
  name: string;
  fonts: readonly FontEntry[];
  value: T;
  /** Color fields above the outline; the Headline adds its accent here. */
  colors: ReactNode;
  onChange: (value: T) => void;
}) {
  const {value, onChange} = props;
  return (
    <div className="space-y-3">
      <FontChooser
        label={`${props.name} 글꼴`}
        fonts={props.fonts}
        value={value.fontId}
        onChange={(fontId) => onChange({...value, fontId})}
      />
      <SliderField
        label="크기"
        value={value.size}
        min={MIN_TEXT_SIZE}
        max={MAX_TEXT_SIZE}
        step={1}
        format={(size) => `${Math.round(size)}`}
        onChange={(size) => onChange({...value, size})}
      />
      {props.colors}
      <ColorField
        label="외곽선 색"
        value={value.outlineColor}
        disabled={value.outlineWidth === 0}
        onChange={(outlineColor) => onChange({...value, outlineColor})}
      />
      <SliderField
        label="외곽선 두께"
        value={value.outlineWidth}
        min={0}
        max={MAX_TEXT_OUTLINE}
        step={1}
        format={(width) => (width === 0 ? '없음' : `${width}`)}
        onChange={(outlineWidth) => onChange({...value, outlineWidth})}
      />
      <Toggle
        label="글자 배경 박스"
        checked={value.background}
        onChange={(background) => onChange({...value, background})}
      />
      <ColorField
        label="배경 박스 색"
        value={value.backgroundColor}
        disabled={!value.background}
        onChange={(backgroundColor) => onChange({...value, backgroundColor})}
      />
      <SliderField
        label="배경 박스 불투명도"
        value={value.backgroundOpacity}
        min={0}
        max={1}
        step={0.05}
        disabled={!value.background}
        format={(opacity) => `${Math.round(opacity * 100)}%`}
        onChange={(backgroundOpacity) => onChange({...value, backgroundOpacity})}
      />
    </div>
  );
}

export function LookStyleFields(props: {
  fonts: readonly FontEntry[];
  value: LookStyle;
  /** The style a new Look starts with; the reset buttons go back to it. */
  defaults: LookStyle;
  fit: VideoFit;
  onChange: (value: LookStyle) => void;
}) {
  const {value, defaults, onChange} = props;
  const boxed = props.fit === 'box';
  const canvas = {
    backgroundColor: value.backgroundColor,
    border: value.border,
    borderColor: value.borderColor,
    borderWidth: value.borderWidth,
  };
  const canvasDefaults = {
    backgroundColor: defaults.backgroundColor,
    border: defaults.border,
    borderColor: defaults.borderColor,
    borderWidth: defaults.borderWidth,
  };
  const setHeadline = (headline: HeadlineStyle) => onChange({...value, headline});
  const setCaption = (caption: TextStyle) => onChange({...value, caption});
  return (
    <>
      <StyleSection
        title="배경·테두리"
        changed={!sameJson(canvas, canvasDefaults)}
        onReset={() => onChange({...value, ...canvasDefaults})}
      >
        <ColorField
          label="배경색"
          value={value.backgroundColor}
          onChange={(backgroundColor) => onChange({...value, backgroundColor})}
        />
        <Toggle
          label="영상 테두리"
          checked={value.border}
          disabled={!boxed}
          onChange={(border) => onChange({...value, border})}
        />
        <ColorField
          label="테두리 색"
          value={value.borderColor}
          disabled={!boxed || !value.border}
          onChange={(borderColor) => onChange({...value, borderColor})}
        />
        <SliderField
          label="테두리 두께"
          value={value.borderWidth}
          min={0}
          max={MAX_BORDER_WIDTH}
          step={1}
          disabled={!boxed || !value.border}
          format={(width) => `${width}`}
          onChange={(borderWidth) => onChange({...value, borderWidth})}
        />
      </StyleSection>
      <StyleSection
        title="헤드라인 글자"
        changed={!sameJson(value.headline, defaults.headline)}
        onReset={() => setHeadline(defaults.headline)}
      >
        <TextStyleFields
          name="헤드라인"
          fonts={props.fonts}
          value={value.headline}
          onChange={setHeadline}
          colors={
            <>
              <ColorField
                label="첫 줄 색"
                value={value.headline.accentColor}
                onChange={(accentColor) => setHeadline({...value.headline, accentColor})}
              />
              <ColorField
                label="나머지 줄 색"
                value={value.headline.color}
                onChange={(color) => setHeadline({...value.headline, color})}
              />
            </>
          }
        />
      </StyleSection>
      <StyleSection
        title="자막 글자"
        anchor="caption-style"
        changed={!sameJson(value.caption, defaults.caption)}
        onReset={() => setCaption(defaults.caption)}
      >
        <TextStyleFields
          name="자막"
          fonts={props.fonts}
          value={value.caption}
          onChange={setCaption}
          colors={
            <ColorField
              label="글자 색"
              value={value.caption.color}
              onChange={(color) => setCaption({...value.caption, color})}
            />
          }
        />
      </StyleSection>
    </>
  );
}
