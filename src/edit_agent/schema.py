"""The response schema of an Edit Request: edit operations, then the reply."""

from __future__ import annotations

from typing import Any

from src.core import fonts
from src.edit_agent import checker

def _properties(**properties: dict[str, Any]) -> dict[str, Any]:
  """An object schema whose properties are all optional, kept in order.

  Without propertyOrdering the API decodes the keys of an object in
  alphabetical order (required keys first). A model that writes the
  fields in the order it was told, e.g. patchLook's target and then look,
  could then not write look at all, since it sorts before target.

  Args:
    **properties: The property schemas, in the order to write them.

  Returns:
    The object schema.
  """
  return {
      'type': 'object',
      'properties': properties,
      'propertyOrdering': list(properties),
  }


def _look_patch_schema() -> dict[str, Any]:
  """The schema of patchLook's look, in the key order of Look.to_json.

  The prompt shows every Look as Look.to_json, so the model meets the keys
  in that order before it writes a patch.
  """
  number = {'type': 'number'}
  integer = {'type': 'integer'}
  color = {'type': 'string', 'description': '#RRGGBB'}
  text_style = {
      'fontId': {'type': 'string', 'enum': fonts.font_ids()},
      'size': integer,
      'color': color,
      'outlineColor': color,
      'outlineWidth': integer,
      'background': {'type': 'boolean'},
      'backgroundColor': color,
      'backgroundOpacity': number,
  }
  placement = _properties(x=number, y=number)
  return _properties(
      headline=_properties(
          lines={'type': 'array', 'items': {'type': 'string'}}
      ),
      framingLayout=_properties(
          crop=_properties(centerX=number, centerY=number, zoom=number),
          fit={'type': 'string', 'enum': ['box', 'full']},
          box=_properties(x=number, y=number, width=number, height=number),
          defaultBox={'type': 'boolean'},
      ),
      textLayout=_properties(headline=placement, caption=placement),
      style=_properties(
          backgroundColor=color,
          border={'type': 'boolean'},
          borderColor=color,
          borderWidth=integer,
          headline=_properties(**text_style, accentColor=color),
          caption=_properties(**text_style),
      ),
  )


def response_schema() -> dict[str, Any]:
  """Returns the JSON Schema of the answer to an Edit Request.

  Every operation is one flat object: op names it, and only the fields
  that operation uses are filled in (see SYSTEM_INSTRUCTION). The fields
  are declared in one order that agrees with every field list of the
  instruction, and the decoder keeps it (see _properties). operations
  comes before reply so the reply is written after the edits.
  """
  number = {'type': 'number'}
  integer = {'type': 'integer'}
  operation = _properties(
      op={'type': 'string', 'enum': list(checker.Checker.OPS)},
      file={'type': 'string'},
      imageId={'type': 'string'},
      target={'type': 'string', 'enum': list(checker.TARGETS)},
      clip={'type': 'integer', 'description': '요청을 보낸 순간의 클립 번호'},
      edge={'type': 'string', 'enum': list(checker.EDGES)},
      word=integer,
      startWord=integer,
      endWord=integer,
      text={'type': 'string'},
      words={'type': 'array', 'items': integer},
      atSec=number,
      deltaSec=number,
      durationSec=number,
      startSec=number,
      endSec=number,
      place={'type': 'string', 'enum': list(checker.PLACES)},
      otherClip=integer,
      mute={'type': 'boolean'},
      own={'type': 'boolean'},
      volume=number,
      maxChars=integer,
      x=number,
      y=number,
      width=number,
      rotationDeg=number,
      look=_look_patch_schema(),
  )
  operation['required'] = ['op']
  answer = _properties(
      operations={'type': 'array', 'items': operation},
      reply={'type': 'string'},
  )
  answer['required'] = ['operations', 'reply']
  return answer
