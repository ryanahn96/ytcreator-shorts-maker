/** HTTP client of the studio backend (routes live in yt/server.py). */

import type {
  AnalyzeEvent,
  AnalyzeRequest,
  AssetKind,
  AuthStatus,
  LocalVideoMetadata,
  RenderOutput,
  RenderRequest,
  StudioConfig,
  UploadCompleteRequest,
  UploadedAsset,
  UploadedSource,
  UploadInitResponse,
  YouTubeUploadRequest,
  YouTubeUploadResult,
  YouTubeVideoContext,
  YouTubeVideoList,
} from '../types';

const API_ROOT = '/api/shortform';
export const LOGIN_URL = `${API_ROOT}/auth/login`;
const ANALYZE_EVENT_TYPES = new Set(['progress', 'heartbeat', 'result', 'error']);

export class ApiError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`서버 응답을 해석하지 못했습니다 (HTTP ${status}).`);
  }
}

function failure(body: unknown, status: number): ApiError {
  const message = isRecord(body) ? body['error'] : undefined;
  return new ApiError(
    typeof message === 'string' ? message : `요청이 실패했습니다 (HTTP ${status}).`,
  );
}

/**
 * Returns the parsed body of a response, or throws its {error} message.
 *
 * Every success body is produced by the pydantic models that types.ts
 * mirrors, so after the object check the body is trusted as T.
 */
function accept<T>(status: number, text: string): T {
  const body = parseJson(text, status);
  if (status < 200 || status >= 300) {
    throw failure(body, status);
  }
  if (!isRecord(body)) {
    throw new ApiError(`서버 응답 형식이 올바르지 않습니다 (HTTP ${status}).`);
  }
  return body as T;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_ROOT}${path}`, init);
  } catch (error) {
    if (init?.signal?.aborted) {
      throw error;
    }
    throw new ApiError(`서버에 연결하지 못했습니다: ${String(error)}`);
  }
}

function jsonInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
    signal,
  };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  return accept<T>(response.status, await response.text());
}

export function getConfig(): Promise<StudioConfig> {
  return requestJson<StudioConfig>('/config');
}

export function logout(): Promise<AuthStatus> {
  return requestJson<AuthStatus>('/auth/logout', {method: 'POST'});
}

export function listYouTubeVideos(): Promise<YouTubeVideoList> {
  return requestJson<YouTubeVideoList>('/youtube/videos');
}

export function getYouTubeVideoContext(
  videoId: string,
  durationSec = 0,
): Promise<YouTubeVideoContext> {
  const params = new URLSearchParams();
  if (durationSec > 0) {
    params.set('duration_sec', String(durationSec));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return requestJson<YouTubeVideoContext>(
    `/youtube/videos/${encodeURIComponent(videoId)}/context${suffix}`,
  );
}

export function uploadShortToYouTube(
  body: YouTubeUploadRequest,
): Promise<YouTubeUploadResult> {
  return requestJson<YouTubeUploadResult>('/youtube/upload', jsonInit(body));
}

/** Renders the 1080x1920 MP4 of a plan on the server. */
export function renderPlan(body: RenderRequest): Promise<RenderOutput> {
  return requestJson<RenderOutput>('/render', jsonInit(body));
}

function parseEvent(line: string): AnalyzeEvent {
  const event = parseJson(line, 200);
  if (!isRecord(event) || typeof event['type'] !== 'string') {
    throw new ApiError('분석 스트림에 알 수 없는 이벤트가 있습니다.');
  }
  if (!ANALYZE_EVENT_TYPES.has(event['type'])) {
    throw new ApiError(`분석 스트림 이벤트 종류를 알 수 없습니다: ${event['type']}`);
  }
  return event as unknown as AnalyzeEvent;
}

/**
 * Streams the agentic analysis (NDJSON). Calls onEvent for every event and
 * resolves when the server closes the stream.
 */
export async function analyze(
  body: AnalyzeRequest,
  onEvent: (event: AnalyzeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await send('/analyze', jsonInit(body, signal));
  if (!response.ok) {
    throw failure(parseJson(await response.text(), response.status), response.status);
  }
  if (!response.body) {
    throw new ApiError('분석 스트림을 열지 못했습니다.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {value, done} = await reader.read();
    buffer += decoder.decode(value, {stream: !done});
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        onEvent(parseEvent(line));
      }
      newline = buffer.indexOf('\n');
    }
    if (done) {
      return;
    }
  }
}

function uploadSourceDirect(
  file: File,
  onProgress: (loadedBytes: number) => void,
  signal: AbortSignal,
): Promise<UploadedSource> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_ROOT}/upload-source`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      try {
        resolve(accept<UploadedSource>(xhr.status, xhr.responseText));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new ApiError('업로드 중 네트워크 오류가 발생했습니다.'));
    xhr.onabort = () => reject(new ApiError('업로드를 취소했습니다.'));
    signal.addEventListener('abort', () => xhr.abort(), {once: true});
    xhr.send(file);
  });
}

function putToGcsSession(
  uploadUrl: string,
  file: File,
  contentType: string,
  onProgress: (loadedBytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(
          new ApiError(`Cloud Storage 업로드에 실패했습니다 (HTTP ${xhr.status}).`),
        );
      }
    };
    xhr.onerror = () =>
      reject(new ApiError('Cloud Storage 직접 업로드 중 네트워크 오류가 발생했습니다.'));
    xhr.onabort = () => reject(new ApiError('업로드를 취소했습니다.'));
    signal.addEventListener('abort', () => xhr.abort(), {once: true});
    xhr.send(file);
  });
}

/**
 * Uploads the Source Video MP4 directly to GCS via a pre-authenticated
 * resumable session URL when STUDIO_GCS_BUCKET is enabled, falling back
 * to streaming through the backend in local development.
 */
export async function uploadSource(
  file: File,
  onProgress: (loadedBytes: number) => void,
  signal: AbortSignal,
  meta?: LocalVideoMetadata,
): Promise<UploadedSource> {
  const contentType = file.type || 'video/mp4';
  const init = await requestJson<UploadInitResponse>(
    '/upload-source/init',
    jsonInit(
      {
        filename: file.name,
        sizeBytes: file.size,
        contentType,
      },
      signal,
    ),
  );
  if (init.mode === 'gcs' && init.uploadUrl && init.sourceId) {
    await putToGcsSession(init.uploadUrl, file, contentType, onProgress, signal);
    const completeBody: UploadCompleteRequest = {
      sourceId: init.sourceId,
      filename: file.name,
      sizeBytes: file.size,
      durationSec: meta?.durationSec ?? 0,
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
    };
    return requestJson<UploadedSource>(
      '/upload-source/complete',
      jsonInit(completeBody, signal),
    );
  }
  return uploadSourceDirect(file, onProgress, signal);
}

/** Uploads an image or audio file for an Image Overlay or the music. */
export async function uploadAsset(file: File, kind: AssetKind): Promise<UploadedAsset> {
  return requestJson<UploadedAsset>(`/upload-asset?kind=${kind}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: file,
  });
}

/** Returns a user-facing message for any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
