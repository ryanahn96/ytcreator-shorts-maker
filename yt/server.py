"""FastAPI routes of Agentic Shorts 생성 스튜디오.

This module only maps HTTP to the yt.studio pipeline (see
yt/studio/__init__.py). The Vite dev server proxies /api here; production
serves the built frontend from frontend/dist as well.

Run:
  uv run python -m yt.server
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
import json
import pathlib
import secrets
from typing import Any
from urllib import parse as urllib_parse

import fastapi
from fastapi import exceptions as fastapi_exceptions
from fastapi import responses
from starlette import exceptions as starlette_exceptions
from starlette import requests as starlette_requests
import uvicorn

from yt.studio import composer
from yt.studio import config
from yt.studio import director
from yt.studio import fonts
from yt.studio import gemini
from yt.studio import ingestion
from yt.studio import layout
from yt.studio import models
from yt.studio import prompts
from yt.studio import storage
from yt.studio import youtube

app = fastapi.FastAPI(title='Agentic Shorts 생성 스튜디오 API')
_settings = config.get_settings()
_workspace = storage.Workspace(
    _settings.workdir, _settings.retention_hours, _settings.gcs_bucket
)
_SESSION_MAX_AGE_SEC = int(_settings.retention_hours * 3600)


def _error(message: str, status_code: int) -> responses.JSONResponse:
  return responses.JSONResponse({'error': message}, status_code=status_code)


def _ndjson(event: dict[str, Any]) -> bytes:
  return (json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8')


def _is_https(request: fastapi.Request) -> bool:
  proto = (
      request.headers.get('x-forwarded-proto') or request.url.scheme or 'http'
  )
  return proto.split(',')[0].strip().lower() == 'https'


def _oauth_redirect_uri(request: fastapi.Request) -> str:
  proto = (
      request.headers.get('x-forwarded-proto') or request.url.scheme or 'http'
  ).split(',')[0].strip()
  host = (
      request.headers.get('x-forwarded-host')
      or request.headers.get('host')
      or request.url.netloc
  ).split(',')[0].strip()
  return f'{proto}://{host}/api/shortform/auth/callback'


def _current_session(request: fastapi.Request) -> models.OAuthSession | None:
  """Loads and refreshes the signed-in OAuth session from the cookie."""
  session_id = request.cookies.get(youtube.SESSION_COOKIE, '').strip()
  if not session_id:
    return None
  try:
    session = _workspace.load_session(session_id)
  except storage.StorageError:
    return None
  if session is None:
    return None
  try:
    return youtube.ensure_fresh_session(_settings, _workspace, session)
  except (youtube.YouTubeError, storage.StorageError):
    return None


def _require_session(request: fastapi.Request) -> models.OAuthSession:
  """Returns the signed-in creator session or raises HTTP 401."""
  session = _current_session(request)
  if session is None:
    raise starlette_exceptions.HTTPException(
        status_code=401,
        detail='YouTube 크리에이터 계정으로 로그인이 필요합니다.',
    )
  return session


@app.get('/api/health')
def health() -> dict[str, Any]:
  """Liveness probe used by the Vite dev server before spawning us."""
  return {
      'status': 'ok',
      'geminiBackend': _settings.gemini_backend,
      'geminiConfigured': not _settings.gemini_setup_error,
      'oauthConfigured': not _settings.oauth_setup_error,
      'storage': _workspace.bucket_name or 'local',
  }


@app.get('/api/shortform/config')
def studio_config(request: fastapi.Request) -> dict[str, Any]:
  """Returns the default Editorial Prompt, editor defaults and auth status.

  The Gemini setup error also covers Vertex AI credentials that need a new
  login, so the UI can say so before an analysis starts. FastAPI runs this
  sync handler in a worker thread, which keeps the token request off the
  event loop.
  """
  setup_error = _settings.gemini_setup_error or gemini.credentials_error(
      _settings
  )
  session = _current_session(request)
  return models.StudioConfig(
      default_editorial_prompt=prompts.DEFAULT_EDITORIAL_PROMPT,
      composition=config.COMPOSITION,
      template_style=_settings.template_style,
      default_text_layouts=layout.default_text_layouts(
          _settings.template_style
      ),
      default_look_style=config.default_look_style(),
      fonts=[
          models.FontEntry(
              font_id=font.font_id,
              label=font.label,
              url=f'/api/shortform/fonts/{font.font_id}',
              em_per_line_box=fonts.em_per_line_box(font.font_id),
          )
          for font in fonts.FONTS
      ],
      max_crop_zoom=models.MAX_CROP_ZOOM,
      max_music_volume=models.MAX_MUSIC_VOLUME,
      font_warning=_settings.font_warning,
      gemini_setup_error=setup_error,
      auth=youtube.auth_status(_settings, session),
  ).to_json()


@app.get('/api/shortform/auth/login', response_model=None)
def auth_login(request: fastapi.Request) -> fastapi.Response:
  """Redirects the creator to Google's OAuth 2.0 consent screen."""
  state = secrets.token_urlsafe(24)
  redirect_uri = _oauth_redirect_uri(request)
  try:
    url = youtube.authorization_url(_settings, redirect_uri, state)
  except youtube.YouTubeError as exc:
    return _error(str(exc), 500)
  response = responses.RedirectResponse(url, status_code=302)
  response.set_cookie(
      key=youtube.STATE_COOKIE,
      value=state,
      max_age=600,
      httponly=True,
      samesite='lax',
      secure=_is_https(request),
      path='/',
  )
  return response


@app.get('/api/shortform/auth/callback', response_model=None)
def auth_callback(
    request: fastapi.Request,
    code: str = '',
    state: str = '',
    error: str = '',
) -> fastapi.Response:
  """Handles the OAuth 2.0 callback, persists the session and redirects home."""
  if error:
    msg = urllib_parse.quote(f'Google 로그인이 취소되었거나 실패했습니다: {error}')
    return responses.RedirectResponse(f'/?auth_error={msg}', status_code=302)
  cookie_state = request.cookies.get(youtube.STATE_COOKIE, '').strip()
  if not code or not state or not cookie_state or state != cookie_state:
    msg = urllib_parse.quote(
        'OAuth 상태 검증에 실패했습니다. 다시 로그인해 주세요.'
    )
    return responses.RedirectResponse(f'/?auth_error={msg}', status_code=302)
  session_id = _workspace.new_session_id()
  redirect_uri = _oauth_redirect_uri(request)
  try:
    session = youtube.exchange_code(_settings, code, redirect_uri, session_id)
    _workspace.save_session(session)
  except (youtube.YouTubeError, storage.StorageError) as exc:
    msg = urllib_parse.quote(str(exc))
    return responses.RedirectResponse(f'/?auth_error={msg}', status_code=302)

  response = responses.RedirectResponse('/', status_code=302)
  response.delete_cookie(key=youtube.STATE_COOKIE, path='/')
  response.set_cookie(
      key=youtube.SESSION_COOKIE,
      value=session.session_id,
      max_age=_SESSION_MAX_AGE_SEC,
      httponly=True,
      samesite='lax',
      secure=_is_https(request),
      path='/',
  )
  return response


@app.post('/api/shortform/auth/logout')
def auth_logout(request: fastapi.Request) -> responses.JSONResponse:
  """Clears the creator's OAuth session cookie and stored token."""
  session_id = request.cookies.get(youtube.SESSION_COOKIE, '').strip()
  if session_id:
    try:
      _workspace.discard_session(session_id)
    except storage.StorageError:
      pass
  response = responses.JSONResponse(
      youtube.auth_status(_settings, None).to_json()
  )
  response.delete_cookie(key=youtube.SESSION_COOKIE, path='/')
  return response


@app.get('/api/shortform/youtube/videos')
def youtube_videos(request: fastapi.Request) -> responses.JSONResponse:
  """Lists recent uploaded videos from the signed-in creator's channel."""
  session = _require_session(request)
  try:
    result = youtube.list_channel_videos(session.access_token)
  except youtube.YouTubeError as exc:
    return _error(str(exc), 502)
  return responses.JSONResponse(result.to_json())


@app.get('/api/shortform/youtube/videos/{video_id}/context')
def youtube_video_context(
    video_id: str, request: fastapi.Request, duration_sec: float = 0.0
) -> responses.JSONResponse:
  """Fetches Audience Retention curve, peaks and caption status for a video."""
  session = _require_session(request)
  vid = video_id.strip()
  if not vid or len(vid) > 64:
    return _error('유효하지 않은 YouTube 영상 ID입니다.', 422)
  try:
    ctx = youtube.fetch_video_context(session.access_token, vid, duration_sec)
  except youtube.YouTubeError as exc:
    return _error(str(exc), 502)
  return responses.JSONResponse(ctx.to_json())


@app.post('/api/shortform/youtube/upload')
def youtube_upload(
    body: models.YouTubeUploadRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Uploads a rendered 1080x1920 Shorts MP4 to the creator's channel."""
  session = _require_session(request)
  try:
    media_path = _workspace.render_file(body.render_id)
  except storage.NotFoundError as exc:
    return _error(str(exc), 404)
  except storage.StorageError as exc:
    return _error(str(exc), 500)
  try:
    result = youtube.upload_short(session.access_token, media_path, body)
  except youtube.YouTubeError as exc:
    return _error(str(exc), 502)
  return responses.JSONResponse(result.to_json())


async def _analysis_events(
    request: models.AnalyzeRequest,
    access_token: str,
) -> AsyncIterator[bytes]:
  """Runs the analysis and yields NDJSON progress, then result or error."""
  queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

  async def work() -> None:
    try:
      source, media_path = await asyncio.to_thread(
          _workspace.load_source, request.source_id
      )
      upload = director.UploadedVideo(source=source, media_path=media_path)
      result = await director.analyze(
          request, upload, _workspace, queue.put, access_token=access_token
      )
    except (
        storage.NotFoundError,
        storage.StorageError,
        ingestion.IngestionError,
        director.DirectorError,
    ) as exc:
      await queue.put({'type': 'error', 'error': str(exc)})
      return
    await queue.put({'type': 'result', 'result': result.to_json()})

  task = asyncio.create_task(work())
  try:
    while True:
      try:
        event = await asyncio.wait_for(
            queue.get(), timeout=_settings.heartbeat_sec
        )
      except TimeoutError:
        if task.done() and queue.empty():
          failure = task.exception()
          yield _ndjson({
              'type': 'error',
              'error': f'분석이 예기치 않게 중단되었습니다: {failure!r}',
          })
          return
        yield _ndjson({'type': 'heartbeat'})
        continue
      yield _ndjson(event)
      if event['type'] in ('result', 'error'):
        return
  finally:
    task.cancel()


@app.post('/api/shortform/analyze')
async def analyze(
    body: models.AnalyzeRequest, request: fastapi.Request
) -> responses.StreamingResponse:
  """Streams the agentic analysis of a Source Video as NDJSON events."""
  session = await asyncio.to_thread(_require_session, request)
  return responses.StreamingResponse(
      _analysis_events(body, session.access_token),
      media_type='application/x-ndjson',
      headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
  )


def _schedule_purge() -> None:
  """Purges expired local files in the background without blocking uploads."""
  asyncio.create_task(asyncio.to_thread(_workspace.purge_expired))


@app.post('/api/shortform/upload-source/init')
async def upload_source_init(
    body: models.UploadInitRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Initializes a direct GCS resumable upload session when configured."""
  await asyncio.to_thread(_require_session, request)
  _schedule_purge()
  filename = pathlib.PurePath(body.filename).name or 'source.mp4'
  origin = request.headers.get('origin', '').strip()
  try:
    session = await asyncio.to_thread(
        _workspace.init_source_upload,
        filename,
        body.size_bytes,
        body.content_type,
        origin,
    )
  except storage.StorageError as exc:
    return _error(f'업로드 세션을 시작하지 못했습니다: {exc}', 500)
  if session is None:
    return responses.JSONResponse(
        models.UploadInitResponse(mode='direct').to_json()
    )
  source_id, upload_url = session
  return responses.JSONResponse(
      models.UploadInitResponse(
          mode='gcs',
          source_id=source_id,
          upload_url=upload_url,
      ).to_json()
  )


@app.post('/api/shortform/upload-source/complete')
async def upload_source_complete(
    body: models.UploadCompleteRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Finalizes a direct GCS upload without downloading the full video."""
  await asyncio.to_thread(_require_session, request)
  filename = pathlib.PurePath(body.filename).name or 'source.mp4'
  try:
    actual_size = await asyncio.to_thread(
        _workspace.verify_source_object, body.source_id, filename
    )
  except storage.StorageError as exc:
    return _error(f'업로드된 파일을 확인하지 못했습니다: {exc}', 500)
  if actual_size is None:
    return _error('업로드된 원본 파일을 찾을 수 없습니다.', 404)
  if actual_size == 0:
    await _discard(_workspace.discard_source, body.source_id)
    return _error('빈 파일이 업로드되었습니다.', 422)
  media = models.MediaInfo(
      duration_sec=round(max(body.duration_sec, 0.1), 3),
      fps=round(body.fps if body.fps > 0 else 30.0, 3),
      width=max(body.width, 1),
      height=max(body.height, 1),
  )
  source = models.UploadedSource(
      source_id=body.source_id,
      filename=filename,
      size_bytes=actual_size,
      media=media,
      has_audio=body.has_audio,
      silences=[],
  )
  try:
    await asyncio.to_thread(_workspace.save_source_meta, source)
  except (OSError, storage.StorageError) as exc:
    await _discard(_workspace.discard_source, body.source_id)
    return _error(f'업로드 정보를 저장하지 못했습니다: {exc}', 500)
  return responses.JSONResponse(source.to_json())


@app.post('/api/shortform/upload-source')
async def upload_source(request: fastapi.Request) -> responses.JSONResponse:
  """Stores a raw MP4 body and probes its basic stream metadata."""
  await asyncio.to_thread(_require_session, request)
  _schedule_purge()
  filename = urllib_parse.unquote(request.headers.get('x-filename', ''))
  filename = pathlib.PurePath(filename).name or 'source.mp4'
  source_id, path = _workspace.new_source(filename, purge=False)
  size = 0
  try:
    with path.open('wb', buffering=16 * 1024 * 1024) as handle:
      async for chunk in request.stream():
        handle.write(chunk)
        size += len(chunk)
    if size == 0:
      raise ingestion.IngestionError('빈 파일이 업로드되었습니다.')
    media, has_audio = await asyncio.to_thread(
        ingestion.probe_media, str(path)
    )
    source = models.UploadedSource(
        source_id=source_id,
        filename=filename,
        size_bytes=size,
        media=media,
        has_audio=has_audio,
        silences=[],
    )
    await asyncio.to_thread(_workspace.save_source, source)
  except ingestion.IngestionError as exc:
    await _discard(_workspace.discard_source, source_id)
    return _error(str(exc), 422)
  except starlette_requests.ClientDisconnect:
    await _discard(_workspace.discard_source, source_id)
    return _error('업로드가 중단되었습니다.', 400)
  except (OSError, storage.StorageError) as exc:
    await _discard(_workspace.discard_source, source_id)
    return _error(f'업로드한 파일을 저장하지 못했습니다: {exc}', 500)
  return responses.JSONResponse(source.to_json())


@app.post('/api/shortform/upload-asset')
async def upload_asset(
    request: fastapi.Request, kind: models.AssetKind
) -> responses.JSONResponse:
  """Stores a raw image or audio body for Image Overlays or music."""
  await asyncio.to_thread(_require_session, request)
  filename = urllib_parse.unquote(request.headers.get('x-filename', ''))
  filename = pathlib.PurePath(filename).name
  try:
    asset_id, path = _workspace.new_asset(kind, filename)
  except ValueError as exc:
    return _error(str(exc), 422)
  size = 0
  try:
    with path.open('wb') as handle:
      async for chunk in request.stream():
        handle.write(chunk)
        size += len(chunk)
    if size == 0:
      raise ingestion.IngestionError('빈 파일이 업로드되었습니다.')
    width, height, duration, has_audio = await asyncio.to_thread(
        ingestion.probe_asset, str(path), kind
    )
    asset = models.UploadedAsset(
        asset_id=asset_id,
        kind=kind,
        filename=filename,
        size_bytes=size,
        width=width,
        height=height,
        duration_sec=duration,
        has_audio=has_audio,
    )
    await asyncio.to_thread(_workspace.save_asset, asset)
  except ingestion.IngestionError as exc:
    await _discard(_workspace.discard_asset, asset_id)
    return _error(str(exc), 422)
  except starlette_requests.ClientDisconnect:
    await _discard(_workspace.discard_asset, asset_id)
    return _error('업로드가 중단되었습니다.', 400)
  except (OSError, storage.StorageError) as exc:
    await _discard(_workspace.discard_asset, asset_id)
    return _error(f'업로드한 파일을 저장하지 못했습니다: {exc}', 500)
  return responses.JSONResponse(asset.to_json())


async def _discard(remove: Callable[[str], None], item_id: str) -> None:
  """Removes a failed upload; a bucket error here is not worth reporting."""
  try:
    await asyncio.to_thread(remove, item_id)
  except storage.StorageError:
    pass


def _asset_files(
    plan: models.RenderPlan,
) -> tuple[dict[str, str], dict[str, models.UploadedAsset]]:
  """Maps every asset id of a plan to its workspace path and metadata.

  Raises:
    storage.NotFoundError: If an asset is unknown or expired.
  """
  files: dict[str, str] = {}
  meta: dict[str, models.UploadedAsset] = {}
  for asset_id in composer.plan_asset_ids(plan):
    asset, path = _workspace.load_asset(asset_id)
    files[asset_id] = str(path)
    meta[asset_id] = asset
  return files, meta


@app.post('/api/shortform/render')
async def render(
    body: models.RenderRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Renders an edited Scenario from the uploaded Source Video."""
  await asyncio.to_thread(_require_session, request)
  try:
    source, media_path = await asyncio.to_thread(
        _workspace.load_source, body.source_id
    )
    if source.media.width <= 2 or source.media.height <= 2:
      probed_media, probed_audio = await asyncio.to_thread(
          ingestion.probe_media, str(media_path)
      )
      source = source.model_copy(
          update={'media': probed_media, 'has_audio': probed_audio}
      )
      await asyncio.to_thread(_workspace.save_source_meta, source)
    assets, asset_meta = await asyncio.to_thread(_asset_files, body.plan)
  except storage.NotFoundError as exc:
    return _error(str(exc), 404)
  except (ingestion.IngestionError, storage.StorageError) as exc:
    return _error(str(exc), 500)
  if not source.has_audio:
    return _error('업로드한 원본에 오디오 트랙이 없습니다.', 422)
  profile = config.RENDER_PROFILES[body.quality]
  render_id, folder = _workspace.new_render()
  output = _workspace.render_output(folder)
  try:
    composition = composer.compose(
        body.plan,
        source.media,
        profile,
        composer.RenderPaths(
            ffmpeg_bin=_settings.ffmpeg_bin,
            source=str(media_path),
            output=str(output),
            assets=assets,
            asset_meta=asset_meta,
        ),
    )
    await asyncio.to_thread(composer.run, composition, folder)
    video_sec, audio_sec = await asyncio.to_thread(
        composer.measure_streams, output
    )
    await asyncio.to_thread(_workspace.save_render, render_id)
  except composer.CompositionError as exc:
    return _error(str(exc), 422)
  except (composer.RenderError, storage.StorageError) as exc:
    return _error(str(exc), 500)
  return responses.JSONResponse(
      models.RenderOutput(
          render_id=render_id,
          video_url=f'/api/shortform/renders/{render_id}',
          planned_duration_sec=round(composition.timeline.duration_sec, 3),
          measured_video_sec=round(video_sec, 3),
          measured_audio_sec=round(audio_sec, 3),
          width=profile.width,
          height=profile.height,
      ).to_json()
  )


@app.get('/api/shortform/fonts/{font_id}', response_model=None)
def font_file(font_id: str) -> fastapi.Response:
  """Serves a bundled font file so the preview draws with the render's fonts."""
  try:
    font = fonts.get(font_id)
  except KeyError:
    return _error(f'알 수 없는 글꼴입니다: {font_id}', 404)
  path = fonts.path(font)
  if not path.is_file():
    return _error(f'글꼴 파일이 없습니다: {font.filename}', 404)
  media_type = 'font/otf' if path.suffix == '.otf' else 'font/ttf'
  return responses.FileResponse(
      path,
      media_type=media_type,
      headers={'Cache-Control': 'public, max-age=86400'},
  )


@app.get('/api/shortform/renders/{render_id}', response_model=None)
def render_file(render_id: str, request: fastapi.Request) -> fastapi.Response:
  """Serves a rendered MP4 (supports range requests for the player).

  A sync handler, so fetching the file from the bucket (when another
  instance rendered it) runs in FastAPI's worker thread.
  """
  _require_session(request)
  try:
    path = _workspace.render_file(render_id)
  except storage.NotFoundError as exc:
    return _error(str(exc), 404)
  except storage.StorageError as exc:
    return _error(str(exc), 500)
  return responses.FileResponse(path, media_type='video/mp4')


@app.exception_handler(starlette_exceptions.HTTPException)
def http_error(
    unused_request: fastapi.Request, exc: starlette_exceptions.HTTPException
) -> responses.JSONResponse:
  """Formats HTTP errors as {"error": ...}."""
  return _error(str(exc.detail), exc.status_code)


@app.exception_handler(fastapi_exceptions.RequestValidationError)
def validation_error(
    unused_request: fastapi.Request,
    exc: fastapi_exceptions.RequestValidationError,
) -> responses.JSONResponse:
  """Formats request validation errors as {"error": ...} with HTTP 422."""
  details = '; '.join(
      '.'.join(str(part) for part in error.get('loc', ()))
      + f': {error.get("msg", "")}'
      for error in exc.errors()
  )
  return _error(f'요청 형식이 올바르지 않습니다. {details}', 422)


@app.get('/{path:path}', response_model=None)
def frontend(path: str) -> fastapi.Response:
  """Serves the built frontend (frontend/dist) with an SPA fallback."""
  if path == 'api' or path.startswith('api/'):
    return _error('Not found', 404)
  dist = _settings.dist_dir.resolve()
  candidate = (dist / path).resolve()
  if path and candidate.is_file() and candidate.is_relative_to(dist):
    return responses.FileResponse(candidate)
  index = dist / 'index.html'
  if index.is_file():
    return responses.FileResponse(index)
  return responses.JSONResponse({'status': 'backend running'})


def main() -> int:
  """Starts the API server."""
  uvicorn.run(app, host='0.0.0.0', port=_settings.backend_port)
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
