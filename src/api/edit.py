"""말로 편집 endpoint: answers one Edit Request."""

from __future__ import annotations

import asyncio

import fastapi
from fastapi import responses

from src.api import deps
from src.core import models
from src.edit_agent import agent as edit_agent
from src.gemini import director
from src.infra import storage

router = fastapi.APIRouter(prefix='/api/shortform', tags=['edit'])


# How often an Edit Request checks whether the browser stopped waiting.
_DISCONNECT_POLL_SEC = 0.5


@router.post('/edit')
async def edit(
    body: models.EditRequest, request: fastapi.Request
) -> responses.JSONResponse:
  """Answers one Edit Request (말로 편집) with checked edit operations.

  The stored transcript and the linked YouTube data are read here (ADR
  0011), so the browser only names the Source Video. When the browser stops
  waiting (중단), the Gemini call is cancelled as soon as the disconnect
  reaches the server.
  """
  await asyncio.to_thread(deps.require_session, request)
  try:
    transcript, context = await asyncio.gather(
        asyncio.to_thread(deps.workspace.load_transcript, body.source_id),
        asyncio.to_thread(deps.workspace.load_youtube_context, body.source_id),
    )
  except storage.StorageError as exc:
    return deps.error(f'대본을 읽지 못했습니다: {exc}', 500)
  task = asyncio.create_task(edit_agent.run(body, transcript, context))
  try:
    while not task.done():
      await asyncio.wait({task}, timeout=_DISCONNECT_POLL_SEC)
      if not task.done() and await request.is_disconnected():
        return deps.error('편집 요청을 중단했습니다.', 499)
    result = task.result()
  except director.DirectorError as exc:
    return deps.error(str(exc), 502)
  finally:
    task.cancel()
  return responses.JSONResponse(result.to_json())
