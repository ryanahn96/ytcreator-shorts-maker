"""Studio status and setup: health, the config the UI loads, font files."""

from __future__ import annotations

from typing import Any

import fastapi
from fastapi import responses

from src.api import deps
from src.core import config
from src.core import fonts
from src.core import models
from src.gemini import client as gemini_client
from src.prompts import analysis as analysis_prompt
from src.render import layout
from src.youtube import oauth

router = fastapi.APIRouter(prefix='/api', tags=['studio'])


@router.get('/health')
def health() -> dict[str, Any]:
  """Liveness probe used by the Vite dev server before spawning us."""
  return {
      'status': 'ok',
      'geminiBackend': deps.settings.gemini_backend,
      'geminiConfigured': not deps.settings.gemini_setup_error,
      'oauthConfigured': not deps.settings.oauth_setup_error,
      'storage': deps.workspace.bucket_name or 'local',
  }


@router.get('/shortform/config')
def studio_config(request: fastapi.Request) -> dict[str, Any]:
  """Returns the default Editorial Prompt, editor defaults and auth status.

  The Gemini setup error also covers Vertex AI credentials that need a new
  login, so the UI can say so before an analysis starts. FastAPI runs this
  sync handler in a worker thread, which keeps the token request off the
  event loop.
  """
  setup_error = (
      deps.settings.gemini_setup_error
      or gemini_client.credentials_error(deps.settings)
  )
  session = deps.current_session(request)
  return models.StudioConfig(
      default_editorial_prompt=analysis_prompt.DEFAULT_EDITORIAL_PROMPT,
      composition=config.COMPOSITION,
      template_style=deps.settings.template_style,
      default_text_layouts=layout.default_text_layouts(
          deps.settings.template_style
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
      font_warning=deps.settings.font_warning,
      gemini_setup_error=setup_error,
      auth=oauth.auth_status(deps.settings, session),
  ).to_json()


@router.get('/shortform/fonts/{font_id}', response_model=None)
def font_file(font_id: str) -> fastapi.Response:
  """Serves a bundled font file so the preview draws with the render's fonts."""
  try:
    font = fonts.get(font_id)
  except KeyError:
    return deps.error(f'알 수 없는 글꼴입니다: {font_id}', 404)
  path = fonts.path(font)
  if not path.is_file():
    return deps.error(f'글꼴 파일이 없습니다: {font.filename}', 404)
  return responses.FileResponse(
      path, headers={'Cache-Control': 'public, max-age=86400'}
  )
