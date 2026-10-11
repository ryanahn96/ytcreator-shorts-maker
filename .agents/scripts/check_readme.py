"""Checks README.md against the code: links, anchors, env vars, routes, labels.

Run from anywhere in the repo:

  python3 .agents/scripts/check_readme.py

Problems make it exit 1: a broken anchor or relative link, an env var missing
from the README table or from the code, an API row that doesn't match the
routers, a quoted UI label that the frontend had at HEAD but no longer has, an
em dash, en dash or curly quote. Notes are only printed: quotes that were never
frontend labels (typed examples) and prose lines with parentheses or
mid-sentence colons.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
_PUNCTUATION = (
    ('\u2014', 'em dash'),
    ('\u2013', 'en dash'),
    ('\u201c', 'curly quote'),
    ('\u201d', 'curly quote'),
    ('\u2018', 'curly quote'),
    ('\u2019', 'curly quote'),
)
_ROUTE = re.compile(
    r"@router\.(get|post|put|patch|delete)\(\s*'([^']*)'")
_API_ROW = re.compile(
    r'^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)`', re.M)


def _read(path: str) -> str:
  return (ROOT / path).read_text(encoding='utf-8')


def github_slug(heading: str) -> str:
  """Returns the anchor GitHub generates for a heading."""
  text = heading.strip().lower().replace('`', '')
  # GitHub keeps letters of any script, digits, spaces, hyphens, underscores.
  text = ''.join(ch for ch in text if ch.isalnum() or ch in ' -_')
  return text.replace(' ', '-')


def _section(text: str, heading: str) -> str | None:
  """Returns the text under `heading` up to the next heading of its level."""
  match = re.search(rf'^{re.escape(heading)}$', text, flags=re.M)
  if not match:
    return None
  level = len(heading) - len(heading.lstrip('#'))
  rest = text[match.end():]
  end = re.search(rf'^#{{1,{level}}} ', rest, flags=re.M)
  return rest[:end.start()] if end else rest


def _frontend_text() -> str:
  return ''.join(
      path.read_text(encoding='utf-8')
      for path in sorted((ROOT / 'frontend/src').rglob('*'))
      if path.suffix in ('.ts', '.tsx'))


def _in_frontend_at_head(label: str) -> bool:
  result = subprocess.run(
      ['git', 'grep', '-q', '-F', '-e', label, 'HEAD', '--', 'frontend/src'],
      cwd=ROOT, capture_output=True, stdin=subprocess.DEVNULL, check=False)
  return result.returncode == 0


def _check_env_table(readme: str, problems: list[str]) -> None:
  table = _section(readme, '### 환경 변수')
  if table is None:
    problems.append("README에 '### 환경 변수' 절이 없음")
    return
  config = _read('src/core/config.py')
  example = _read('.env.example')
  documented = set(re.findall(r'`([A-Z][A-Z0-9_]{2,})`', table))
  for name in sorted(documented):
    if name not in config and name not in example:
      problems.append(f'README 표의 환경 변수가 코드에 없음: {name}')
  in_code = set(re.findall(r"_env_\w+\(\s*'([A-Z][A-Z0-9_]+)'", config))
  in_code |= set(re.findall(r"os\.environ\.get\('([A-Z][A-Z0-9_]+)'", config))
  for name in sorted(in_code - documented):
    problems.append(f'코드의 환경 변수가 README 표에 없음: {name}')


def _check_api_table(readme: str, problems: list[str]) -> None:
  table = _section(readme, '### API')
  if table is None:
    problems.append("README에 '### API' 절이 없음")
    return
  routes = set()
  for path in sorted((ROOT / 'src/api').glob('*.py')):
    text = path.read_text(encoding='utf-8')
    prefix = re.search(r"APIRouter\(\s*prefix='([^']*)'", text)
    for method, route in _ROUTE.findall(text):
      routes.add((method.upper(), (prefix.group(1) if prefix else '') + route))
  documented = {
      (method, route.split('?')[0]) for method, route in _API_ROW.findall(table)
  }
  for method, route in sorted(routes - documented):
    problems.append(f'README API 표에 없는 경로: {method} {route}')
  for method, route in sorted(documented - routes):
    problems.append(f'코드에 없는 README API 경로: {method} {route}')


def review() -> tuple[list[str], list[str]]:
  """Returns (problems, notes) for README.md."""
  readme = _read('README.md')
  body = re.sub(r'```.*?```', '', readme, flags=re.S)
  problems: list[str] = []
  notes: list[str] = []

  headings = re.findall(r'^#{1,6} (.+)$', body, flags=re.M)
  slugs = {github_slug(heading) for heading in headings}
  for target in re.findall(r'\]\(#([^)]+)\)', body):
    if target not in slugs:
      problems.append(f'README 앵커 없음: #{target}')
  for target in re.findall(r'\]\((?!https?://|#|mailto:)([^)]+)\)', body):
    if not (ROOT / target.split('#')[0]).exists():
      problems.append(f'README 링크 대상 없음: {target}')

  _check_env_table(readme, problems)
  _check_api_table(readme, problems)

  user_half = body.split('## 개발자 안내', 1)[0]
  frontend = _frontend_text()
  for label in sorted(set(re.findall(r'"([^"\n]{1,40})"', user_half))):
    if label in frontend:
      continue
    if _in_frontend_at_head(label):
      problems.append(f'README가 인용한 라벨이 프런트엔드에서 사라짐: "{label}"')
    else:
      notes.append(f'프런트엔드에 없는 인용, 입력 예시일 수 있음: "{label}"')

  prose = re.sub(r'`[^`\n]*`', '', body)
  for char, name in _PUNCTUATION:
    if char in prose:
      problems.append(f'README에 {name} 있음')
  for line in prose.splitlines():
    if line.startswith('|'):
      continue
    if '(' in line and '](' not in line:
      notes.append(f'괄호가 있는 문장: {line[:100]}')
    elif re.search(r'[가-힣A-Za-z)]: [가-힣A-Za-z]', line):
      notes.append(f'문장 중간 콜론: {line[:100]}')
  return problems, notes


def main() -> None:
  problems, notes = review()
  for note in notes:
    print('참고:', note)
  for problem in problems:
    print('문제:', problem)
  print(f'문제 {len(problems)}건' if problems else 'OK')
  sys.exit(1 if problems else 0)


if __name__ == '__main__':
  main()
