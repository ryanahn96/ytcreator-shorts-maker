/**
 * The Look of the selected Clip: its Headline, how the video sits on the
 * canvas (box or full screen, corners, crop), its colors and fonts, where
 * the text goes and the images on top. By default every Clip shares the
 * Scenario's Look; "이 클립만" gives the selected Clip its own copy, and
 * going back to "모든 클립" drops that copy.
 */

import {useEffect, useRef, useState, type Dispatch} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import {errorMessage} from '../lib/api';
import type {EditorAction} from '../lib/editor';
import {anchorElement, revealElement, revealInput, type FocusRequest} from '../lib/focus';
import {clampVideoBox, videoBox} from '../lib/framing';
import {lookTarget, sameTextLayout} from '../lib/look';
import type {
  CropRegion,
  HeadlineStyle,
  ImageOverlay,
  Look,
  Scenario,
  StudioConfig,
  TemplateStyle,
  TextLayout,
  TextPlacement,
  VideoBoxSpec,
  VideoFit,
} from '../types';
import {LookStyleFields} from './LookStyleFields';
import {
  Button,
  FilePicker,
  IconButton,
  Section,
  Segmented,
  SliderField,
  STATE_LAYER,
  TEXT_FIELD,
} from './ui';

const FIT_OPTIONS = [
  {value: 'box', label: '자유 크기 (박스)'},
  {value: 'full', label: '전체 화면 (9:16)'},
] as const;

const BOX_PRESETS: readonly {
  label: string;
  aspect: number | null;
}[] = [
  {label: '16:9 기본', aspect: null},
  {label: '4:3', aspect: 4 / 3},
  {label: '1:1 정사각', aspect: 1},
  {label: '4:5 세로', aspect: 4 / 5},
];

type Scope = 'shared' | 'own';

const LINE_ORDINALS = ['첫', '둘째', '셋째', '넷째', '다섯째', '여섯째'];

/** "첫 줄", "둘째 줄", … "7번째 줄". */
function lineLabel(index: number): string {
  const ordinal = LINE_ORDINALS[index];
  return ordinal ? `${ordinal} 줄` : `${index + 1}번째 줄`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * One input per Headline line. The dot shows the color the line is drawn
 * in: the first non-empty line takes the accent color. Each input carries
 * data-headline-line so a click on the preview can focus it.
 */
function HeadlineLines(props: {
  lines: readonly string[];
  style: HeadlineStyle;
  onChange: (lines: string[]) => void;
}) {
  const {lines, onChange} = props;
  const accentIndex = lines.findIndex((line) => line.trim());
  return (
    <div className="space-y-2">
      {lines.map((line, index) => (
        <label key={index} className="block space-y-1.5 text-sm text-on-surface-variant">
          <span className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-outline-variant"
              style={{
                background:
                  index === accentIndex ? props.style.accentColor : props.style.color,
              }}
              aria-hidden
            />
            {lineLabel(index)}
          </span>
          <span className="flex items-center gap-1">
            <input
              data-headline-line={index}
              value={line}
              onChange={(event) =>
                onChange(lines.map((item, at) => (at === index ? event.target.value : item)))
              }
              placeholder="비우면 표시하지 않아요"
              className={`${TEXT_FIELD} h-10 min-w-0 flex-1`}
            />
            <IconButton
              label={`${lineLabel(index)} 삭제`}
              icon="close"
              size="sm"
              disabled={lines.length <= 1}
              onClick={() => onChange(lines.filter((_, at) => at !== index))}
            />
          </span>
        </label>
      ))}
    </div>
  );
}

function VideoBoxFields(props: {
  style: TemplateStyle;
  box: VideoBoxSpec;
  isCustom: boolean;
  onChange: (box: VideoBoxSpec | null) => void;
}) {
  const {style, box, onChange} = props;
  const base = videoBox(style, style.canvasWidth);
  const update = (patch: Partial<VideoBoxSpec>) => {
    onChange(clampVideoBox(style, {...box, ...patch}));
  };
  const applyPreset = (aspect: number | null) => {
    if (aspect === null) {
      onChange(null);
      return;
    }
    const width = base.width;
    const height = Math.floor(width / aspect / 2) * 2;
    const x = Math.floor((style.canvasWidth - width) / 2 / 2) * 2;
    const y = Math.floor((style.boxCenterY - height / 2) / 2) * 2;
    onChange(clampVideoBox(style, {x, y, width, height}));
  };
  const centerBox = () => {
    const x = Math.floor((style.canvasWidth - box.width) / 2 / 2) * 2;
    const y = Math.floor((style.boxCenterY - box.height / 2) / 2) * 2;
    onChange(clampVideoBox(style, {...box, x, y}));
  };

  return (
    <div className="space-y-3 rounded-2xl bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-on-surface-variant">
          화면 크기·위치 (각진 모서리)
        </span>
        <div className="flex items-center gap-1">
          <Button variant="text" size="sm" onClick={centerBox}>
            가운데 정렬
          </Button>
          {props.isCustom && (
            <IconButton
              label="기본 크기로 초기화"
              icon="undo"
              size="sm"
              onClick={() => onChange(null)}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {BOX_PRESETS.map((preset) => {
          const active =
            preset.aspect === null
              ? !props.isCustom
              : props.isCustom &&
                Math.abs(box.width / box.height - preset.aspect) < 0.03;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset.aspect)}
              className={`h-7 rounded-lg px-2.5 text-xs font-medium transition-colors ${STATE_LAYER} ${
                active
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'border border-outline-variant/70 text-on-surface-variant'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <SliderField
        label="가로 크기"
        value={box.width}
        min={240}
        max={style.canvasWidth}
        step={4}
        format={(val) => `${Math.round(val)}px`}
        onChange={(width) => update({width})}
      />
      <SliderField
        label="세로 크기"
        value={box.height}
        min={240}
        max={style.canvasHeight}
        step={4}
        format={(val) => `${Math.round(val)}px`}
        onChange={(height) => update({height})}
      />
      <SliderField
        label="가로 위치 (X)"
        value={box.x}
        min={0}
        max={Math.max(0, style.canvasWidth - box.width)}
        step={4}
        format={(val) => `${Math.round(val)}px`}
        onChange={(x) => update({x})}
      />
      <SliderField
        label="세로 위치 (Y)"
        value={box.y}
        min={0}
        max={Math.max(0, style.canvasHeight - box.height)}
        step={4}
        format={(val) => `${Math.round(val)}px`}
        onChange={(y) => update({y})}
      />
      <p className="text-[11px] text-on-surface-variant/80">
        미리보기 화면에서 영상 테두리나 모서리를 드래그해 크기와 위치를 직접 조절할 수도 있어요.
      </p>
    </div>
  );
}

function CropSliders(props: {
  region: CropRegion;
  maxZoom: number;
  onChange: (region: CropRegion) => void;
}) {
  const {region, onChange} = props;
  return (
    <div className="space-y-3">
      <SliderField
        label="영상 안쪽 확대 (Zoom)"
        value={region.zoom}
        min={1}
        max={props.maxZoom}
        step={0.05}
        format={(value) => `${value.toFixed(2)}×`}
        onChange={(zoom) => onChange({...region, zoom})}
      />
      <SliderField
        label="원본 가로 초점"
        value={region.centerX}
        min={0}
        max={1}
        step={0.01}
        format={percent}
        onChange={(centerX) => onChange({...region, centerX})}
      />
      <SliderField
        label="원본 세로 초점"
        value={region.centerY}
        min={0}
        max={1}
        step={0.01}
        format={percent}
        onChange={(centerY) => onChange({...region, centerY})}
      />
    </div>
  );
}

function PlacementFields(props: {
  label: string;
  value: TextPlacement;
  initial: TextPlacement;
  canvasWidth: number;
  canvasHeight: number;
  onChange: (value: TextPlacement) => void;
}) {
  const {value, onChange} = props;
  const moved = value.x !== props.initial.x || value.y !== props.initial.y;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm text-on-surface">{props.label}</h4>
        <IconButton
          label={`${props.label} 기본 위치로`}
          icon="undo"
          size="sm"
          disabled={!moved}
          onClick={() => onChange(props.initial)}
        />
      </div>
      <SliderField
        label="가로 위치"
        value={value.x}
        min={0}
        max={props.canvasWidth}
        step={1}
        format={(x) => `${Math.round(x)}`}
        onChange={(x) => onChange({...value, x})}
      />
      <SliderField
        label="세로 위치"
        value={value.y}
        min={0}
        max={props.canvasHeight}
        step={1}
        format={(y) => `${Math.round(y)}`}
        onChange={(y) => onChange({...value, y})}
      />
    </div>
  );
}

function ImageFields(props: {
  image: ImageOverlay;
  filename: string;
  selected: boolean;
  canvasWidth: number;
  canvasHeight: number;
  onSelect: () => void;
  onChange: (image: ImageOverlay) => void;
  onRemove: () => void;
}) {
  const {image, onChange} = props;
  const aspect = image.height / image.width;
  return (
    <div
      data-overlay-id={image.overlayId}
      className={`space-y-3 rounded-2xl bg-surface p-3 ${
        props.selected ? 'ring-2 ring-primary' : ''
      }`}
      onClick={props.onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm text-on-surface">{props.filename}</span>
        <IconButton label="이미지 삭제" icon="delete" size="sm" onClick={props.onRemove} />
      </div>
      <SliderField
        label="가로 위치"
        value={image.x}
        min={0}
        max={props.canvasWidth}
        step={1}
        format={(x) => `${Math.round(x)}`}
        onChange={(x) => onChange({...image, x})}
      />
      <SliderField
        label="세로 위치"
        value={image.y}
        min={0}
        max={props.canvasHeight}
        step={1}
        format={(y) => `${Math.round(y)}`}
        onChange={(y) => onChange({...image, y})}
      />
      <SliderField
        label="크기"
        value={image.width}
        min={24}
        max={props.canvasWidth * 1.5}
        step={1}
        format={(width) => `${Math.round(width)}`}
        onChange={(width) => onChange({...image, width, height: Math.round(width * aspect)})}
      />
      <SliderField
        label="회전"
        value={image.rotationDeg}
        min={-180}
        max={180}
        step={1}
        format={(deg) => `${Math.round(deg)}°`}
        onChange={(rotationDeg) => onChange({...image, rotationDeg})}
      />
    </div>
  );
}

export function LookControls(props: {
  config: StudioConfig;
  scenario: Scenario;
  clipIndex: number;
  assets: AssetStore;
  selectedImageId: string | null;
  /** The control a click on the preview asked to bring into view. */
  focus: FocusRequest | null;
  onSelectImage: (overlayId: string | null) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const {config, scenario, clipIndex, assets, dispatch} = props;
  const style = config.templateStyle;
  const clip = scenario.clips[clipIndex];
  const scope: Scope = clip?.look ? 'own' : 'shared';
  const target = lookTarget(scenario, clipIndex);
  const look = clip?.look ?? scenario.look;
  const framing = look.framingLayout;
  const defaults = config.defaultTextLayouts;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Runs once per request, after the editor has shown this tab.
  const {focus} = props;
  useEffect(() => {
    const root = rootRef.current;
    const wanted = focus?.target;
    if (!root || !wanted) {
      return;
    }
    if (wanted.kind === 'headline') {
      revealInput(
        root.querySelector<HTMLInputElement>(`[data-headline-line="${wanted.line}"]`),
      );
    } else if (wanted.kind === 'captionStyle') {
      revealElement(anchorElement(root, 'caption-style'));
    } else if (wanted.kind === 'videoBox') {
      revealElement(anchorElement(root, 'video-framing'));
    } else if (wanted.kind === 'image') {
      revealElement(
        root.querySelector(`[data-overlay-id="${CSS.escape(wanted.overlayId)}"]`),
      );
    }
  }, [focus]);

  const setLook = (next: Look) => dispatch({type: 'setLook', clipId: target, look: next});
  const setFraming = (patch: Partial<Look['framingLayout']>) =>
    setLook({...look, framingLayout: {...framing, ...patch}});
  const setFit = (fit: VideoFit) => {
    // Text still at the old fit's default moves to the new fit's default.
    const textLayout = sameTextLayout(look.textLayout, defaults[framing.fit])
      ? defaults[fit]
      : look.textLayout;
    setLook({...look, framingLayout: {...framing, fit}, textLayout});
  };
  const setPlacement = (key: keyof TextLayout, value: TextPlacement) =>
    setLook({...look, textLayout: {...look.textLayout, [key]: value}});
  const setImage = (image: ImageOverlay) =>
    setLook({
      ...look,
      images: look.images.map((item) => (item.overlayId === image.overlayId ? image : item)),
    });

  const addImage = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const asset = await assets.add(file, 'image');
      const width = Math.round(style.canvasWidth * config.composition.defaultImageWidthRatio);
      dispatch({
        type: 'addImage',
        clipId: target,
        image: {
          assetId: asset.assetId,
          x: style.canvasWidth / 2,
          y: style.canvasHeight / 2,
          width,
          height: Math.round((width * asset.height) / asset.width),
          rotationDeg: 0,
        },
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const currentBox = videoBox(style, style.canvasWidth, framing);

  return (
    <div ref={rootRef} className="space-y-4">
      <Segmented<Scope>
        label="적용 범위"
        value={scope}
        disabled={!clip}
        options={[
          {value: 'shared', label: '모든 클립'},
          {value: 'own', label: '이 클립만'},
        ]}
        onChange={(next) =>
          next !== scope && dispatch({type: 'setOwnLook', index: clipIndex, own: next === 'own'})
        }
      />
      <Section
        title="헤드라인"
        actions={
          <Button
            variant="tonal"
            size="sm"
            icon="add"
            onClick={() => setLook({...look, headline: {lines: [...look.headline.lines, '']}})}
          >
            줄 추가
          </Button>
        }
      >
        <HeadlineLines
          lines={look.headline.lines.length > 0 ? look.headline.lines : ['']}
          style={look.style.headline}
          onChange={(lines) => setLook({...look, headline: {lines}})}
        />
      </Section>
      <Section title="영상 배치" anchor="video-framing">
        <Segmented<VideoFit>
          label="화면 모드"
          value={framing.fit}
          options={FIT_OPTIONS}
          onChange={setFit}
        />
        {framing.fit === 'box' && (
          <VideoBoxFields
            style={style}
            box={currentBox}
            isCustom={Boolean(framing.box)}
            onChange={(box) => setFraming({box})}
          />
        )}
        <CropSliders
          region={framing.crop}
          maxZoom={config.maxCropZoom}
          onChange={(crop) => setFraming({crop})}
        />
      </Section>
      <LookStyleFields
        fonts={config.fonts}
        value={look.style}
        defaults={config.defaultLookStyle}
        fit={framing.fit}
        onChange={(next) => setLook({...look, style: next})}
      />
      <Section title="글 위치">
        <PlacementFields
          label="헤드라인"
          value={look.textLayout.headline}
          initial={defaults[framing.fit].headline}
          canvasWidth={style.canvasWidth}
          canvasHeight={style.canvasHeight}
          onChange={(value) => setPlacement('headline', value)}
        />
        <PlacementFields
          label="자막"
          value={look.textLayout.caption}
          initial={defaults[framing.fit].caption}
          canvasWidth={style.canvasWidth}
          canvasHeight={style.canvasHeight}
          onChange={(value) => setPlacement('caption', value)}
        />
      </Section>
      <Section
        title="이미지"
        actions={
          <FilePicker
            label="이미지 추가"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            busy={busy}
            icon="add_photo_alternate"
            onFile={addImage}
          />
        }
      >
        {look.images.map((image) => (
          <ImageFields
            key={image.overlayId}
            image={image}
            filename={assets.records.get(image.assetId)?.filename ?? image.assetId}
            selected={image.overlayId === props.selectedImageId}
            canvasWidth={style.canvasWidth}
            canvasHeight={style.canvasHeight}
            onSelect={() => props.onSelectImage(image.overlayId)}
            onChange={setImage}
            onRemove={() =>
              setLook({
                ...look,
                images: look.images.filter((item) => item.overlayId !== image.overlayId),
              })
            }
          />
        ))}
        {error && <p className="text-xs text-error">{error}</p>}
      </Section>
    </div>
  );
}
