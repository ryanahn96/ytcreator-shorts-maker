/**
 * The Look of the selected Clip: its Headline, how the video sits on the
 * canvas (box or full screen, corners, crop), its colors and fonts, where
 * the text goes and the images on top. By default every Clip shares the
 * Scenario's Look; "Clip N만 따로" gives the selected Clip its own copy,
 * and going back to "모든 Clip 공통" drops that copy.
 */

import {ImagePlus, Trash2, Undo2} from 'lucide-react';
import {useState, type Dispatch} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import {errorMessage} from '../lib/api';
import type {EditorAction} from '../lib/editor';
import {fitAspect, type Size} from '../lib/framing';
import {lookTarget, ownLookClipNumbers, sameTextLayout} from '../lib/look';
import type {
  CropRegion,
  ImageOverlay,
  Look,
  Scenario,
  SourceVideo,
  StudioConfig,
  TextLayout,
  TextPlacement,
  VideoFit,
} from '../types';
import {LookStyleFields} from './LookStyleFields';
import {CropOverlay} from './preview/CropOverlay';
import {FilePicker, IconButton, Panel, Segmented, SliderField} from './ui';

const FIT_OPTIONS = [
  {value: 'box', label: '박스'},
  {value: 'full', label: '전체 화면'},
] as const;

const CORNER_OPTIONS = [
  {value: 'rounded', label: '둥근 모서리'},
  {value: 'square', label: '각진 모서리'},
] as const;

type Scope = 'shared' | 'own';

function cropSummary(crop: CropRegion): string {
  return `가로 ${crop.centerX.toFixed(2)}, 세로 ${crop.centerY.toFixed(2)}, ${crop.zoom.toFixed(2)}×`;
}

function HeadlineField(props: {
  label: string;
  value: string;
  recommended: string;
  color: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-xs text-zinc-300">
      <span className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{background: props.color}}
          aria-hidden
        />
        {props.label}
      </span>
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder="비우면 표시하지 않음"
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
      />
      <span className="mt-0.5 block text-[11px] text-zinc-500">
        Gemini 추천: {props.recommended || '(없음)'}
      </span>
    </label>
  );
}

function CropSliders(props: {
  region: CropRegion;
  maxZoom: number;
  onChange: (region: CropRegion) => void;
}) {
  const {region, onChange} = props;
  const ratio = (value: number) => value.toFixed(2);
  return (
    <div className="space-y-2">
      <SliderField
        label="확대"
        value={region.zoom}
        min={1}
        max={props.maxZoom}
        step={0.05}
        format={(value) => `${value.toFixed(2)}×`}
        onChange={(zoom) => onChange({...region, zoom})}
      />
      <SliderField
        label="가로 위치"
        value={region.centerX}
        min={0}
        max={1}
        step={0.01}
        format={ratio}
        onChange={(centerX) => onChange({...region, centerX})}
      />
      <SliderField
        label="세로 위치"
        value={region.centerY}
        min={0}
        max={1}
        step={0.01}
        format={ratio}
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
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h4 className="text-xs text-zinc-300">{props.label}</h4>
        <IconButton label={`${props.label} 기본 위치로`} disabled={!moved} onClick={() => onChange(props.initial)}>
          <Undo2 size={14} />
        </IconButton>
      </div>
      <SliderField
        label="가로 (가운데 기준)"
        value={value.x}
        min={0}
        max={props.canvasWidth}
        step={1}
        format={(x) => `${Math.round(x)}`}
        onChange={(x) => onChange({...value, x})}
      />
      <SliderField
        label="세로 (마지막 줄 아래 기준)"
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
      className={`space-y-1.5 rounded-lg border p-2 ${
        props.selected ? 'border-sky-500 bg-sky-500/5' : 'border-zinc-800'
      }`}
      onClick={props.onSelect}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-zinc-200">{props.filename}</span>
        <IconButton label="이미지 삭제" onClick={props.onRemove}>
          <Trash2 size={14} />
        </IconButton>
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
        label="크기 (너비)"
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

function ScopeControls(props: {scenario: Scenario; clipIndex: number; dispatch: Dispatch<EditorAction>}) {
  const {scenario, clipIndex, dispatch} = props;
  const clip = scenario.clips[clipIndex];
  const scope: Scope = clip?.look ? 'own' : 'shared';
  const number = clipIndex + 1;
  const owners = ownLookClipNumbers(scenario);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-zinc-200">적용 범위</h3>
      <Segmented<Scope>
        label="적용 범위"
        value={scope}
        disabled={!clip}
        options={[
          {value: 'shared', label: '모든 Clip 공통'},
          {value: 'own', label: `Clip ${number}만 따로`},
        ]}
        onChange={(next) =>
          next !== scope && dispatch({type: 'setOwnLook', index: clipIndex, own: next === 'own'})
        }
      />
      <p className="text-[11px] text-zinc-400">
        {scope === 'own'
          ? `아래 설정은 Clip ${number}에만 적용됩니다. '모든 Clip 공통'을 누르면 이 Clip의 설정을 지우고 공통 설정을 따릅니다.`
          : '아래 설정은 따로 설정하지 않은 모든 Clip에 적용됩니다. 다른 Clip을 고르려면 왼쪽 Clip 목록에서 누르세요.'}
      </p>
      <p className="text-[11px] text-zinc-500">
        따로 설정한 Clip: {owners.length > 0 ? owners.map((item) => `#${item}`).join(', ') : '없음'}
      </p>
    </section>
  );
}

export function LookControls(props: {
  config: StudioConfig;
  sourceVideo: SourceVideo;
  scenario: Scenario;
  /** Gemini's version of this Scenario, for the recommendations. */
  recommended: Scenario;
  clipIndex: number;
  assets: AssetStore;
  selectedImageId: string | null;
  onSelectImage: (overlayId: string | null) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const {config, sourceVideo, scenario, clipIndex, assets, dispatch} = props;
  const style = config.templateStyle;
  const target = lookTarget(scenario, clipIndex);
  const look = scenario.clips[clipIndex]?.look ?? scenario.look;
  const framing = look.framingLayout;
  const suggested = props.recommended.look;
  const defaults = config.defaultTextLayouts;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source: Size | null =
    sourceVideo.width > 0 && sourceVideo.height > 0
      ? {width: sourceVideo.width, height: sourceVideo.height}
      : null;

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

  return (
    <Panel title={target ? `화면 스타일 · Clip ${clipIndex + 1} 전용` : '화면 스타일 · 모든 Clip 공통'}>
      <div className="space-y-4">
        <ScopeControls scenario={scenario} clipIndex={clipIndex} dispatch={dispatch} />
        <section className="space-y-2 border-t border-zinc-800 pt-3">
          <h3 className="text-xs font-semibold text-zinc-200">헤드라인</h3>
          <HeadlineField
            label="첫 줄 (강조색)"
            value={look.headline.accent}
            recommended={suggested.headline.accent}
            color={look.style.headline.accentColor}
            onChange={(accent) => setLook({...look, headline: {...look.headline, accent}})}
          />
          <HeadlineField
            label="둘째 줄"
            value={look.headline.main}
            recommended={suggested.headline.main}
            color={look.style.headline.color}
            onChange={(main) => setLook({...look, headline: {...look.headline, main}})}
          />
        </section>
        <section className="space-y-2 border-t border-zinc-800 pt-3">
          <h3 className="text-xs font-semibold text-zinc-200">영상 배치</h3>
          <Segmented<VideoFit> label="영상 크기" value={framing.fit} options={FIT_OPTIONS} onChange={setFit} />
          <Segmented
            label="모서리"
            value={framing.rounded ? 'rounded' : 'square'}
            options={CORNER_OPTIONS}
            disabled={framing.fit === 'full'}
            onChange={(value) => setFraming({rounded: value === 'rounded'})}
          />
          <p className="text-[11px] text-zinc-400">
            {framing.fit === 'full'
              ? '영상이 9:16 화면 전체를 채우고, 헤드라인·자막·이미지는 영상 위에 겹칩니다.'
              : '영상이 가운데 16:9 박스에 들어가고, 헤드라인은 박스 위에 놓입니다.'}{' '}
            확대 1×는 이 비율로 원본에서 가장 크게 잘라낸 영역입니다. Gemini 추천:{' '}
            {cropSummary(suggested.framingLayout.crop)}
          </p>
          {source && sourceVideo.thumbnailUrl ? (
            <div
              className="relative w-full overflow-hidden rounded-lg bg-black"
              style={{aspectRatio: `${source.width} / ${source.height}`}}
            >
              <img
                src={sourceVideo.thumbnailUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
              />
              <CropOverlay crop={framing.crop} aspect={fitAspect(style, framing.fit)} source={source} />
            </div>
          ) : (
            <p className="text-[11px] text-amber-300">
              원본 해상도나 썸네일이 없어 영역을 그리지 못합니다. 미리보기에서 확인하세요.
            </p>
          )}
          <CropSliders
            region={framing.crop}
            maxZoom={config.maxCropZoom}
            onChange={(crop) => setFraming({crop})}
          />
        </section>
        <LookStyleFields
          fonts={config.fonts}
          value={look.style}
          defaults={config.defaultLookStyle}
          fit={framing.fit}
          onChange={(next) => setLook({...look, style: next})}
        />
        <section className="space-y-3 border-t border-zinc-800 pt-3">
          <h3 className="text-xs font-semibold text-zinc-200">글 위치</h3>
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
        </section>
        <section className="space-y-2 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-zinc-200">이미지</h3>
            <FilePicker
              label="이미지 추가"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              busy={busy}
              icon={<ImagePlus size={14} />}
              onFile={addImage}
            />
          </div>
          {look.images.length === 0 ? (
            <p className="text-[11px] text-zinc-500">
              로고나 스티커 이미지를 올리면 이 설정을 쓰는 Clip이 나오는 동안 영상과 글 위에
              표시됩니다.
            </p>
          ) : (
            look.images.map((image) => (
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
            ))
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </section>
      </div>
    </Panel>
  );
}
