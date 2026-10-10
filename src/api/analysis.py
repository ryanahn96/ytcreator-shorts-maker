"""Analysis endpoint: streams one Analysis as NDJSON events."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import json
from typing import Any

import fastapi
from fastapi import responses

from src.api import deps
from src.core import models
from src.gemini import director
from src.infra import storage
from src.media import ingestion

router = fastapi.APIRouter(prefix='/api/shortform', tags=['analysis'])


def _ndjson(event: dict[str, Any]) -> bytes:
  return (json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8')


async def _analysis_events(
    request: models.AnalyzeRequest,
    access_token: str,
) -> AsyncIterator[bytes]:
  """Runs the analysis and yields NDJSON progress, then result or error."""
  queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

  async def work() -> None:
    try:
      source, media_path = await asyncio.to_thread(
          deps.workspace.load_source, request.source_id
      )
      upload = director.UploadedVideo(source=source, media_path=media_path)
      result = await director.analyze(
          request, upload, deps.workspace, queue.put, access_token=access_token
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
            queue.get(), timeout=deps.settings.heartbeat_sec
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


@router.post('/analyze')
async def analyze(
    body: models.AnalyzeRequest, request: fastapi.Request
) -> responses.StreamingResponse:
  """Streams the agentic analysis of a Source Video as NDJSON events."""
  session = await asyncio.to_thread(deps.require_session, request)
  return responses.StreamingResponse(
      _analysis_events(body, session.access_token),
      media_type='application/x-ndjson',
      headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
  )
