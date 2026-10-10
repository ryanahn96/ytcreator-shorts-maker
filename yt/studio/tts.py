"""Gemini TTS for 말로 편집: reads an answer aloud (ADR 0012).

The browser applies an answer and shows its text first, then asks for the
spoken version here in parallel, so a slow or failed call never holds back
the edit. The text is read as given: the Edit Agent already wrote it to be
heard (EditResponse.speech plus the notes), so nothing is rewritten here.
"""

from __future__ import annotations

from google.auth import exceptions as google_auth_exceptions
from google.genai import errors as genai_errors
from google.genai import types
import httpx
import pydantic

from yt.studio import config
from yt.studio import gemini
from yt.studio import models

# The light model is the fast default; the full model stands in when the
# light one fails. Both detect Korean from the text.
MODELS = ('gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts')
VOICE = 'Kore'
MAX_CHARS = 1000
# One answer takes a few seconds; a stuck call should not hold the voice.
_TIMEOUT_MS = 60_000
_PREVIEW_CHARS = 200

_CONFIG = types.GenerateContentConfig(
    response_modalities=['AUDIO'],
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE)
        )
    ),
    http_options=types.HttpOptions(timeout=_TIMEOUT_MS),
)


class TtsError(Exception):
  """Raised when no TTS model returned audio."""


class SpeakRequest(models.StudioModel):
  """Request body of the TTS endpoint: the words to say."""

  text: str = pydantic.Field(min_length=1, max_length=MAX_CHARS)


async def synthesize(text: str) -> tuple[bytes, str]:
  """Reads text aloud with the first TTS model that returns audio.

  Args:
    text: What to say, read verbatim.

  Returns:
    The audio and its MIME type (a WAV file from the 3.8 TTS models).

  Raises:
    TtsError: If Gemini is not set up or no model returned audio.
  """
  settings = config.get_settings()
  if settings.gemini_setup_error:
    raise TtsError(settings.gemini_setup_error)
  client = gemini.make_client(settings)
  failures: list[str] = []
  for model in MODELS:
    try:
      response = await client.aio.models.generate_content(
          model=model, contents=text, config=_CONFIG
      )
    except google_auth_exceptions.GoogleAuthError as exc:
      # Credentials fail the same way for every model.
      raise TtsError(gemini.auth_failure_message(settings, exc)) from exc
    except (genai_errors.APIError, httpx.HTTPError, TimeoutError) as exc:
      failures.append(f'{model}: {str(exc)[:_PREVIEW_CHARS]}')
      continue
    candidate = response.candidates[0] if response.candidates else None
    parts = candidate.content.parts if candidate and candidate.content else None
    for part in parts or []:
      if part.inline_data is not None and part.inline_data.data:
        audio = part.inline_data
        return audio.data, audio.mime_type or 'audio/wav'
    failures.append(f'{model}: 응답에 오디오가 없습니다.')
  raise TtsError(
      f'음성을 만들지 못했습니다({gemini.label(settings)}).\n'
      + '\n'.join(f'- {failure}' for failure in failures)
  )
