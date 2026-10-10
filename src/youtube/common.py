"""Pieces the YouTube clients share: HTTP client, auth headers, errors."""

from __future__ import annotations

import httpx

YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'


class YouTubeError(RuntimeError):
  """Raised when an OAuth or YouTube API request fails."""


def http_client(timeout_sec: float = 60.0) -> httpx.Client:
  return httpx.Client(timeout=httpx.Timeout(timeout_sec, connect=15.0))


def auth_headers(access_token: str) -> dict[str, str]:
  return {'Authorization': f'Bearer {access_token}'}


def api_error_message(response: httpx.Response, prefix: str) -> str:
  try:
    payload = response.json()
  except ValueError:
    payload = None
  if isinstance(payload, dict):
    err = payload.get('error')
    if isinstance(err, dict) and isinstance(err.get('message'), str):
      return f'{prefix}: {err["message"]} (HTTP {response.status_code})'
    if isinstance(err, str):
      desc = payload.get('error_description')
      detail = f'{err} ({desc})' if isinstance(desc, str) else err
      return f'{prefix}: {detail} (HTTP {response.status_code})'
  return f'{prefix} (HTTP {response.status_code})'


def as_dict(value: object) -> dict[str, object]:
  return value if isinstance(value, dict) else {}


def int_stat(stats: dict[str, object], key: str) -> int:
  try:
    return int(stats.get(key) or 0)
  except (TypeError, ValueError):
    return 0


def thumbnail_url(thumbs: object, sizes: tuple[str, ...]) -> str:
  data = as_dict(thumbs)
  for key in sizes:
    url = as_dict(data.get(key)).get('url')
    if url:
      return str(url).strip()
  return ''
