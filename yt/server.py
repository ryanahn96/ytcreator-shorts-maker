"""FastAPI routes of the Agentic Shortform Jump-cut Studio.

This module only maps HTTP to the yt.studio pipeline (see
yt/studio/__init__.py). The Vite dev server proxies /api here; production
serves the built frontend from frontend/dist as well.

Run:
  uv run python -m yt.server
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import json
import pathlib
import shlex
import time
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

_EXPORT_OUTPUT = 'shortform.mp4'
_EXPORT_FONTS_DIR = 'fonts'
_EXPORT_FFMPEG = 'ffmpeg'

app = fastapi.FastAPI(title='Agentic Shortform Jump-cut Studio API')
_settings = config.get_settings()
_workspace = storage.Workspace(_settings.workdir, _settings.retention_hours)


def _error(message: str, status_code: int) -> responses.JSONResponse:
  return responses.JSONResponse({'error': message}, status_code=status_code)


def _ndjson(event: dict[str, Any]) -> bytes:
  return (json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8')


@app.get('/api/health')
def health() -> dict[str, Any]:
  """Liveness probe used by the Vite dev server before spawning us."""
  return {
      'status': 'ok',
      'geminiBackend': _settings.gemini_backend,
      'geminiConfigured': not _settings.gemini_setup_error,
  }


@app.get('/api/shortform/config')
def studio_config() -> dict[str, Any]:
  """Returns the default Editorial Prompt, catalogs and editor defaults.

  The Gemini setup error also covers Vertex AI credentials that need a new
  login, so the UI can say so before an analysis starts. FastAPI runs this
  sync handler in a worker thread, which keeps the token request off the
  event loop.
  """
  setup_error = _settings.gemini_setup_error or gemini.credentials_error(
      _settings
  )
  return models.StudioConfig(
      default_editorial_prompt=prompts.DEFAULT_EDITORIAL_PROMPT,
      audio_transitions=list(models.AUDIO_TRANSITIONS),
      caption_sources=list(models.CAPTION_SOURCES),
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
              family=font.family,
              url=f'/api/shortform/fonts/{font.font_id}',
              bold=font.bold,
              em_per_line_box=fonts.em_per_line_box(font.font_id),
          )
          for font in fonts.FONTS
      ],
      render_profiles=config.RENDER_PROFILES,
      max_crop_zoom=models.MAX_CROP_ZOOM,
      max_transition_sec=models.MAX_TRANSITION_SEC,
      max_music_volume=models.MAX_MUSIC_VOLUME,
      font_warning=_settings.font_warning,
      gemini_backend=_settings.gemini_backend,
      vertex_project=_settings.vertex_project,
      vertex_location=_settings.vertex_location,
      gemini_setup_error=setup_error,
      model_chain=list(_settings.model_chain),
  ).to_json()


async def _analysis_events(
    request: models.AnalyzeRequest,
) -> AsyncIterator[bytes]:
  """Runs the analysis and yields NDJSON progress, then result or error."""
  queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
  started = time.monotonic()

  def elapsed() -> float:
    return round(time.monotonic() - started, 1)

  async def emit(event: dict[str, Any]) -> None:
    await queue.put({**event, 'elapsedSec': elapsed()})

  async def work() -> None:
    try:
      upload = None
      if request.source_id:
        source, media_path = _workspace.load_source(request.source_id)
        upload = director.UploadedVideo(
            source=source,
            media_path=media_path,
            proxy_path=_workspace.analysis_proxy(request.source_id),
        )
      result = await director.analyze(request, emit, upload)
    except storage.NotFoundError as exc:
      await queue.put({'type': 'error', 'error': str(exc)})
      return
    except (ingestion.IngestionError, director.DirectorError) as exc:
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
        yield _ndjson({'type': 'heartbeat', 'elapsedSec': elapsed()})
        continue
      yield _ndjson(event)
      if event['type'] in ('result', 'error'):
        return
  finally:
    task.cancel()


@app.post('/api/shortform/analyze')
async def analyze(body: models.AnalyzeRequest) -> responses.StreamingResponse:
  """Streams the agentic analysis of a Source Video as NDJSON events."""
  return responses.StreamingResponse(
      _analysis_events(body),
      media_type='application/x-ndjson',
      headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
  )


@app.post('/api/shortform/upload-source')
async def upload_source(request: fastapi.Request) -> responses.JSONResponse:
  """Stores a raw MP4 body, then probes it and measures its silences."""
  filename = urllib_parse.unquote(request.headers.get('x-filename', ''))
  filename = pathlib.PurePath(filename).name or 'source.mp4'
  source_id, path = _workspace.new_source(filename)
  size = 0
  try:
    with path.open('wb') as handle:
      async for chunk in request.stream():
        handle.write(chunk)
        size += len(chunk)
    if size == 0:
      raise ingestion.IngestionError('빈 파일이 업로드되었습니다.')
    media, has_audio = await asyncio.to_thread(
        ingestion.probe_media, str(path)
    )
    silences = (
        await asyncio.to_thread(
            ingestion.detect_silences, str(path), media.duration_sec
        )
        if has_audio
        else []
    )
  except ingestion.IngestionError as exc:
    _workspace.discard_source(source_id)
    return _error(str(exc), 422)
  except starlette_requests.ClientDisconnect:
    _workspace.discard_source(source_id)
    return _error('업로드가 중단되었습니다.', 400)
  except OSError as exc:
    _workspace.discard_source(source_id)
    return _error(f'업로드한 파일을 저장하지 못했습니다: {exc}', 500)
  source = models.UploadedSource(
      source_id=source_id,
      filename=filename,
      size_bytes=size,
      media=media,
      has_audio=has_audio,
      silences=silences,
  )
  _workspace.save_source(source)
  return responses.JSONResponse(source.to_json())


@app.post('/api/shortform/upload-asset')
async def upload_asset(
    request: fastapi.Request, kind: models.AssetKind
) -> responses.JSONResponse:
  """Stores a raw image or audio body for Image Overlays or music."""
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
    width, height, duration = await asyncio.to_thread(
        ingestion.probe_asset, str(path), kind
    )
  except ingestion.IngestionError as exc:
    _workspace.discard_asset(asset_id)
    return _error(str(exc), 422)
  except starlette_requests.ClientDisconnect:
    _workspace.discard_asset(asset_id)
    return _error('업로드가 중단되었습니다.', 400)
  except OSError as exc:
    _workspace.discard_asset(asset_id)
    return _error(f'업로드한 파일을 저장하지 못했습니다: {exc}', 500)
  asset = models.UploadedAsset(
      asset_id=asset_id,
      kind=kind,
      filename=filename,
      size_bytes=size,
      width=width,
      height=height,
      duration_sec=duration,
  )
  _workspace.save_asset(asset)
  return responses.JSONResponse(asset.to_json())


def _asset_files(
    plan: models.RenderPlan, *, bare_names: bool
) -> dict[str, str]:
  """Maps every asset id of a plan to a workspace path or its file name.

  Raises:
    storage.NotFoundError: If an asset is unknown or expired.
  """
  files = {}
  for asset_id in composer.plan_asset_ids(plan):
    asset, path = _workspace.load_asset(asset_id)
    files[asset_id] = asset.filename if bare_names else str(path)
  return files


@app.post('/api/shortform/render')
async def render(body: models.RenderRequest) -> responses.JSONResponse:
  """Renders an edited Scenario from the uploaded Source Video."""
  try:
    source, media_path = _workspace.load_source(body.source_id)
    assets = _asset_files(body.plan, bare_names=False)
  except storage.NotFoundError as exc:
    return _error(str(exc), 404)
  if not source.has_audio:
    return _error('업로드한 원본에 오디오 트랙이 없습니다.', 422)
  render_id, folder = _workspace.new_render()
  output = _workspace.render_output(folder)
  started = time.monotonic()
  try:
    composition = composer.compose(
        body.plan,
        source.media,
        config.RENDER_PROFILES[body.quality],
        composer.RenderPaths(
            ffmpeg_bin=_settings.ffmpeg_bin,
            source=str(media_path),
            output=str(output),
            assets=assets,
        ),
    )
    await asyncio.to_thread(composer.run, composition, folder)
    video_sec, audio_sec = await asyncio.to_thread(
        composer.measure_streams, output
    )
  except composer.CompositionError as exc:
    return _error(str(exc), 422)
  except composer.RenderError as exc:
    return _error(str(exc), 500)
  return responses.JSONResponse(
      models.RenderOutput(
          render_id=render_id,
          video_url=f'/api/shortform/renders/{render_id}',
          planned_duration_sec=round(composition.timeline.duration_sec, 3),
          measured_video_sec=round(video_sec, 3),
          measured_audio_sec=round(audio_sec, 3),
          elapsed_sec=round(time.monotonic() - started, 1),
          ffmpeg_command=shlex.join(composition.args),
          srt=composition.srt,
          ass=composition.ass,
          ass_filename=composer.ASS_FILENAME,
          asset_filenames=[],
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
def render_file(render_id: str) -> fastapi.Response:
  """Serves a rendered MP4 (supports range requests for the player)."""
  try:
    path = _workspace.render_file(render_id)
  except storage.NotFoundError as exc:
    return _error(str(exc), 404)
  return responses.FileResponse(path, media_type='video/mp4')


@app.post('/api/shortform/export')
def export(body: models.ExportRequest) -> responses.JSONResponse:
  """Returns the ffmpeg command and captions to render the edit elsewhere."""
  try:
    assets = _asset_files(body.plan, bare_names=True)
    composition = composer.compose(
        body.plan,
        body.media,
        config.RENDER_PROFILES[body.quality],
        composer.RenderPaths(
            ffmpeg_bin=_EXPORT_FFMPEG,
            source=body.source_filename,
            output=_EXPORT_OUTPUT,
            assets=assets,
            fonts_dir=_EXPORT_FONTS_DIR,
        ),
    )
  except storage.NotFoundError as exc:
    return _error(str(exc), 404)
  except composer.CompositionError as exc:
    return _error(str(exc), 422)
  return responses.JSONResponse(
      models.ExportOutput(
          planned_duration_sec=round(composition.timeline.duration_sec, 3),
          ffmpeg_command=shlex.join(composition.args),
          srt=composition.srt,
          ass=composition.ass,
          ass_filename=composer.ASS_FILENAME,
          asset_filenames=[
              *dict.fromkeys(assets.values()),
              *(
                  f'{_EXPORT_FONTS_DIR}/{name}'
                  for name in composer.plan_font_files(body.plan)
              ),
          ],
      ).to_json()
  )


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
