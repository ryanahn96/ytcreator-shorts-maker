"""Loose readers of Gemini's answer to an Edit Request (untrusted input).

Also the limits and labels that the checker, the style patcher and the
prompt share.
"""

from __future__ import annotations

from collections.abc import Iterable
import math
import string
from typing import Any

from src.core import fonts
from src.core import models
from src.gemini import director

# The longest text one operation may set.
MAX_TEXT_CHARS = 500
# Korean names of the uploaded file kinds, for notes and the
# request text.
KIND_LABELS = {'image': '이미지', 'audio': '음악', 'video': '영상'}


def read_number(value: Any) -> float | None:
  """Reads a finite number, also from a numeric string."""
  if isinstance(value, str):
    value = value.strip().removesuffix('%')
  number = director.as_float(value)
  return number if number is not None and math.isfinite(number) else None


def read_fraction(value: Any) -> float | None:
  """Reads a 0..1 ratio; '%'-suffixed strings or whole 2..100 count as %."""
  number = read_number(value)
  if number is None:
    return None
  if isinstance(value, str) and value.strip().endswith('%'):
    return number / 100.0
  if 1.0 < number <= 100.0 and abs(number - round(number)) <= 1e-6:
    return number / 100.0
  return number


def read_integer(value: Any) -> int | None:
  """Reads a whole number; 3.0 counts, 3.5 does not."""
  number = read_number(value)
  if number is None or abs(number - round(number)) > 1e-6:
    return None
  return round(number)


def read_seconds(value: Any) -> float | None:
  """Reads seconds: a number, "75.2s", "01:15.2" or "1:01:15"."""
  if isinstance(value, str) and ':' in value:
    sign = -1.0 if value.strip().startswith('-') else 1.0
    parts = value.strip().lstrip('+-').removesuffix('s').split(':')
    numbers = [read_number(part) for part in parts]
    if len(numbers) not in (2, 3) or any(part is None for part in numbers):
      return None
    total = 0.0
    for part in numbers:
      total = total * 60.0 + (part or 0.0)
    return sign * total
  if isinstance(value, str):
    value = value.strip().removesuffix('s').removesuffix('초')
  return read_number(value)


def clamp(value: float, low: float, high: float) -> float:
  return min(max(value, low), high)


def ms(seconds: float) -> float:
  return round(seconds, 3)


def half_up(value: float) -> int:
  """Rounds .5 away from zero, as people do (Python's round() does not)."""
  return math.floor(abs(value) + 0.5) * (1 if value >= 0 else -1)


def read_hex_color(value: Any) -> str | None:
  """Returns '#RRGGBB' for '#RRGGBB', '#RGB' or the digits alone."""
  if not isinstance(value, str):
    return None
  digits = value.strip().removeprefix('#')
  if len(digits) == 3:
    digits = ''.join(char * 2 for char in digits)
  if len(digits) != 6 or any(char not in string.hexdigits for char in digits):
    return None
  return '#' + digits.upper()


def read_font_id(value: Any) -> str | None:
  """Maps a font id, label or family (or a unique part of one) to its id."""
  key = director.clean_text(value).casefold()
  if not key:
    return None
  for font in fonts.FONTS:
    names = (font.font_id, font.label, font.family)
    if key in (name.casefold() for name in names):
      return font.font_id
  matches = [
      font.font_id
      for font in fonts.FONTS
      if key in font.label.casefold() or key in font.family.casefold()
  ]
  return matches[0] if len(matches) == 1 else None


def find_file(
    name: str, assets: Iterable[models.UploadedAsset]
) -> models.UploadedAsset | None:
  """Finds an uploaded file by name, then case, stem or a unique part."""
  candidates = list(assets)[::-1]  # The newest upload wins a tie.
  key = name.strip().casefold()

  def stem(filename: str) -> str:
    return filename.rsplit('.', 1)[0].casefold()

  for matches in (
      lambda asset: asset.filename == name.strip(),
      lambda asset: asset.filename.casefold() == key,
      lambda asset: stem(asset.filename) == stem(key),
  ):
    found = [asset for asset in candidates if matches(asset)]
    if found:
      return found[0]
  partial = [
      asset
      for asset in candidates
      if key in asset.filename.casefold() or stem(asset.filename) in key
  ]
  return partial[0] if len(partial) == 1 else None
