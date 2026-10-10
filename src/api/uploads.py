"""Uploads: the Source Video (direct or through GCS) and Uploaded Assets."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import contextlib
import pathlib
from urllib import parse as urllib_parse

import fastapi
from fastapi import responses
from starlette import requests as starlette_requests

from src.api import deps
from src.core import models
from src.infra import storage
from src.media import ingestion

router = fastapi.APIRouter(prefix='/api/shortform', tags=['uploads'])


def _schedule_purge() -> None:
  """Purges expired local files in the background without blocking uploads."""
  asyncio.create_task(asyncio.to_thread(deps.workspace.purge_expired))


async def _discard(remove: Callable[[str], None], item_id: str) -> None:
  """Removes a failed upload; a bucket error here is not worth reporting."""
  with contextlib.suppress(storage.StorageError):
    await asyncio.to_thread(remove, item_id)


@router.post('/upload-source/init')
async def upload_source_init(
    body: models.UploadInitRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Initializes a direct GCS resumable upload session when configured."""
  await asyncio.to_thread(deps.require_session, request)
  _schedule_purge()
  filename = pathlib.PurePath(body.filename).name or 'source.mp4'
  origin = request.headers.get('origin', '').strip()
  try:
    session = await asyncio.to_thread(
        deps.workspace.init_source_upload,
        filename,
        body.size_bytes,
        body.content_type,
        origin,
    )
  except storage.StorageError as exc:
    return deps.error(f'업로드 세션을 시작하지 못했습니다: {exc}', 500)
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


@router.post('/upload-source/complete')
async def upload_source_complete(
    body: models.UploadCompleteRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Finalizes a direct GCS upload without downloading the full video."""
  await asyncio.to_thread(deps.require_session, request)
  filename = pathlib.PurePath(body.filename).name or 'source.mp4'
  try:
    actual_size = await asyncio.to_thread(
        deps.workspace.verify_source_object, body.source_id, filename
    )
  except storage.StorageError as exc:
    return deps.error(f'업로드된 파일을 확인하지 못했습니다: {exc}', 500)
  if actual_size is None:
    return deps.error('업로드된 원본 파일을 찾을 수 없습니다.', 404)
  if actual_size == 0:
    await _discard(deps.workspace.discard_source, body.source_id)
    return deps.error('빈 파일이 업로드되었습니다.', 422)
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
    await asyncio.to_thread(deps.workspace.save_source_meta, source)
  except (OSError, storage.StorageError) as exc:
    await _discard(deps.workspace.discard_source, body.source_id)
    return deps.error(f'업로드 정보를 저장하지 못했습니다: {exc}', 500)
  return responses.JSONResponse(source.to_json())


@router.post('/upload-source')
async def upload_source(request: fastapi.Request) -> responses.JSONResponse:
  """Stores a raw MP4 body and probes its basic stream metadata."""
  await asyncio.to_thread(deps.require_session, request)
  _schedule_purge()
  filename = urllib_parse.unquote(request.headers.get('x-filename', ''))
  filename = pathlib.PurePath(filename).name or 'source.mp4'
  source_id, path = deps.workspace.new_source(filename)
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
    await asyncio.to_thread(deps.workspace.save_source, source)
  except ingestion.IngestionError as exc:
    await _discard(deps.workspace.discard_source, source_id)
    return deps.error(str(exc), 422)
  except starlette_requests.ClientDisconnect:
    await _discard(deps.workspace.discard_source, source_id)
    return deps.error('업로드가 중단되었습니다.', 400)
  except (OSError, storage.StorageError) as exc:
    await _discard(deps.workspace.discard_source, source_id)
    return deps.error(f'업로드한 파일을 저장하지 못했습니다: {exc}', 500)
  return responses.JSONResponse(source.to_json())


@router.post('/upload-asset')
async def upload_asset(
    request: fastapi.Request, kind: models.AssetKind
) -> responses.JSONResponse:
  """Stores a raw image or audio body for Image Overlays or music."""
  await asyncio.to_thread(deps.require_session, request)
  filename = urllib_parse.unquote(request.headers.get('x-filename', ''))
  filename = pathlib.PurePath(filename).name
  try:
    asset_id, path = deps.workspace.new_asset(kind, filename)
  except ValueError as exc:
    return deps.error(str(exc), 422)
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
    await asyncio.to_thread(deps.workspace.save_asset, asset)
  except ingestion.IngestionError as exc:
    await _discard(deps.workspace.discard_asset, asset_id)
    return deps.error(str(exc), 422)
  except starlette_requests.ClientDisconnect:
    await _discard(deps.workspace.discard_asset, asset_id)
    return deps.error('업로드가 중단되었습니다.', 400)
  except (OSError, storage.StorageError) as exc:
    await _discard(deps.workspace.discard_asset, asset_id)
    return deps.error(f'업로드한 파일을 저장하지 못했습니다: {exc}', 500)
  return responses.JSONResponse(asset.to_json())
