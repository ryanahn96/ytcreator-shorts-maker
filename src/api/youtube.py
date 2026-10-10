"""YouTube endpoints: channel videos, YouTube Video Context, upload."""

from __future__ import annotations

import fastapi
from fastapi import responses

from src.api import deps
from src.core import models
from src.infra import storage
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
  try:
    result = shorts_upload.upload_short(session.access_token, media_path, body)
  except youtube_common.YouTubeError as exc:
    return deps.error(str(exc), 502)
  return responses.JSONResponse(result.to_json())
