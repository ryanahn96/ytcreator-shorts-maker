"""Environment-driven settings and tunable defaults of the studio.

Every number that shapes an edit lives here (or is sent to the UI through
StudioConfig) instead of being scattered through the pipeline code.
"""

from __future__ import annotations

import dataclasses
import functools
import os
import pathlib
import shutil
import tempfile

import dotenv

from src.core import fonts
from src.core import models

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
dotenv.load_dotenv(REPO_ROOT / '.env', override=False)

# Models that support MediaProcessing.AGENTIC, tried in order on failure.
DEFAULT_MODEL_CHAIN = (
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
)
# Vertex AI location used when GOOGLE_CLOUD_LOCATION is unset. The newest
# Gemini models are served from the global endpoint.
DEFAULT_VERTEX_LOCATION = 'global'
_TRUE_VALUES = frozenset({'1', 'true', 'yes', 'on'})

# Editor defaults sent to the UI. The first five are user adjustable.
COMPOSITION = models.CompositionSettings(
    silence_threshold_sec=0.25,
    cut_margin_sec=0.08,
    min_subcut_sec=0.12,
    caption_max_chars=22,
    caption_max_gap_sec=0.6,
    new_clip_sec=6.0,
    edit_window_pad_sec=8.0,
    nudge_steps_sec=[0.1, 0.5],
    default_music_volume=0.25,
    music_fade_out_sec=1.5,
    default_image_width_ratio=0.3,
)

# Output presets of "MP4 만들기" (9:16 vertical short).
# In 'box' mode on a 1080x1920 canvas, a 16:9 box is only 1048x588 (588p).
# Rendering at 1440x2560 (QHD, box 1396x786) or 2160x3840 (4K UHD, box
# 2096x1178) preserves the horizontal detail of 1080p/4K source videos, and
# crf 14-15 prevents bitrate starvation on the surrounding dark canvas.
RENDER_PROFILES: dict[models.RenderQuality, models.RenderProfile] = {
    '1080p': models.RenderProfile(
        width=1080,
        height=1920,
        x264_preset='fast',
        crf=14,
        audio_bitrate='256k',
    ),
    '1440p': models.RenderProfile(
        width=1440,
        height=2560,
        x264_preset='faster',
        crf=14,
        audio_bitrate='256k',
    ),
    '2160p': models.RenderProfile(
        width=2160,
        height=3840,
        x264_preset='veryfast',
        crf=15,
        audio_bitrate='320k',
    ),
}

# Short fade on both edges of every audio Subcut so joins do not click.
AUDIO_FADE_SEC = 0.01


@dataclasses.dataclass(frozen=True)
class Settings:
  """Process-wide settings resolved from the environment."""

  gemini_backend: models.GeminiBackend
  gemini_api_key: str
  vertex_project: str
  vertex_location: str
  # Non-empty when Gemini cannot be called; says what to configure.
  gemini_setup_error: str
  model_chain: tuple[str, ...]
  gemini_timeout_sec: float
  gemini_attempts_per_model: int
  gemini_retry_delay_sec: float
  heartbeat_sec: float
  workdir: pathlib.Path
  retention_hours: float
  # Cloud Storage bucket that mirrors the Workspace (uploads, proxies,
  # transcripts, renders). Empty keeps everything on the local disk only.
  gcs_bucket: str
  ffmpeg_bin: str
  ffprobe_bin: str
  subprocess_timeout_sec: float
  silence_noise_db: float
  silence_min_sec: float
  # Uploaded Source Videos are sent to Gemini inline as a small proxy.
  analysis_proxy_height: int
  analysis_proxy_fps: float
  max_inline_video_bytes: int
  # How long the Gemini Context Cache of an analysis proxy lives.
  context_cache_ttl_sec: int
  # Google Cloud Speech-to-Text V2 (chirp_3 in the us multi-region).
  speech_project: str
  speech_location: str
  speech_model: str
  speech_languages: tuple[str, ...]
  # Google / YouTube OAuth 2.0 Web Client credentials.
  oauth_client_id: str
  oauth_client_secret: str
  oauth_setup_error: str
  template_style: models.TemplateStyle
  font_warning: str
  backend_port: int
  dist_dir: pathlib.Path


def _env_str(name: str, default: str) -> str:
  return os.environ.get(name, '').strip() or default


def _env_float(name: str, default: float) -> float:
  raw = os.environ.get(name, '').strip()
  if not raw:
    return default
  try:
    return float(raw)
  except ValueError:
    return default


def _env_list(name: str) -> tuple[str, ...]:
  raw = os.environ.get(name, '')
  return tuple(item.strip() for item in raw.split(',') if item.strip())


def _env_flag(name: str) -> bool:
  return os.environ.get(name, '').strip().lower() in _TRUE_VALUES


def _gemini_backend() -> models.GeminiBackend:
  # The google-genai SDK's own switch, so an existing .env keeps its meaning.
  return 'vertex' if _env_flag('GOOGLE_GENAI_USE_VERTEXAI') else 'ai_studio'


def _gemini_setup_error(
    backend: models.GeminiBackend, api_key: str, project: str
) -> str:
  """Returns what must be configured before Gemini can be called."""
  if backend == 'vertex' and not project:
    return (
        'GOOGLE_GENAI_USE_VERTEXAI=true인데 GOOGLE_CLOUD_PROJECT가 없습니다. '
        '.env에 프로젝트 ID를 넣고 서버를 다시 시작하세요.'
    )
  if backend == 'ai_studio' and not api_key:
    return (
        'GEMINI_API_KEY가 없습니다. .env에 API 키를 넣거나 '
        'GOOGLE_GENAI_USE_VERTEXAI=true와 GOOGLE_CLOUD_PROJECT로 Vertex AI를 '
        '설정한 뒤 서버를 다시 시작하세요.'
    )
  return ''


def _oauth_setup_error(client_id: str, client_secret: str) -> str:
  """Returns what must be configured before Google / YouTube OAuth works."""
  if client_id and client_secret:
    return ''
  return (
      'GOOGLE_OAUTH_CLIENT_ID와 GOOGLE_OAUTH_CLIENT_SECRET이 설정되지 '
      '않았습니다. Google Cloud Console > APIs & Services > Credentials에서 '
      'OAuth 2.0 웹 클라이언트를 만들고 승인된 리디렉션 URI에 '
      '<사이트 주소>/api/shortform/auth/callback을 추가한 뒤 .env에 값을 '
      '넣고 서버를 다시 시작하세요.'
  )


def _model_chain() -> tuple[str, ...]:
  primary = _env_str(
      'GEMINI_SHORTFORM_MODEL', _env_str('GEMINI_MODEL', DEFAULT_MODEL_CHAIN[0])
  )
  fallbacks = _env_list('GEMINI_FALLBACK_MODELS') or DEFAULT_MODEL_CHAIN
  return tuple(dict.fromkeys((primary, *fallbacks)))


def _font_warning() -> str:
  """Returns a warning when bundled font files are missing, else ''."""
  lost = fonts.missing()
  if not lost:
    return ''
  return (
      f'글꼴 파일 {", ".join(lost)}이(가) src/core/fonts에 없어 그 글꼴을 '
      '고른 헤드라인·자막은 다른 글꼴로 렌더됩니다.'
  )


def default_look_style() -> models.LookStyle:
  """Returns the colors and fonts of a new Look (the sample short's)."""
  return models.LookStyle(
      background_color='#000000',
      border=False,
      border_color='#FFFFFF',
      border_width=6,
      headline=models.HeadlineStyle(
          font_id=fonts.DEFAULT_HEADLINE_FONT,
          size=84,
          color='#FFFFFF',
          accent_color='#3DDC4A',
          outline_color='#000000',
          outline_width=2,
      ),
      caption=models.TextStyle(
          font_id=fonts.DEFAULT_CAPTION_FONT,
          size=44,
          color='#F2E35A',
          outline_color='#000000',
          outline_width=3,
      ),
  )


@functools.cache
def get_settings() -> Settings:
  """Returns the process settings, resolved once."""
  backend = _gemini_backend()
  api_key = os.environ.get('GEMINI_API_KEY', '').strip()
  project = os.environ.get('GOOGLE_CLOUD_PROJECT', '').strip()
  oauth_client_id = _env_str('GOOGLE_OAUTH_CLIENT_ID', '')
  oauth_client_secret = _env_str('GOOGLE_OAUTH_CLIENT_SECRET', '')
  return Settings(
      gemini_backend=backend,
      gemini_api_key=api_key,
      vertex_project=project,
      vertex_location=_env_str(
          'GOOGLE_CLOUD_LOCATION', DEFAULT_VERTEX_LOCATION
      ),
      gemini_setup_error=_gemini_setup_error(backend, api_key, project),
      model_chain=_model_chain(),
      gemini_timeout_sec=_env_float('GEMINI_TIMEOUT_SEC', 600.0),
      gemini_attempts_per_model=int(_env_float('GEMINI_ATTEMPTS_PER_MODEL', 2)),
      gemini_retry_delay_sec=_env_float('GEMINI_RETRY_DELAY_SEC', 3.0),
      heartbeat_sec=_env_float('STUDIO_HEARTBEAT_SEC', 5.0),
      workdir=pathlib.Path(
          _env_str(
              'STUDIO_WORKDIR',
              os.path.join(tempfile.gettempdir(), 'ytcreator-studio'),
          )
      ),
      retention_hours=_env_float('STUDIO_RETENTION_HOURS', 24.0),
      gcs_bucket=_env_str('STUDIO_GCS_BUCKET', ''),
      ffmpeg_bin=_env_str('FFMPEG_BIN', shutil.which('ffmpeg') or 'ffmpeg'),
      ffprobe_bin=_env_str('FFPROBE_BIN', shutil.which('ffprobe') or 'ffprobe'),
      subprocess_timeout_sec=_env_float('STUDIO_SUBPROCESS_TIMEOUT_SEC', 900.0),
      silence_noise_db=_env_float('STUDIO_SILENCE_NOISE_DB', -35.0),
      silence_min_sec=_env_float('STUDIO_SILENCE_MIN_SEC', 0.1),
      analysis_proxy_height=int(
          _env_float('STUDIO_ANALYSIS_PROXY_HEIGHT', 360)
      ),
      analysis_proxy_fps=_env_float('STUDIO_ANALYSIS_PROXY_FPS', 10.0),
      # The inline request limit of generateContent on both backends.
      max_inline_video_bytes=int(
          _env_float('STUDIO_MAX_INLINE_VIDEO_MB', 100.0) * 1024 * 1024
      ),
      context_cache_ttl_sec=int(
          _env_float('STUDIO_CONTEXT_CACHE_TTL_SEC', 3600)
      ),
      speech_project=_env_str('STUDIO_SPEECH_PROJECT', project),
      speech_location=_env_str('STUDIO_SPEECH_LOCATION', 'us'),
      speech_model=_env_str('STUDIO_SPEECH_MODEL', 'chirp_3'),
      speech_languages=_env_list('STUDIO_SPEECH_LANGUAGES') or ('auto',),
      oauth_client_id=oauth_client_id,
      oauth_client_secret=oauth_client_secret,
      oauth_setup_error=_oauth_setup_error(
          oauth_client_id, oauth_client_secret
      ),
      template_style=models.TemplateStyle(
          canvas_width=1080,
          canvas_height=1920,
          box_side_margin=16,
          box_aspect_ratio=16 / 9,
          box_center_y=960,
          headline_line_gap=16,
          headline_gap=60,
          text_box_padding=12,
          caption_gap=104,
          caption_side_padding=40,
          full_headline_y=480,
          full_caption_y=1480,
      ),
      backend_port=int(
          _env_float('BACKEND_PORT', _env_float('PORT', 5000.0))
      ),
      font_warning=_font_warning(),
      dist_dir=REPO_ROOT / 'frontend' / 'dist',
  )
