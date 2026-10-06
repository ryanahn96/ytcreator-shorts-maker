/**
 * The colors and fonts of a Look (LookStyle): the canvas background, the
 * border around a boxed video, and how the Headline and captions are
 * drawn. Every change goes to the Look being edited, so it follows the
 * same 공통 / Clip-only scope as the rest of the Look.
 */

import {ChevronDown, Undo2} from 'lucide-react';
import {useState, type ReactNode} from 'react';

import {fontStack, useFonts} from '../lib/fonts';
import type {FontEntry, HeadlineStyle, LookStyle, TextStyle, VideoFit} from '../types';
import {ColorField, IconButton, SliderField, Toggle} from './ui';

// The same limits as TextStyle / LookStyle in yt/studio/models.py.
const MIN_TEXT_SIZE = 16;
const MAX_TEXT_SIZE = 200;
const MAX_TEXT_OUTLINE = 12;
const MAX_BORDER_WIDTH = 40;

const FONT_SAMPLE = '가나다 ABC 123';

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function StyleSection(props: {
  title: string;
  resetLabel: string;
  changed: boolean;
  onReset: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-zinc-800 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-200">{props.title}</h3>
        <IconButton label={props.resetLabel} disabled={!props.changed} onClick={props.onReset}>
          <Undo2 size={14} />
        </IconButton>
      </div>
      {props.children}
    </section>
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
      className="group rounded-lg border border-zinc-800"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-xs text-zinc-300">
        <span className="text-zinc-400">{props.label}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm text-zinc-100" style={{fontFamily: fontStack(props.value)}}>
            {current?.label ?? props.value}
          </span>
          <ChevronDown size={14} className="shrink-0 text-zinc-500 group-open:rotate-180" />
        </span>
      </summary>
      <div role="radiogroup" aria-label={props.label} className="grid gap-1 border-t border-zinc-800 p-1.5">
        {props.fonts.map((entry) => {
          const selected = entry.fontId === props.value;
          return (
            <button
              key={entry.fontId}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => props.onChange(entry.fontId)}
              className={`flex items-baseline justify-between gap-2 rounded-md border px-2 py-1 text-left ${
                selected
                  ? 'border-indigo-500 bg-indigo-500/15'
                  : 'border-transparent hover:bg-zinc-800'
              }`}
            >
              <span className="text-[11px] text-zinc-400">{entry.label}</span>
              <span className="truncate text-base text-zinc-100" style={{fontFamily: fontStack(entry.fontId)}}>
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
    <div className="space-y-2">
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
        resetLabel="배경·테두리 기본값으로"
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
        <p className="text-[11px] text-zinc-500">
          {boxed
            ? '배경색은 영상 박스 바깥을 채웁니다. 테두리는 박스 바깥쪽에 그려집니다.'
            : '전체 화면에서는 영상이 캔버스를 덮어 배경색이 보이지 않고, 테두리도 그리지 않습니다.'}
        </p>
      </StyleSection>
      <StyleSection
        title="헤드라인 글자"
        resetLabel="헤드라인 글자 기본값으로"
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
                label="둘째 줄 색"
                value={value.headline.color}
                onChange={(color) => setHeadline({...value.headline, color})}
              />
            </>
          }
        />
      </StyleSection>
      <StyleSection
        title="자막 글자"
        resetLabel="자막 글자 기본값으로"
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
