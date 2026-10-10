/**
 * The Clips of the selected Scenario, including Source Video segments and
 * inserted image/video B-roll clips. The selected Clip opens: reorder,
 * split and delete buttons, whole-clip shift / sentence-extend controls,
 * a range editor with drag handles (and whole-clip body drag), nudge
 * buttons and exact numbers. "Gemini 제안으로 되돌리기" restores the
 * Scenario Gemini proposed.
 */

import {useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import {errorMessage} from '../lib/api';
import type {EditorAction} from '../lib/editor';
import {formatClock, formatDuration} from '../lib/format';
import {
  firstWordAtOrAfter,
  roundMs,
  snapToWord,
  wordsStartingIn,
  type ResolvedClip,
  type Transcript,
} from '../lib/timeline';
import type {
  Clip,
  CompositionSettings,
  TimeRange,
  YouTubeRetentionPeak,
  YouTubeRetentionPoint,
} from '../types';
import {Icon} from './Icon';
import {RangeSlider, type RangeHandle} from './RangeSlider';
import {
  Button,
  Card,
  FilePicker,
  IconButton,
  NumberField,
  Segmented,
  SliderField,
  STATE_LAYER,
  Toggle,
} from './ui';

/** The word start nearest the Clip's middle that leaves both halves valid. */
function splitPoint(resolved: ResolvedClip, minSec: number): number | null {
  const {clip, words} = resolved;
  const fits = (seconds: number) =>
    seconds - clip.startSec >= minSec && clip.endSec - seconds >= minSec;
  const middle = (clip.startSec + clip.endSec) / 2;
  const best = snapToWord(words.filter((word) => fits(word.startSec)), middle, 'start');
  return fits(best) ? best : null;
}

/** A newClipSec-long range starting at the first word after `after`. */
function proposeNewClip(
  transcript: Transcript,
  after: Clip | undefined,
  settings: CompositionSettings,
  durationSec: number,
): TimeRange | null {
  const words = transcript.words;
  const fromSec =
    after && (after.mediaKind ?? 'source') === 'source' ? after.endSec : 0;
  const next = words[firstWordAtOrAfter(words, fromSec)];
  const startSec = next ? next.startSec : fromSec;
  const targetSec = startSec + settings.newClipSec;
  const nearby = wordsStartingIn(words, {
    startSec,
    endSec: targetSec + settings.editWindowPadSec,
  });
  const snapped = snapToWord(nearby, targetSec, 'end');
  const endSec = Math.min(
    durationSec,
    snapped - startSec >= settings.minSubcutSec ? snapped : targetSec,
  );
  return endSec - startSec >= settings.minSubcutSec
    ? {startSec: roundMs(startSec), endSec: roundMs(endSec)}
    : null;
}

/** Previous transcript line start before `startSec`, or null. */
function prevLineStartSec(transcript: Transcript, startSec: number): number | null {
  let candidate: number | null = null;
  for (const word of transcript.words) {
    if (word.startSec >= startSec - 0.05) {
      break;
    }
    if (transcript.lineStarts.has(word.index) || candidate === null) {
      candidate = word.startSec;
    }
  }
  return candidate;
}

/** Next transcript line end after `endSec`, or null. */
function nextLineEndSec(transcript: Transcript, endSec: number): number | null {
  let inNextLine = false;
  let candidate: number | null = null;
  for (const word of transcript.words) {
    if (word.endSec <= endSec + 0.05) {
      continue;
    }
    if (!inNextLine) {
      inNextLine = true;
      candidate = word.endSec;
      continue;
    }
    if (transcript.lineStarts.has(word.index)) {
      break;
    }
    candidate = word.endSec;
  }
  return candidate;
}

function matchingPeak(
  clip: Clip,
  peaks: readonly YouTubeRetentionPeak[] | undefined,
): YouTubeRetentionPeak | null {
  if ((clip.mediaKind ?? 'source') !== 'source') {
    return null;
  }
  return (
    peaks?.find((peak) => clip.startSec < peak.endSec && clip.endSec > peak.startSec) ?? null
  );
}

function EdgeControl(props: {
  label: string;
  value: number;
  steps: readonly number[];
  onCommit: (value: number) => void;
}) {
  const deltas = [...props.steps.map((step) => -step).reverse(), ...props.steps];
  return (
    <div className="space-y-2">
      <NumberField
        label={`${props.label} ${formatClock(props.value)}`}
        value={props.value}
        step={props.steps[0] ?? 0.1}
        min={0}
        digits={2}
        suffix="초"
        onCommit={(value) => props.onCommit(roundMs(value))}
      />
      <div className="flex gap-1">
        {deltas.map((delta) => (
          <button
            key={delta}
            type="button"
            aria-label={`${props.label} ${delta > 0 ? '+' : '−'}${Math.abs(delta)}초`}
            onClick={() => props.onCommit(roundMs(props.value + delta))}
            className={`h-8 flex-1 rounded-full border border-outline-variant text-xs text-on-surface-variant tabular-nums ${STATE_LAYER}`}
          >
            {delta > 0 ? '+' : '−'}
            {Math.abs(delta)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ClipToolbar(props: {
  index: number;
  count: number;
  splitAt: number | null;
  dispatch: Dispatch<EditorAction>;
}) {
  const {index, count, splitAt, dispatch} = props;
  return (
    <div className="-ms-2 flex items-center gap-1">
      <IconButton
        label="위로"
        icon="arrow_upward"
        size="sm"
        disabled={index === 0}
        onClick={() => dispatch({type: 'moveClip', index, offset: -1})}
      />
      <IconButton
        label="아래로"
        icon="arrow_downward"
        size="sm"
        disabled={index === count - 1}
        onClick={() => dispatch({type: 'moveClip', index, offset: 1})}
      />
      {splitAt !== null && (
        <IconButton
          label="가운데 단어에서 나누기"
          icon="content_cut"
          size="sm"
          onClick={() => dispatch({type: 'splitClip', index, atSec: splitAt})}
        />
      )}
      <IconButton
        label="삭제"
        icon="delete"
        size="sm"
        onClick={() => dispatch({type: 'deleteClip', index})}
      />
    </div>
  );
}

function ImageClipEditor(props: {
  clip: Clip;
  index: number;
  count: number;
  assets: AssetStore;
  dispatch: Dispatch<EditorAction>;
}) {
  const {clip, index, count, assets, dispatch} = props;
  const duration = Math.max(0.5, roundMs(clip.endSec - clip.startSec));
  const url = clip.assetId ? assets.urls.get(clip.assetId) : undefined;
  const record = clip.assetId ? assets.records.get(clip.assetId) : undefined;
  const setDuration = (endSec: number) =>
    dispatch({type: 'setClipRange', index, range: {startSec: 0, endSec}});
  return (
    <div className="space-y-3 px-4 pt-2 pb-4">
      <ClipToolbar index={index} count={count} splitAt={null} dispatch={dispatch} />
      {url && (
        <div className="flex items-center gap-3 rounded-xl bg-surface-container-low p-2.5">
          <img
            src={url}
            alt={record?.filename ?? '삽입 이미지'}
            className="h-14 w-14 rounded-lg object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-on-surface">
              {record?.filename ?? clip.purpose}
            </p>
            <p className="text-[11px] text-on-surface-variant">
              {record ? `${record.width}×${record.height}px · ` : ''}
              단독 이미지 클립 ({duration.toFixed(1)}초 재생)
            </p>
          </div>
        </div>
      )}
      <SliderField
        label="이미지 표시 시간"
        value={duration}
        min={0.5}
        max={15}
        step={0.5}
        format={(val) => `${val.toFixed(1)}초`}
        onChange={setDuration}
      />
      <div className="flex items-center gap-1.5">
        {[1.5, 3, 5, 8].map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setDuration(preset)}
            className={`h-7 flex-1 rounded-full border text-xs tabular-nums ${STATE_LAYER} ${
              Math.abs(duration - preset) < 0.05
                ? 'border-primary bg-primary/15 font-medium text-primary'
                : 'border-outline-variant text-on-surface-variant'
            }`}
          >
            {preset}초
          </button>
        ))}
      </div>
    </div>
  );
}

function VideoClipEditor(props: {
  clip: Clip;
  index: number;
  count: number;
  assets: AssetStore;
  settings: CompositionSettings;
  dispatch: Dispatch<EditorAction>;
}) {
  const {clip, index, count, assets, settings, dispatch} = props;
  const [draft, setDraft] = useState<TimeRange | null>(null);
  const record = clip.assetId ? assets.records.get(clip.assetId) : undefined;
  const maxDuration =
    record && record.durationSec > 0 ? record.durationSec : Math.max(10, clip.endSec + 5);
  const shown = draft ?? clip;
  const steps = settings.nudgeStepsSec;

  const commit = (range: TimeRange) => {
    setDraft(null);
    const startSec = Math.max(0, roundMs(range.startSec));
    const endSec = Math.min(
      maxDuration,
      Math.max(startSec + settings.minSubcutSec, roundMs(range.endSec)),
    );
    dispatch({
      type: 'setClipRange',
      index,
      range: {startSec, endSec},
    });
  };

  return (
    <div className="space-y-3 px-4 pt-2 pb-4">
      <ClipToolbar index={index} count={count} splitAt={null} dispatch={dispatch} />
      <div className="rounded-xl bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant">
        <span className="font-medium text-on-surface">
          {record?.filename ?? clip.purpose}
        </span>
        {record && (
          <span className="ms-2">
            ({record.width}×{record.height} · 전체 {formatDuration(record.durationSec)})
          </span>
        )}
      </div>
      <RangeSlider
        bounds={{startSec: 0, endSec: maxDuration}}
        range={shown}
        minGapSec={settings.minSubcutSec}
        ticks={[]}
        kept={[shown]}
        stepSec={steps[0] ?? 0.1}
        largeStepSec={steps.at(-1) ?? 0.5}
        onDraft={setDraft}
        onCommit={(range) => commit(range)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <EdgeControl
          label="시작"
          value={clip.startSec}
          steps={steps}
          onCommit={(startSec) => commit({startSec, endSec: clip.endSec})}
        />
        <EdgeControl
          label="끝"
          value={clip.endSec}
          steps={steps}
          onCommit={(endSec) => commit({startSec: clip.startSec, endSec})}
        />
      </div>
      <Toggle
        label="삽입 영상 소리 끄기 (무음)"
        checked={Boolean(clip.muteAudio)}
        onChange={(muteAudio) => dispatch({type: 'setClipMute', index, muteAudio})}
      />
    </div>
  );
}

type WindowScope = 'local' | 'full';

function ClipRangeEditor(props: {
  resolved: ResolvedClip;
  index: number;
  count: number;
  transcript: Transcript;
  settings: CompositionSettings;
  sourceDurationSec: number;
  retentionPoints?: readonly YouTubeRetentionPoint[];
  retentionPeaks?: readonly YouTubeRetentionPeak[];
  retentionLows?: readonly YouTubeRetentionPeak[];
  subcutsFor: (range: TimeRange) => TimeRange[];
  dispatch: Dispatch<EditorAction>;
}) {
  const {resolved, index, settings, dispatch} = props;
  const {clip} = resolved;
  const [draft, setDraft] = useState<TimeRange | null>(null);
  const [windowScope, setWindowScope] = useState<WindowScope>('local');
  const shown = draft ?? clip;
  const fullDuration = Number.isFinite(props.sourceDurationSec)
    ? props.sourceDurationSec
    : clip.endSec + settings.editWindowPadSec;

  // In 'local' mode the slider shows ±editWindowPadSec around the clip; in
  // 'full' mode it spans the entire Source Video so the user can move the
  // clip anywhere in the video.
  const windowStart =
    windowScope === 'full' ? 0 : Math.max(0, clip.startSec - settings.editWindowPadSec);
  const windowEnd =
    windowScope === 'full'
      ? fullDuration
      : Math.min(fullDuration, clip.endSec + settings.editWindowPadSec);
  const windowWords = useMemo(
    () =>
      wordsStartingIn(props.transcript.words, {
        startSec: windowStart,
        endSec: windowEnd,
      }),
    [props.transcript, windowStart, windowEnd],
  );
  const kept = draft ? props.subcutsFor(draft) : resolved.subcuts;
  const steps = settings.nudgeStepsSec;
  const splitAt = splitPoint(resolved, settings.minSubcutSec);

  const commit = (range: TimeRange, snap: RangeHandle | null) => {
    setDraft(null);
    let snapped = range;
    if (snap === 'start') {
      snapped = {...range, startSec: snapToWord(windowWords, range.startSec, 'start')};
    } else if (snap === 'end') {
      snapped = {...range, endSec: snapToWord(windowWords, range.endSec, 'end')};
    }
    const valid =
      snapped.endSec - snapped.startSec >= settings.minSubcutSec ? snapped : range;
    dispatch({
      type: 'setClipRange',
      index,
      range: {startSec: roundMs(valid.startSec), endSec: roundMs(valid.endSec)},
    });
  };

  const shiftClip = (deltaSec: number) => {
    const duration = Math.max(settings.minSubcutSec, clip.endSec - clip.startSec);
    const maxStart = Math.max(0, fullDuration - duration);
    const startSec = Math.min(Math.max(0, clip.startSec + deltaSec), maxStart);
    commit({startSec, endSec: startSec + duration}, null);
  };

  const prevStart = prevLineStartSec(props.transcript, clip.startSec);
  const nextEnd = nextLineEndSec(props.transcript, clip.endSec);

  return (
    <div className="space-y-3.5 px-4 pt-2 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ClipToolbar
          index={index}
          count={props.count}
          splitAt={splitAt}
          dispatch={dispatch}
        />
        <Segmented<WindowScope>
          label="타임라인 범위"
          value={windowScope}
          options={[
            {value: 'local', label: '주변 구간'},
            {value: 'full', label: '전체 영상'},
          ]}
          onChange={setWindowScope}
        />
      </div>
      <RangeSlider
        bounds={{startSec: windowStart, endSec: windowEnd}}
        range={shown}
        minGapSec={settings.minSubcutSec}
        ticks={windowWords.map((word) => word.startSec)}
        kept={kept}
        stepSec={steps[0] ?? 0.1}
        largeStepSec={steps.at(-1) ?? 0.5}
        retentionPoints={props.retentionPoints}
        retentionPeaks={props.retentionPeaks}
        retentionLows={props.retentionLows}
        sourceDurationSec={props.sourceDurationSec}
        onDraft={setDraft}
        onCommit={commit}
      />
      <div className="space-y-1.5 rounded-xl bg-surface-container-low p-2.5">
        <div className="flex flex-wrap gap-1">
          {([-5, -1, 1, 5] as const).map((delta) => (
            <button
              key={delta}
              type="button"
              onClick={() => shiftClip(delta)}
              className={`h-7 flex-1 rounded-lg border border-outline-variant px-2 text-xs text-on-surface-variant tabular-nums ${STATE_LAYER}`}
              title={`클립 길이를 유지한 채 ${delta > 0 ? '뒤로' : '앞으로'} ${Math.abs(delta)}초 이동`}
            >
              {delta < 0 ? `◀ −${Math.abs(delta)}초` : `+${delta}초 ▶`}
            </button>
          ))}
        </div>
        <div className="flex gap-1 pt-0.5">
          <button
            type="button"
            disabled={prevStart === null}
            onClick={() =>
              prevStart !== null && commit({startSec: prevStart, endSec: clip.endSec}, null)
            }
            className={`h-7 flex-1 rounded-lg border border-outline-variant px-2 text-xs text-on-surface-variant disabled:opacity-40 ${STATE_LAYER}`}
            title="추천 구간 바로 앞 대사 시작점까지 포함"
          >
            ◀ 이전 대사 포함
          </button>
          <button
            type="button"
            disabled={nextEnd === null}
            onClick={() =>
              nextEnd !== null && commit({startSec: clip.startSec, endSec: nextEnd}, null)
            }
            className={`h-7 flex-1 rounded-lg border border-outline-variant px-2 text-xs text-on-surface-variant disabled:opacity-40 ${STATE_LAYER}`}
            title="추천 구간 바로 뒤 대사 끝점까지 포함"
          >
            다음 대사 포함 ▶
          </button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <EdgeControl
          label="시작"
          value={clip.startSec}
          steps={steps}
          onCommit={(startSec) => commit({startSec, endSec: clip.endSec}, null)}
        />
        <EdgeControl
          label="끝"
          value={clip.endSec}
          steps={steps}
          onCommit={(endSec) => commit({startSec: clip.startSec, endSec}, null)}
        />
      </div>
    </div>
  );
}

function ClipItem(props: {
  resolved: ResolvedClip;
  position: number;
  selected: boolean;
  peak: YouTubeRetentionPeak | null;
  low: YouTubeRetentionPeak | null;
  dispatch: Dispatch<EditorAction>;
  children?: ReactNode;
}) {
  const {resolved, position, selected, peak, low, dispatch} = props;
  const {clip, planIndex, words} = resolved;
  const mediaKind = clip.mediaKind ?? 'source';
  const itemRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) {
      itemRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }
  }, [selected]);

  return (
    <li
      ref={itemRef}
      className={`overflow-hidden rounded-[20px] bg-surface transition-shadow ${
        selected ? 'ring-2 ring-primary/60' : ''
      }`}
    >
      <button
        type="button"
        aria-expanded={selected}
        onClick={() => dispatch({type: 'selectClip', index: position})}
        className={`block w-full space-y-1 px-4 py-3 text-start ${STATE_LAYER} ${
          selected ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface'
        }`}
      >
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium tabular-nums">
          <span>
            클립 {position + 1}
            <span className="ms-2 font-normal opacity-80">
              {mediaKind === 'image'
                ? `${(clip.endSec - clip.startSec).toFixed(1)}초 표시`
                : `${formatClock(clip.startSec)} – ${formatClock(clip.endSec)}`}
            </span>
          </span>
          {mediaKind !== 'source' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-tertiary-container px-2 py-0.5 text-[11px] font-medium text-on-tertiary-container">
              <Icon name={mediaKind === 'image' ? 'image' : 'movie'} size={13} />
              {mediaKind === 'image' ? '삽입 이미지' : `삽입 영상${clip.muteAudio ? ' (무음)' : ''}`}
            </span>
          )}
          {peak && (
            <span
              title={`${peak.label} (${formatClock(peak.startSec)} – ${formatClock(peak.endSec)})`}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              <Icon name="insights" size={13} />
              🔥 많이 본 구간 {Math.round(peak.watchRatio * 100)}%
            </span>
          )}
          {!peak && low && (
            <span
              title={`${low.label} (${formatClock(low.startSec)} – ${formatClock(low.endSec)})`}
              className="inline-flex items-center gap-1 rounded-full bg-error-container px-2 py-0.5 text-[11px] font-medium text-on-error-container"
            >
              <Icon name="warning" size={13} />
              ⚠️ 적게 본 구간 {Math.round(low.watchRatio * 100)}%
            </span>
          )}
        </span>
        {mediaKind === 'source' && (
          <span className="line-clamp-2 block text-[13px] leading-5">
            {words.length > 0
              ? words.map((word) => word.text).join(' ')
              : '이 구간에는 자막 단어가 없어요'}
          </span>
        )}
        {planIndex === null && (
          <span className="block text-xs text-error">
            {mediaKind === 'source'
              ? '무음과 지운 단어를 빼면 남는 구간이 없어서 MP4에서 빠져요'
              : '미디어 클립 길이가 너무 짧아 MP4에서 빠져요'}
          </span>
        )}
      </button>
      {props.children}
    </li>
  );
}

export function ClipEditor(props: {
  clips: readonly ResolvedClip[];
  clipIndex: number;
  transcript: Transcript;
  settings: CompositionSettings;
  sourceDurationSec: number;
  assets: AssetStore;
  retentionPoints?: readonly YouTubeRetentionPoint[];
  retentionPeaks?: readonly YouTubeRetentionPeak[];
  retentionLows?: readonly YouTubeRetentionPeak[];
  subcutsFor: (range: TimeRange) => TimeRange[];
  /** Whether the Scenario differs from Gemini's proposal. */
  edited: boolean;
  dispatch: Dispatch<EditorAction>;
}) {
  const {clips, clipIndex, settings, assets, dispatch} = props;
  const [busyMedia, setBusyMedia] = useState<'image' | 'video' | null>(null);
  const [mediaError, setMediaError] = useState('');

  const proposal = proposeNewClip(
    props.transcript,
    clips[clipIndex]?.clip,
    settings,
    props.sourceDurationSec,
  );

  const insertMediaClip = (kind: 'image' | 'video') => async (file: File) => {
    setBusyMedia(kind);
    setMediaError('');
    try {
      const asset = await assets.add(file, kind);
      const endSec =
        kind === 'image'
          ? 3
          : roundMs(asset.durationSec > 0 ? Math.min(asset.durationSec, 10) : 5);
      dispatch({
        type: 'addMediaClip',
        mediaKind: kind,
        assetId: asset.assetId,
        range: {startSec: 0, endSec},
        purpose: file.name,
        afterIndex: clipIndex,
      });
    } catch (reason) {
      setMediaError(errorMessage(reason));
    } finally {
      setBusyMedia(null);
    }
  };

  return (
    <Card
      title={`클립 ${clips.length}개`}
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="tonal"
            size="sm"
            icon="add"
            disabled={proposal === null}
            onClick={() =>
              proposal && dispatch({type: 'addClip', range: proposal, afterIndex: clipIndex})
            }
          >
            원본 클립
          </Button>
          <FilePicker
            label="이미지 삽입"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            busy={busyMedia === 'image'}
            icon="add_photo_alternate"
            onFile={insertMediaClip('image')}
          />
          <FilePicker
            label="영상 삽입"
            accept="video/mp4,video/webm,video/quicktime,video/x-matroska"
            busy={busyMedia === 'video'}
            icon="video_call"
            onFile={insertMediaClip('video')}
          />
        </div>
      }
    >
      {mediaError && <p className="mb-2 px-2 text-xs text-error">{mediaError}</p>}
      {clips.length === 0 ? (
        <p className="px-2 pb-2 text-sm text-on-surface-variant">
          클립이 없습니다.
        </p>
      ) : (
        <ol className="space-y-2">
          {clips.map((resolved, position) => {
            const mediaKind = resolved.clip.mediaKind ?? 'source';
            return (
              <ClipItem
                key={resolved.clip.clipId}
                resolved={resolved}
                position={position}
                selected={position === clipIndex}
                peak={matchingPeak(resolved.clip, props.retentionPeaks)}
                low={matchingPeak(resolved.clip, props.retentionLows)}
                dispatch={dispatch}
              >
                {position === clipIndex &&
                  (mediaKind === 'image' ? (
                    <ImageClipEditor
                      clip={resolved.clip}
                      index={position}
                      count={clips.length}
                      assets={assets}
                      dispatch={dispatch}
                    />
                  ) : mediaKind === 'video' ? (
                    <VideoClipEditor
                      clip={resolved.clip}
                      index={position}
                      count={clips.length}
                      assets={assets}
                      settings={settings}
                      dispatch={dispatch}
                    />
                  ) : (
                    <ClipRangeEditor
                      resolved={resolved}
                      index={position}
                      count={clips.length}
                      transcript={props.transcript}
                      settings={settings}
                      sourceDurationSec={props.sourceDurationSec}
                      retentionPoints={props.retentionPoints}
                      retentionPeaks={props.retentionPeaks}
                      retentionLows={props.retentionLows}
                      subcutsFor={props.subcutsFor}
                      dispatch={dispatch}
                    />
                  ))}
              </ClipItem>
            );
          })}
        </ol>
      )}
      <div className="mt-3 flex justify-center">
        <Button
          variant="text"
          size="sm"
          icon="undo"
          disabled={!props.edited}
          onClick={() => dispatch({type: 'resetScenario'})}
        >
          Gemini 제안으로 되돌리기
        </Button>
      </div>
    </Card>
  );
}
