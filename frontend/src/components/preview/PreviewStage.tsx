/**
 * The jump-cut preview. It plays the edited Scenario's Subcuts back to back
 * inside the short template on the Source Video file, drawn like the
 * render. Each Clip shows its Look (colors, fonts, border, framing); text
 * blocks and images of the Look on screen can be dragged, a click on them
 * focuses their controls in the right panel, and the Background Music
 * plays along. Selecting another Clip while paused moves the playhead to
 * it, so the Look being edited is the one shown. The stage can go full
 * screen.
 */

import {useEffect, useMemo, useRef, useState, type PointerEvent} from 'react';

import {useJumpCutPlayback} from '../../hooks/useJumpCutPlayback';
import {useMusicSync} from '../../hooks/useMusicSync';
import type {FocusTarget, StageHit} from '../../lib/focus';
import {fontMap, useFonts} from '../../lib/fonts';
import {formatClock} from '../../lib/format';
import type {LookEdit} from '../../lib/look';
import {
  locateOutput,
  type OutputCue,
  type OutputSegment,
  type ResolvedScenario,
} from '../../lib/timeline';
import type {Scenario, StudioConfig, TranscriptWord} from '../../types';
import {IconButton} from '../ui';
import {CanvasPreview} from './CanvasPreview';
import {OverlayLayer} from './OverlayLayer';

function activeCue(cues: readonly OutputCue[], outputSec: number): OutputCue | null {
  return (
    cues.find((cue) => cue.startSec <= outputSec && outputSec < cue.endSec) ?? null
  );
}

/**
 * The Transcript Word spoken at `sourceSec`: the one around it, else the
 * last one before it, else the first. Sound tags are not captions.
 */
function wordAt(
  words: readonly TranscriptWord[],
  sourceSec: number,
): TranscriptWord | null {
  const spoken = words.filter((word) => !word.isSoundTag);
  const around = spoken.find(
    (word) => word.startSec <= sourceSec && sourceSec < word.endSec,
  );
  const before = spoken.filter((word) => word.startSec <= sourceSec).at(-1);
  return around ?? before ?? spoken[0] ?? null;
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
      className="relative h-6 cursor-pointer overflow-hidden rounded-lg bg-surface-container-highest"
      aria-label="재생 위치"
    >
      {clipBlocks(props.segments).map((block) => (
        <div
          key={block.planIndex}
          className={`absolute inset-y-1 border-r-2 border-surface-container-highest ${
            block.planIndex % 2 === 0 ? 'bg-primary/70' : 'bg-primary/35'
          }`}
          style={{
            left: percent(block.startSec),
            width: percent(block.endSec - block.startSec),
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-on-surface"
        style={{left: percent(props.outputSec)}}
      />
    </div>
  );
}

export interface PlaybackState {
  playing: boolean;
  sourceSec: number | null;
}

export interface SourceSeekRequest {
  seq: number;
  sourceSec: number;
}

/**
 * A one-off request from the editor, acted on once per seq: pause, or
 * pause and show the Clip at `clipIndex` from its start.
 */
export type PreviewCommand = {seq: number} & (
  | {kind: 'pause'}
  | {kind: 'seekClip'; clipIndex: number}
);

export function PreviewStage(props: {
  config: StudioConfig;
  resolved: ResolvedScenario;
  scenario: Scenario;
  /** The Clip selected in the editor. */
  clipIndex: number;
  /** Object URL of the Source Video file. */
  videoUrl: string;
  fps: number;
  assetUrls: ReadonlyMap<string, string>;
  selectedImageId: string | null;
  seekRequest?: SourceSeekRequest | null;
  command?: PreviewCommand | null;
  onPlaybackChange?: (state: PlaybackState) => void;
  onSelectImage: (overlayId: string | null) => void;
  /** Called during playback or transport scrubbing when the active Clip changes. */
  onSelectClip?: (clipIndex: number) => void;
  /**
   * A drag edited the Look shown for the Clip `clipId` (the one on screen
   * when the drag started); `edit` applies only what was dragged.
   */
  onLookEdit: (clipId: string, edit: LookEdit) => void;
  /** A click on the stage asks to edit `target` of the Clip at `clipIndex`. */
  onFocus: (clipIndex: number, target: FocusTarget) => void;
}) {
  const {config, resolved, scenario} = props;
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [extVideo, setExtVideo] = useState<HTMLVideoElement | null>(null);
  // Switch segments within half a frame of their end.
  const toleranceSec = props.fps > 0 ? 0.5 / props.fps : 0;
  const playback = useJumpCutPlayback(
    video,
    resolved.segments,
    toleranceSec,
    extVideo,
    props.assetUrls,
  );
  const style = config.templateStyle;
  // Half the render size keeps drawing cheap; the frame scales it anyway.
  const output = {width: style.canvasWidth / 2, height: style.canvasHeight / 2};
  const cue = activeCue(resolved.cues, playback.outputSec);
  // The Clip on screen (Looks follow the picture), and the Look it shows.
  const located = locateOutput(resolved.segments, playback.outputSec);
  const activeSegment = located ? resolved.segments[located.index] : null;
  const shownPlan = activeSegment ? activeSegment.planIndex : null;
  const shownIndex =
    shownPlan === null
      ? props.clipIndex
      : resolved.clips.findIndex((clip) => clip.planIndex === shownPlan);
  const shown = resolved.clips[shownIndex];
  const look = shown?.look ?? scenario.look;

  // Bring the selected Clip on screen when the selection changes while
  // paused. Refs keep the effect keyed on the selection alone.
  const latest = useRef({
    playback,
    resolved,
    shownPlan,
    onSelectClip: props.onSelectClip,
    onPlaybackChange: props.onPlaybackChange,
  });
  latest.current = {
    playback,
    resolved,
    shownPlan,
    onSelectClip: props.onSelectClip,
    onPlaybackChange: props.onPlaybackChange,
  };
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

  // While playing, automatically select the active Clip in the left panel
  // as playback crosses Clip boundaries. A new editor command pauses and
  // may select another Clip in the same commit, so it goes first.
  const handledCommand = useRef<number | null>(null);
  useEffect(() => {
    const command = props.command;
    if (command && command.seq !== handledCommand.current) {
      return;
    }
    if (playback.playing && shownIndex >= 0 && shownIndex !== props.clipIndex) {
      latest.current.onSelectClip?.(shownIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.playing, shownIndex, props.clipIndex]);

  // Report live playback playhead position (sourceSec) to the editor.
  const activeSourceSec =
    located && activeSegment?.mediaKind === 'source' ? located.sourceSec : null;
  useEffect(() => {
    latest.current.onPlaybackChange?.({
      playing: playback.playing,
      sourceSec: activeSourceSec,
    });
  }, [playback.playing, activeSourceSec]);

  // Seek to a requested sourceSec when the user clicks a timestamp in the transcript or analytics tab.
  const seekSeq = props.seekRequest?.seq;
  useEffect(() => {
    if (!props.seekRequest) {
      return;
    }
    const targetSourceSec = props.seekRequest.sourceSec;
    const current = latest.current;
    const sourceSegments = current.resolved.segments.filter(
      (seg) => (seg.mediaKind ?? 'source') === 'source',
    );
    const exact = sourceSegments.find(
      (seg) => seg.startSec <= targetSourceSec && targetSourceSec <= seg.endSec,
    );
    if (exact) {
      const targetOutputSec =
        exact.outputStartSec + (targetSourceSec - exact.startSec);
      current.playback.seekOutput(targetOutputSec);
      const clipIdx = current.resolved.clips.findIndex(
        (c) => c.planIndex === exact.planIndex,
      );
      if (clipIdx >= 0) {
        current.onSelectClip?.(clipIdx);
      }
      return;
    }
    // Fallback: find the nearest source segment in the current scenario.
    let nearest = sourceSegments[0];
    let bestDist = Infinity;
    for (const seg of sourceSegments) {
      const dist =
        targetSourceSec < seg.startSec
          ? seg.startSec - targetSourceSec
          : targetSourceSec - seg.endSec;
      if (dist < bestDist) {
        bestDist = dist;
        nearest = seg;
      }
    }
    if (nearest) {
      current.playback.seekOutput(nearest.outputStartSec);
      const clipIdx = current.resolved.clips.findIndex(
        (c) => c.planIndex === nearest.planIndex,
      );
      if (clipIdx >= 0) {
        current.onSelectClip?.(clipIdx);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekSeq]);

  // Editor commands. A seek waits until the pause has rendered: seekOutput
  // keeps playing when it still sees `playing`, and an edit that rebuilds
  // the segments pauses the sequence on its own in the same commit.
  const [pendingSeek, setPendingSeek] = useState<{clipIndex: number} | null>(null);
  const commandSeq = props.command?.seq;
  useEffect(() => {
    const command = props.command;
    if (!command) {
      return;
    }
    handledCommand.current = command.seq;
    latest.current.playback.pause();
    if (command.kind === 'seekClip') {
      setPendingSeek({clipIndex: command.clipIndex});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandSeq]);
  useEffect(() => {
    if (!pendingSeek || playback.playing) {
      return;
    }
    const current = latest.current;
    const planIndex = current.resolved.clips[pendingSeek.clipIndex]?.planIndex ?? null;
    const segment =
      planIndex === null
        ? undefined
        : current.resolved.segments.find((item) => item.planIndex === planIndex);
    if (segment) {
      current.playback.seekOutput(segment.outputStartSec);
    }
    setPendingSeek(null);
  }, [pendingSeek, playback.playing]);

  const handleTransportSeek = (targetSec: number) => {
    playback.seekOutput(targetSec);
    const targetLocated = locateOutput(resolved.segments, targetSec);
    if (targetLocated) {
      const targetPlan = resolved.segments[targetLocated.index].planIndex;
      const targetClipIdx = resolved.clips.findIndex((clip) => clip.planIndex === targetPlan);
      if (targetClipIdx >= 0 && targetClipIdx !== props.clipIndex) {
        props.onSelectClip?.(targetClipIdx);
      }
    }
  };

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
  const editedIndex = Math.max(0, shownIndex);
  // A drag names its Clip by id: an Edit Request applied before it ends can
  // move or delete Clips.
  const editedClipId = resolved.clips[editedIndex]?.clip.clipId;
  // A click on the caption edits the word under the playhead; between
  // cues (the placeholder) it goes to the caption's font and colors.
  const onHit = (hit: StageHit) => {
    if (hit.kind !== 'caption') {
      props.onFocus(editedIndex, hit);
      return;
    }
    if (!cue || !located || !shown) {
      props.onFocus(editedIndex, {kind: 'captionStyle'});
      return;
    }
    const word = wordAt(shown.words, located.sourceSec);
    props.onFocus(editedIndex, {kind: 'caption', wordIndex: word?.index ?? null});
  };
  const empty = resolved.segments.length === 0;
  const unavailable = !video || empty;

  return (
    // Full screen puts the stage on black, so it switches to dark colors.
    <div
      ref={stageRef}
      data-theme={fullscreen ? 'dark' : undefined}
      className="studio-stage space-y-3 text-on-surface"
    >
      {musicUrl && <audio ref={musicRef} src={musicUrl} loop preload="auto" />}
      <CanvasPreview
        videoUrl={props.videoUrl}
        activeSegment={activeSegment}
        assetUrls={props.assetUrls}
        framing={look.framingLayout}
        lookStyle={look.style}
        style={style}
        output={output}
        onVideo={setVideo}
        onExtVideo={setExtVideo}
        onToggle={toggle}
      >
        <OverlayLayer
          style={style}
          fonts={fonts}
          look={look}
          caption={cue?.text ?? ''}
          assetUrls={props.assetUrls}
          showPlaceholders={!playback.playing}
          selectedImageId={props.selectedImageId}
          onSelectImage={props.onSelectImage}
          onLook={(edit) => {
            if (editedClipId !== undefined) {
              props.onLookEdit(editedClipId, edit);
            }
          }}
          onHit={onHit}
        />
      </CanvasPreview>
      <div className="studio-controls-bar flex items-center gap-1">
        <IconButton
          label={playback.playing ? '일시정지' : '재생'}
          icon={playback.playing ? 'pause' : 'play_arrow'}
          filled
          variant="filled"
          onClick={toggle}
          disabled={unavailable}
        />
        <IconButton
          label="처음부터"
          icon="replay"
          onClick={() => {
            handleTransportSeek(0);
            playback.play();
          }}
          disabled={unavailable}
        />
        <span className="ms-1 text-[13px] text-on-surface-variant tabular-nums">
          {formatClock(playback.outputSec)} / {formatClock(resolved.durationSec)}
        </span>
        <span className="ms-auto">
          <IconButton
            label={fullscreen ? '전체 화면 끝내기' : '전체 화면'}
            icon={fullscreen ? 'fullscreen_exit' : 'fullscreen'}
            onClick={toggleFullscreen}
          />
        </span>
      </div>
      <div className="studio-controls-bar">
        <TransportBar
          durationSec={resolved.durationSec}
          outputSec={playback.outputSec}
          segments={resolved.segments}
          onSeek={handleTransportSeek}
        />
      </div>
      {empty && (
        <p className="text-center text-sm text-on-surface-variant">재생할 구간이 없어요</p>
      )}
    </div>
  );
}
