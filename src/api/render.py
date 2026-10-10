"""Render endpoints: MP4 만들기 and the rendered files."""

from __future__ import annotations

import asyncio

import fastapi
from fastapi import responses

from src.api import deps
from src.core import config
from src.core import models
from src.infra import storage
from src.media import ingestion
from src.render import composer

router = fastapi.APIRouter(prefix='/api/shortform', tags=['render'])


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
    asset, path = deps.workspace.load_asset(asset_id)
    files[asset_id] = str(path)
    meta[asset_id] = asset
  return files, meta


@router.post('/render')
async def render(
    body: models.RenderRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Renders an edited Scenario from the uploaded Source Video."""
  await asyncio.to_thread(deps.require_session, request)
  try:
    source, media_path = await asyncio.to_thread(
        deps.workspace.load_source, body.source_id
    )
    if source.media.width <= 2 or source.media.height <= 2:
      probed_media, probed_audio = await asyncio.to_thread(
          ingestion.probe_media, str(media_path)
      )
      source = source.model_copy(
          update={'media': probed_media, 'has_audio': probed_audio}
      )
      await asyncio.to_thread(deps.workspace.save_source_meta, source)
    assets, asset_meta = await asyncio.to_thread(_asset_files, body.plan)
  except storage.NotFoundError as exc:
    return deps.error(str(exc), 404)
  except (ingestion.IngestionError, storage.StorageError) as exc:
    return deps.error(str(exc), 500)
  if not source.has_audio:
    return deps.error('업로드한 원본에 오디오 트랙이 없습니다.', 422)
  profile = config.RENDER_PROFILES[body.quality]
  render_id, output = deps.workspace.new_render()
  try:
    composition = composer.compose(
        body.plan,
        source.media,
        profile,
        composer.RenderPaths(
            ffmpeg_bin=deps.settings.ffmpeg_bin,
            source=str(media_path),
            output=str(output),
            assets=assets,
            asset_meta=asset_meta,
        ),
    )
    await asyncio.to_thread(composer.run, composition, output.parent)
    video_sec, audio_sec = await asyncio.to_thread(
        composer.measure_streams, output
    )
    await asyncio.to_thread(deps.workspace.save_render, render_id)
  except composer.CompositionError as exc:
    return deps.error(str(exc), 422)
  except (composer.RenderError, storage.StorageError) as exc:
    return deps.error(str(exc), 500)
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


@router.get('/renders/{render_id}', response_model=None)
def render_file(render_id: str, request: fastapi.Request) -> fastapi.Response:
  """Serves a rendered MP4 (supports range requests for the player).

  A sync handler, so fetching the file from the bucket (when another
  instance rendered it) runs in FastAPI's worker thread.
  """
  deps.require_session(request)
  try:
    path = deps.workspace.render_file(render_id)
  except storage.NotFoundError as exc:
    return deps.error(str(exc), 404)
  except storage.StorageError as exc:
    return deps.error(str(exc), 500)
  return responses.FileResponse(path, media_type='video/mp4')
