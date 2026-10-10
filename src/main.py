"""FastAPI app of Agentic Shorts 생성 스튜디오.

Every endpoint lives in a router under src/api/ (one per feature);
this module adds them, the JSON error format and the SPA fallback.
The Vite dev server proxies /api here; production serves the built
frontend from frontend/dist as well.

Run:
  uv run python -m src.main
"""

from __future__ import annotations

import fastapi
from fastapi import exceptions as fastapi_exceptions
from fastapi import responses
from starlette import exceptions as starlette_exceptions
import uvicorn

from src.api import analysis
from src.api import auth
from src.api import deps
from src.api import edit
from src.api import render
from src.api import studio
from src.api import uploads
from src.api import youtube

app = fastapi.FastAPI(title='Agentic Shorts 생성 스튜디오 API')
app.include_router(studio.router)
app.include_router(auth.router)
app.include_router(youtube.router)
app.include_router(analysis.router)
app.include_router(edit.router)
app.include_router(uploads.router)
app.include_router(render.router)


@app.exception_handler(starlette_exceptions.HTTPException)
def http_error(
    unused_request: fastapi.Request, exc: starlette_exceptions.HTTPException
) -> responses.JSONResponse:
  """Formats HTTP errors as {"error": ...}."""
  return deps.error(str(exc.detail), exc.status_code)


@app.exception_handler(fastapi_exceptions.RequestValidationError)
def validation_error(
    unused_request: fastapi.Request,
    exc: fastapi_exceptions.RequestValidationError,
) -> responses.JSONResponse:
  """Formats request validation errors as {"error": ...} with HTTP 422."""
  details = '; '.join(
      '.'.join(str(part) for part in error.get('loc', ()))
      + f': {error.get("msg", "")}'
      for error in exc.errors()
  )
  return deps.error(f'요청 형식이 올바르지 않습니다. {details}', 422)


@app.get('/{path:path}', response_model=None)
def frontend(path: str) -> fastapi.Response:
  """Serves the built frontend (frontend/dist) with an SPA fallback."""
  if path == 'api' or path.startswith('api/'):
    return deps.error('Not found', 404)
  dist = deps.settings.dist_dir.resolve()
  candidate = (dist / path).resolve()
  if path and candidate.is_file() and candidate.is_relative_to(dist):
    return responses.FileResponse(candidate)
  index = dist / 'index.html'
  if index.is_file():
    return responses.FileResponse(index)
  return responses.JSONResponse({'status': 'backend running'})


def main() -> int:
  """Starts the API server."""
  uvicorn.run(app, host='0.0.0.0', port=deps.settings.backend_port)
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
