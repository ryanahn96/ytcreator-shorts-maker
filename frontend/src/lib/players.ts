/**
 * Players the jump-cut preview can drive: the uploaded MP4 in a <video>
 * element, or the YouTube IFrame player before an upload exists.
 */

const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

/** The minimal control surface the preview sequencer needs. */
export interface PlayerAdapter {
  currentTime(): number;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
}

export interface YouTubePlayer {
  getCurrentTime(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

interface YouTubePlayerOptions {
  videoId: string;
  width: string;
  height: string;
  playerVars: Record<string, number>;
  events: {onReady: () => void};
}

interface YouTubeApi {
  Player: new (host: HTMLElement, options: YouTubePlayerOptions) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: Partial<YouTubeApi>;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeApi> | null = null;

function readyApi(): YouTubeApi | null {
  const Player = window.YT?.Player;
  return Player ? {Player} : null;
}

/** Loads the YouTube IFrame Player API once per page. */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  apiPromise ??= new Promise<YouTubeApi>((resolve, reject) => {
    const ready = readyApi();
    if (ready) {
      resolve(ready);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      const api = readyApi();
      if (api) {
        resolve(api);
      } else {
        reject(new Error('YouTube 플레이어 API가 초기화되지 않았습니다.'));
      }
    };
    const script = document.createElement('script');
    script.src = IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('YouTube 플레이어 API를 불러오지 못했습니다.'));
    };
    document.head.append(script);
  });
  return apiPromise;
}

export function videoElementAdapter(video: HTMLVideoElement): PlayerAdapter {
  return {
    currentTime: () => video.currentTime,
    seek: (seconds) => {
      video.currentTime = seconds;
    },
    play: () => {
      // play() rejects when a later pause() interrupts it; the sequencer
      // already tracks that state, so the rejection carries no news.
      video.play().catch(() => undefined);
    },
    pause: () => video.pause(),
  };
}

export function youTubeAdapter(player: YouTubePlayer): PlayerAdapter {
  return {
    currentTime: () => player.getCurrentTime(),
    seek: (seconds) => player.seekTo(seconds, true),
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
  };
}
