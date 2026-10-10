"""The fonts a Look can use for its Headline and captions.

The font files ship in src/render/fonts (SIL Open Font License, texts in
fonts/licenses). ffmpeg's subtitles filter loads them through `fontsdir`
and the browser loads the same files through the fonts route, so the
preview draws with exactly the fonts the render burns in.

libass sizes a font so that one line box (usWinAscent + usWinDescent)
equals the ASS font size, while CSS sizes the em. em_per_line_box reads
both numbers from the font file, and the preview multiplies ASS sizes by
it.
"""

from __future__ import annotations

import dataclasses
import functools
import pathlib
import struct

FONT_DIR = pathlib.Path(__file__).resolve().parent / 'fonts'
DEFAULT_HEADLINE_FONT = 'noto-sans-kr'
DEFAULT_CAPTION_FONT = 'noto-sans-kr'

# Byte offsets inside the sfnt tables that em_per_line_box reads.
_TABLE_RECORD = struct.Struct('>4sIII')
_HEAD_UNITS_PER_EM = 18
_OS2_WIN_ASCENT = 74
_HHEA_ASCENDER = 4


@dataclasses.dataclass(frozen=True)
class FontFace:
  """One selectable font file.

  Attributes:
    font_id: Stable id stored in Looks.
    label: Name shown in the UI.
    family: Family name inside the file; the ASS file asks for it.
    filename: File name inside FONT_DIR.
    bold: Whether the file is a bold face. ASS asks for the same weight so
      libass neither swaps the face nor fakes bold.
  """

  font_id: str
  label: str
  family: str
  filename: str
  bold: bool


FONTS: tuple[FontFace, ...] = (
    FontFace('noto-sans-kr', '본고딕 (Noto Sans KR) Bold', 'Noto Sans KR',
             'NotoSansKR-Bold.otf', True),
    FontFace('noto-serif-kr', '본명조 (Noto Serif KR) Bold', 'Noto Serif KR',
             'NotoSerifKR-Bold.otf', True),
    FontFace('black-han-sans', '검은고딕', 'Black Han Sans',
             'BlackHanSans-Regular.ttf', False),
    FontFace('do-hyeon', '도현', 'Do Hyeon', 'DoHyeon-Regular.ttf', False),
    FontFace('jua', '주아', 'Jua', 'Jua-Regular.ttf', False),
    FontFace('nanum-gothic', '나눔고딕 ExtraBold', 'NanumGothicExtraBold',
             'NanumGothic-ExtraBold.ttf', True),
    FontFace('nanum-myeongjo', '나눔명조 Bold', 'NanumMyeongjo',
             'NanumMyeongjo-Bold.ttf', True),
    FontFace('gowun-dodum', '고운돋움', 'Gowun Dodum',
             'GowunDodum-Regular.ttf', False),
    FontFace('nanum-pen', '나눔손글씨 펜', 'Nanum Pen',
             'NanumPenScript-Regular.ttf', False),
    FontFace('nanum-brush', '나눔손글씨 붓', 'Nanum Brush Script',
             'NanumBrushScript-Regular.ttf', False),
)

_BY_ID = {font.font_id: font for font in FONTS}


def font_ids() -> list[str]:
  """Returns every font id in display order."""
  return [font.font_id for font in FONTS]


def get(font_id: str) -> FontFace:
  """Returns the font with this id.

  Raises:
    KeyError: If no font has this id.
  """
  return _BY_ID[font_id]


def path(font: FontFace) -> pathlib.Path:
  """Returns the file of a font."""
  return FONT_DIR / font.filename


def missing() -> list[str]:
  """Returns the file names of fonts whose files are not installed."""
  return [font.filename for font in FONTS if not path(font).is_file()]


def _tables(data: bytes) -> dict[bytes, int]:
  """Returns the offset of every table of an sfnt file."""
  (count,) = struct.unpack_from('>H', data, 4)
  tables = {}
  for index in range(count):
    tag, _, offset, _ = _TABLE_RECORD.unpack_from(data, 12 + 16 * index)
    tables[tag] = offset
  return tables


@functools.cache
def em_per_line_box(font_id: str) -> float:
  """Returns em size / libass line box of a font, from its file.

  libass uses usWinAscent + usWinDescent (OS/2) as the line box when they
  are set, and the hhea ascender and descender otherwise.

  Args:
    font_id: Id of an installed font.

  Returns:
    The factor that turns an ASS font size into a CSS font-size; 1.0 when
    the file is missing.
  """
  font_path = path(get(font_id))
  if not font_path.is_file():
    return 1.0
  data = font_path.read_bytes()
  tables = _tables(data)
  (units_per_em,) = struct.unpack_from(
      '>H', data, tables[b'head'] + _HEAD_UNITS_PER_EM
  )
  line_box = 0
  if b'OS/2' in tables:
    ascent, descent = struct.unpack_from(
        '>hh', data, tables[b'OS/2'] + _OS2_WIN_ASCENT
    )
    line_box = ascent + descent
  if line_box <= 0:
    ascender, descender = struct.unpack_from(
        '>hh', data, tables[b'hhea'] + _HHEA_ASCENDER
    )
    line_box = ascender - descender
  return units_per_em / line_box if line_box > 0 else 1.0
