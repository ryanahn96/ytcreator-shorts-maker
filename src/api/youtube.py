"""YouTube endpoints: channel videos, YouTube Video Context, upload."""

from __future__ import annotations

import fastapi
from fastapi import responses

from src.api import deps
from src.core import models
from src.infra import storage
from src.media import ingestion
from src.youtube import common as youtube_common
from src.youtube import shorts_upload
from src.youtube import video_context
from src.youtube import videos

router = fastapi.APIRouter(prefix='/api/shortform/youtube', tags=['youtube'])


@router.get('/videos')
def youtube_videos(request: fastapi.Request) -> responses.JSONResponse:
  """Lists recent uploaded videos from the signed-in creator's channel."""
  session = deps.require_session(request)
  try:
    result = videos.list_channel_videos(session.access_token)
  except youtube_common.YouTubeError as exc:
    return deps.error(str(exc), 502)
  channel_shorts = video_context.fetch_channel_shorts_stats(
      session.access_token
  )
  result = result.model_copy(update={'channel_shorts': channel_shorts})
  return responses.JSONResponse(result.to_json())


@router.get('/videos/{video_id}/context')
def youtube_video_context(
    video_id: str, request: fastapi.Request, duration_sec: float = 0.0
) -> responses.JSONResponse:
  """Fetches Audience Retention curve, peaks and caption status for a video."""
  session = deps.require_session(request)
  vid = video_id.strip()
  if not vid or len(vid) > 64:
    return deps.error('유효하지 않은 YouTube 영상 ID입니다.', 422)
  try:
    ctx = video_context.fetch_video_context(
        session.access_token, vid, duration_sec
    )
  except youtube_common.YouTubeError as exc:
    return deps.error(str(exc), 502)
  return responses.JSONResponse(ctx.to_json())


@router.post('/upload')
def youtube_upload(
    body: models.YouTubeUploadRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Uploads a rendered 1080x1920 Shorts MP4 to the creator's channel."""
  session = deps.require_session(request)
  try:
    media_path = deps.workspace.render_file(body.render_id)
  except storage.NotFoundError as exc:
    return deps.error(str(exc), 404)
  except storage.StorageError as exc:
    return deps.error(str(exc), 500)

  thumb_out = media_path.with_name(f'thumb-{body.render_id}.jpg')
  thumbnail_path = None
  pre_warnings: list[str] = []
  try:
    asset_id = (body.thumbnail_asset_id or '').strip()
    if asset_id:
      try:
        asset, asset_path = deps.workspace.load_asset(asset_id)
        if asset.kind != 'image':
          pre_warnings.append('썸네일 파일은 이미지 형식이어야 합니다.')
        else:
          thumbnail_path = ingestion.prepare_thumbnail_jpeg(
              asset_path, thumb_out
          )
      except (
          storage.NotFoundError,
          storage.StorageError,
          ingestion.IngestionError,
      ) as exc:
        pre_warnings.append(str(exc))
    elif body.thumbnail_time_sec is not None:
      try:
        thumbnail_path = ingestion.extract_frame_jpeg(
            media_path, body.thumbnail_time_sec, thumb_out
        )
      except ingestion.IngestionError as exc:
        pre_warnings.append(str(exc))

    try:
      result = shorts_upload.upload_short(
          session.access_token,
          media_path,
          body,
          thumbnail_path=thumbnail_path,
          pre_warnings=pre_warnings,
      )
    except youtube_common.YouTubeError as exc:
      return deps.error(str(exc), 502)
  finally:
    thumb_out.unlink(missing_ok=True)
  return responses.JSONResponse(result.to_json())

