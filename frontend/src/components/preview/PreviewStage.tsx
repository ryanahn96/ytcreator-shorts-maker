/**
 * The jump-cut preview. It plays the edited Scenario's Subcuts back to back
 * inside the short template, either on the uploaded MP4 (drawn like the
 * render, J/L-cuts included) or, before an upload, on the YouTube player.
 * Each Clip shows its Look (colors, fonts, border, framing); text blocks
 * and images of the Look on screen can be dragged, and the Background
 * Music plays along. Selecting another Clip while paused moves the
 * playhead to it, so the Look being edited is the one shown. The stage
 * can go full screen.
 */

import {Maximize, Minimize, Pause, Play, RotateCcw} from 'lucide-react';
import {useEffect, useMemo, useRef, useState, type PointerEvent} from 'react';

import {useJumpCutPlayback} from '../../hooks/useJumpCutPlayback';
import {useMusicSync} from '../../hooks/useMusicSync';
import {fontMap, useFonts} from '../../lib/fonts';
import {formatClock} from '../../lib/format';
import type {PlayerAdapter} from '../../lib/players';
import {
  locateOutput,
  videoSegments,
  type OutputCue,
  type OutputSegment,
  type ResolvedScenario,
} from '../../lib/timeline';
import type {Look, Scenario, SourceVideo, StudioConfig} from '../../types';
import {CanvasPreview} from './CanvasPreview';
import {OverlayLayer} from './OverlayLayer';
import {YouTubePreview} from './YouTubePreview';

function activeCue(cues: readonly OutputCue[], outputSec: number): OutputCue | null {
  return (
    cues.find((cue) => cue.startSec <= outputSec && outputSec < cue.endSec) ?? null
  );
}

/** Output span of every RenderPlan clip, for the transport bar. */
function clipBlocks(
  segments: readonly OutputSegment[],
): {planIndex: number; startSec: number; endSec: number}[] {
  const blocks: {planIndex: number; startSec: number; endSec: number}[] = [];
  for (const segment of segments) {
    const endSec = segment.outputStartSec + segment.endSec - segment.startSec;
    const last = blocks.at(-1);
    if (last && last.planIndex === segment.planIndex) {
      last.endSec = endSec;
    } else {
      blocks.push({planIndex: segment.planIndex, startSec: segment.outputStartSec, endSec});
    }
  }
  return blocks;
}

function TransportBar(props: {
  durationSec: number;
  outputSec: number;
  segments: readonly OutputSegment[];
  onSeek: (outputSec: number) => void;
}) {
  const {durationSec} = props;
  const percent = (seconds: number) =>
    `${durationSec > 0 ? (seconds / durationSec) * 100 : 0}%`;
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) {
      const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
      props.onSeek(fraction * durationSec);
    }
  };
  return (
    <div
      onPointerDown={seek}
      className="relative h-6 cursor-pointer overflow-hidden rounded bg-zinc-800"
      aria-label="재생 위치"
    >
      {clipBlocks(props.segments).map((block) => (
        <div
          key={block.planIndex}
          className={`absolute inset-y-1 border-r-2 border-zinc-900 ${
            block.planIndex % 2 === 0 ? 'bg-indigo-500/50' : 'bg-sky-500/50'
          }`}
          style={{
            left: percent(block.startSec),
            width: percent(block.endSec - block.startSec),
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
        style={{left: percent(props.outputSec)}}
      />
    </div>
  );
}

export function PreviewStage(props: {
  config: StudioConfig;
  sourceVideo: SourceVideo;
  resolved: ResolvedScenario;
  scenario: Scenario;
  /** The Clip selected in the editor. */
  clipIndex: number;
  localVideoUrl: string | null;
  fps: number;
  /** Source Video length, the limit of J-cut frames past a Clip. */
  sourceDurationSec: number;
  assetUrls: ReadonlyMap<string, string>;
  selectedImageId: string | null;
  onSelectImage: (overlayId: string | null) => void;
  /** A drag edited the Look shown for the Clip at `clipIndex`. */
  onLookEdit: (clipIndex: number, look: Look) => void;
}) {
  const {config, resolved, scenario} = props;
  const [adapter, setAdapter] = useState<PlayerAdapter | null>(null);
  // Switch segments within half a frame of their end.
  const toleranceSec = props.fps > 0 ? 0.5 / props.fps : 0;
  const playback = useJumpCutPlayback(adapter, resolved.segments, toleranceSec);
  const output = config.renderProfiles.preview;
  const style = config.templateStyle;
  const cue = activeCue(resolved.cues, playback.outputSec);
  const track = useMemo(
    () =>
      videoSegments(resolved.segments, scenario.audioTransition, props.fps, props.sourceDurationSec),
    [resolved.segments, scenario.audioTransition, props.fps, props.sourceDurationSec],
  );
  // The Clip on screen (Looks follow the picture), and the Look it shows.
  const located = locateOutput(track, playback.outputSec);
  const shownPlan = located ? track[located.index].planIndex : null;
  const shownIndex =
    shownPlan === null
      ? props.clipIndex
      : resolved.clips.findIndex((clip) => clip.planIndex === shownPlan);
  const shown = resolved.clips[shownIndex];
  const look = shown?.look ?? scenario.look;

  // Bring the selected Clip on screen when the selection changes while
  // paused. Refs keep the effect keyed on the selection alone.
  const latest = useRef({playback, resolved, shownPlan});
  latest.current = {playback, resolved, shownPlan};
  const selectedPlan = resolved.clips[props.clipIndex]?.planIndex ?? null;
  useEffect(() => {
    const current = latest.current;
    if (current.playback.playing || selectedPlan === null || current.shownPlan === selectedPlan) {
      return;
    }
    const segment = current.resolved.segments.find((item) => item.planIndex === selectedPlan);
    if (segment) {
      current.playback.seekOutput(segment.outputStartSec);
    }
  }, [props.clipIndex, selectedPlan]);

  const fonts = useMemo(() => fontMap(config.fonts), [config.fonts]);
  useFonts(config.fonts, [look.style.headline.fontId, look.style.caption.fontId]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      stageRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  const musicRef = useRef<HTMLAudioElement>(null);
  const musicUrl = scenario.music ? (props.assetUrls.get(scenario.music.assetId) ?? null) : null;
  useMusicSync({
    audio: musicRef,
    url: musicUrl,
    playing: playback.playing,
    outputSec: playback.outputSec,
    durationSec: resolved.durationSec,
    volume: scenario.music?.volume ?? 0,
    fadeOutSec: config.composition.musicFadeOutSec,
  });
  const toggle = () => {
    props.onSelectImage(null);
    if (playback.playing) {
      playback.pause();
    } else {
      playback.play();
    }
  };
  const overlay = (
    <OverlayLayer
      style={style}
      fonts={fonts}
      look={look}
      caption={cue ? cue.words.map((word) => word.text).join(' ') : ''}
      assetUrls={props.assetUrls}
      showPlaceholders={!playback.playing}
      selectedImageId={props.selectedImageId}
      onSelectImage={props.onSelectImage}
      onLook={(next) => props.onLookEdit(Math.max(0, shownIndex), next)}
    />
  );
  const empty = resolved.segments.length === 0;
  // A Source Video analyzed from an uploaded file has no YouTube player.
  const playable = props.localVideoUrl !== null || props.sourceVideo.url !== '';

  return (
    <div ref={stageRef} className="studio-stage space-y-3">
      {musicUrl && <audio ref={musicRef} src={musicUrl} loop preload="auto" />}
      {!playable ? (
        <p className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
          분석한 영상 파일이 이 화면에서 제거되었습니다. 아래 업로드 패널에서 같은 파일을 다시
          올리면 미리 볼 수 있습니다.
        </p>
      ) : props.localVideoUrl ? (
        <CanvasPreview
          objectUrl={props.localVideoUrl}
          framing={look.framingLayout}
          lookStyle={look.style}
          style={style}
          output={output}
          videoSegments={track}
          clock={playback.clock}
          onAdapter={setAdapter}
          onToggle={toggle}
        >
          {overlay}
        </CanvasPreview>
      ) : (
        <YouTubePreview
          sourceVideo={props.sourceVideo}
          framing={look.framingLayout}
          lookStyle={look.style}
          style={style}
          output={output}
          onAdapter={setAdapter}
          onToggle={toggle}
        >
          {overlay}
        </YouTubePreview>
      )}
      <div className="studio-controls-bar flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!adapter || empty}
          aria-label={playback.playing ? '일시정지' : '재생'}
          className="rounded-full bg-indigo-600 p-2 text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {playback.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          onClick={() => {
            playback.seekOutput(0);
            playback.play();
          }}
          disabled={!adapter || empty}
          aria-label="처음부터"
          className="rounded-full p-2 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          <RotateCcw size={16} />
        </button>
        <span className="font-mono text-xs text-zinc-300">
          {formatClock(playback.outputSec)} / {formatClock(resolved.durationSec)}
        </span>
        {shown && (
          <span className="ml-auto text-[11px] text-zinc-400">
            화면: Clip {shownIndex + 1} · {shown.clip.look ? '이 Clip 전용 설정' : '공통 설정'}
          </span>
        )}
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fullscreen ? '전체 화면 끝내기' : '전체 화면으로 보기'}
          title={fullscreen ? '전체 화면 끝내기 (Esc)' : '전체 화면으로 보기'}
          className={`rounded-full p-2 text-zinc-300 hover:bg-zinc-800 ${shown ? '' : 'ml-auto'}`}
        >
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      </div>
      <div className="studio-controls-bar">
        <TransportBar
          durationSec={resolved.durationSec}
          outputSec={playback.outputSec}
          segments={resolved.segments}
          onSeek={playback.seekOutput}
        />
      </div>
      <p className="studio-hint text-[11px] text-zinc-500">
        {empty
          ? '재생할 Subcut이 없습니다.'
          : props.localVideoUrl
            ? '글자·이미지를 끌어 옮기면 지금 보이는 Clip의 설정이 바뀝니다. 색·글꼴·J/L컷까지 렌더와 같게 보여 줍니다.'
            : '글자·이미지를 끌어 옮길 수 있습니다. YouTube 플레이어는 컷 경계가 조금 어긋날 수 있고 J/L컷은 MP4를 올린 뒤에 보입니다.'}
      </p>
    </div>
  );
}
