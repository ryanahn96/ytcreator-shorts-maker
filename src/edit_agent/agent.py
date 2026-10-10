"""말로 편집 (Edit Agent): turns one Edit Request into edit operations.

One Edit Request is one Gemini call with structured output and LOW
thinking (ADR 0011). The browser sends the Shorts on screen, the selected
Clip, the playhead and the conversation of this editor session; the server
adds the stored full transcript with word numbers, the audience data, the
uploaded files and the bundled fonts (src/prompts/edit_agent.py). Gemini
answers with a list of edit operations and a one-line reply, and
checker.check_answer validates every operation against the state that was
sent and the limits of the render models: out-of-range values move to the
nearest allowed value, operations it does not know are dropped, and what it
changed or skipped is reported as Korean notes. The browser then applies
the operations as one undo step (frontend/src/lib/editAgent.ts).

Clips are named by their Clip Number on screen when the request was sent;
the browser maps those numbers back to Clip ids, so this module never needs
ids and keeps no editor state.
"""

from __future__ import annotations

import dataclasses
from typing import Any, ClassVar

from google.genai import types

from src.core import config
from src.core import models
from src.edit_agent import checker
from src.edit_agent import schema
from src.gemini import client as gemini_client
from src.gemini import director
from src.prompts import edit_agent as edit_agent_prompt

# On 25 test requests (2026-10-09) LOW thinking gave the same verdicts as
# the model default at a median 3.3 s instead of 7.6 s per answer.
_THINKING = types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)


@dataclasses.dataclass(frozen=True)
class _EditJob:
  """What one Edit Request asks Gemini for (director.GeminiJob)."""

  request: models.EditRequest
  transcript: models.StoredTranscript | None
  context: models.YouTubeVideoContext | None
  # Text only: an Edit Request never sends the video.
  video: ClassVar[types.Part | None] = None
  system_instruction: ClassVar[str] = edit_agent_prompt.SYSTEM_INSTRUCTION

  def schema(self) -> dict[str, Any]:
    return schema.response_schema()

  def request_text(self, inline_schema: dict[str, Any] | None) -> str:
    return edit_agent_prompt.build_request_text(
        self.request, self.transcript, self.context, inline_schema
    )


async def _ignore(unused_event: dict[str, Any]) -> None:
  """Drops progress events; an Edit Request has no progress stream."""


async def run(
    request: models.EditRequest,
    transcript: models.StoredTranscript | None,
    context: models.YouTubeVideoContext | None,
) -> models.EditResponse:
  """Answers one Edit Request with checked edit operations.

  The call uses the analysis model chain with its retries and fallbacks,
  text only, with LOW thinking.

  Args:
    request: The Edit Request with the state it was sent from.
    transcript: The stored full transcript of the Source Video, if any.
    context: The linked YouTube data, if any.

  Returns:
    The checked operations, the reply and notes.

  Raises:
    director.DirectorError: If Gemini is not set up or every call fails.
  """
  settings = config.get_settings()
  if settings.gemini_setup_error:
    raise director.DirectorError(settings.gemini_setup_error)
  client = gemini_client.make_client(settings)
  job = _EditJob(request=request, transcript=transcript, context=context)
  answer = await director.run_gemini(
      client, job, None, _ignore, thinking=_THINKING
  )
  return checker.check_answer(answer.data, request, transcript)
