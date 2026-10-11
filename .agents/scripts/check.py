"""Checks changed files: ruff, 80 columns, tsc and README against the code.

By hand, from anywhere in the repo:

  python3 .agents/scripts/check.py        # files that differ from HEAD
  python3 .agents/scripts/check.py --all  # every tracked or new file

As the Jetski Stop hook (`--hook`, wired in .agents/hooks.json) it reads the
hook payload from stdin, checks only the files the agent edited since the last
user message, and sends the agent back to work while a check fails. It stops
asking after two reminders in a turn or when the same failures come back, so a
failure the agent cannot fix never traps it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any

import check_readme

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAX_COLUMNS = 80
MAX_REMINDERS = 2
MAX_SHOWN = 40
EDIT_TOOLS = frozenset(
    {'write_to_file', 'replace_file_content', 'multi_replace_file_content'})
# Changes under these paths can leave README.md out of date.
README_INPUTS = ('README.md', '.env.example', 'src/core/config.py',
                 'src/api/', 'frontend/src/')
_HUNK = re.compile(r'^@@ -\S+ \+(\d+)(?:,(\d+))? @@', re.M)


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
  return subprocess.run(
      args, cwd=ROOT, capture_output=True, text=True,
      stdin=subprocess.DEVNULL, timeout=300, check=False)


def _git_files(*args: str) -> set[str]:
  out = _run(['git', *args]).stdout
  return {path for path in out.split('\0') if path and (ROOT / path).is_file()}


def changed_files() -> set[str]:
  """Returns repo-relative files that differ from HEAD, new files included."""
  return (_git_files('diff', '-z', '--name-only', 'HEAD')
          | _git_files('ls-files', '-z', '--others', '--exclude-standard'))


def all_files() -> set[str]:
  """Returns every tracked or new repo-relative file that git doesn't ignore."""
  return _git_files(
      'ls-files', '-z', '--cached', '--others', '--exclude-standard')


def _changed_lines(path: str) -> list[int]:
  """Returns the 1-based numbers of the lines in path that differ from HEAD."""
  if _run(['git', 'ls-files', '--error-unmatch', '--', path]).returncode:
    count = len((ROOT / path).read_text(encoding='utf-8').splitlines())
    return list(range(1, count + 1))
  diff = _run(['git', 'diff', '-U0', 'HEAD', '--', path]).stdout
  numbers = []
  for start, count in _HUNK.findall(diff):
    numbers.extend(range(int(start), int(start) + int(count or 1)))
  return numbers


def _ruff() -> list[str] | None:
  if ruff := shutil.which('ruff'):
    return [ruff]
  if uvx := shutil.which('uvx'):
    return [uvx, '--offline', 'ruff']
  return None


def check_python(
    paths: list[str], everything: bool, notes: list[str]) -> list[str]:
  """Returns ruff F/E9 findings and lines longer than MAX_COLUMNS."""
  problems = []
  ruff = _ruff()
  if ruff is None:
    notes.append('ruff가 없어 ruff 검사를 건너뜀')
  else:
    result = _run([*ruff, 'check', '--quiet', '--select', 'F,E9',
                   '--output-format', 'concise', *paths])
    if result.returncode not in (0, 1):
      notes.append(f'ruff 실행 실패: {result.stderr.strip()[:200]}')
    problems += result.stdout.splitlines()
  for path in paths:
    lines = (ROOT / path).read_text(encoding='utf-8').splitlines()
    numbers = range(1, len(lines) + 1) if everything else _changed_lines(path)
    for number in numbers:
      line = lines[number - 1] if number <= len(lines) else ''
      # Long URLs may run past the limit.
      if len(line) > MAX_COLUMNS and '://' not in line:
        problems.append(f'{path}:{number}: {len(line)}자, {MAX_COLUMNS}자 넘음')
  return problems


def check_typescript(notes: list[str]) -> list[str]:
  """Returns tsc errors for the frontend."""
  npm = shutil.which('npm')
  if npm is None or not (ROOT / 'frontend/node_modules').is_dir():
    notes.append('npm이나 frontend/node_modules가 없어 tsc를 건너뜀')
    return []
  result = _run([npm, '--prefix', 'frontend', 'run', '--silent', 'lint'])
  if result.returncode == 0:
    return []
  errors = [line for line in result.stdout.splitlines() if 'error TS' in line]
  return ([f'frontend/{line}' for line in errors]
          or [(result.stdout + result.stderr).strip()[-1000:] or 'tsc 실패'])


def run_checks(
    files: list[str], everything: bool) -> tuple[list[str], list[str]]:
  """Returns (problems, notes) for the given repo-relative files."""
  problems: list[str] = []
  notes: list[str] = []
  python = [path for path in files if path.endswith('.py')]
  if python:
    problems += check_python(python, everything, notes)
  if any(path.startswith('frontend/') and path.endswith(('.ts', '.tsx'))
         for path in files):
    problems += check_typescript(notes)
  if everything or any(path.startswith(README_INPUTS) for path in files):
    readme_problems, readme_notes = check_readme.review()
    problems += readme_problems
    notes += readme_notes
  return problems, notes


def _text(value: Any) -> str:
  """Returns a transcript tool argument as text; most are JSON-encoded."""
  if not isinstance(value, str):
    return ''
  try:
    decoded = json.loads(value)
  except json.JSONDecodeError:
    return value.strip('"')
  return decoded if isinstance(decoded, str) else value


def _turn_edits(transcript: pathlib.Path) -> tuple[int, set[str]]:
  """Returns the last user message's step index and the files edited since."""
  turn, edited = -1, set()
  with transcript.open(encoding='utf-8') as lines:
    for line in lines:
      if 'USER_INPUT' not in line and 'TargetFile' not in line:
        continue
      try:
        step = json.loads(line)
      except json.JSONDecodeError:
        continue
      if not isinstance(step, dict):
        continue
      if step.get('type') == 'USER_INPUT':
        turn, edited = step.get('step_index', turn + 1), set()
        continue
      for call in step.get('tool_calls') or ():
        if not isinstance(call, dict) or call.get('name') not in EDIT_TOOLS:
          continue
        args = call.get('args')
        if not isinstance(args, dict):
          continue
        target = pathlib.Path(_text(args.get('TargetFile')))
        if target.is_absolute() and target.is_relative_to(ROOT):
          edited.add(target.relative_to(ROOT).as_posix())
  return turn, edited


def _state_path(conversation: str) -> pathlib.Path:
  name = re.sub(r'[^\w.-]', '_', conversation) or 'unknown'
  return pathlib.Path(tempfile.gettempdir(), 'ytcreator-check', f'{name}.json')


def hook(payload: dict[str, Any]) -> dict[str, str] | None:
  """Returns the Stop hook decision, or None to let the agent stop."""
  if payload.get('terminationReason', 'model_stop') != 'model_stop':
    return None
  if payload.get('fullyIdle') is False:
    return None  # Background work will wake the agent up again.
  transcript = pathlib.Path(payload.get('transcriptPath') or '')
  if not transcript.is_file():
    return None
  turn, edited = _turn_edits(transcript)
  files = sorted(edited & changed_files())
  if not files:
    return None
  problems, _ = run_checks(files, everything=False)
  if not problems:
    return None
  path = _state_path(str(payload.get('conversationId') or ''))
  try:
    state = json.loads(path.read_text(encoding='utf-8'))
  except (OSError, json.JSONDecodeError):
    state = {}
  if not isinstance(state, dict) or state.get('turn') != turn:
    state = {'turn': turn, 'reminders': 0, 'digest': ''}
  digest = hashlib.sha256('\n'.join(problems).encode('utf-8')).hexdigest()
  if state['reminders'] >= MAX_REMINDERS or state['digest'] == digest:
    return None
  state.update(reminders=state['reminders'] + 1, digest=digest)
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(state), encoding='utf-8')
  shown = problems[:MAX_SHOWN]
  if len(problems) > MAX_SHOWN:
    shown.append(f'외 {len(problems) - MAX_SHOWN}건')
  reason = '\n'.join([
      '[ytcreator-check] 이번 턴에 고친 파일에서 검사가 실패했습니다. '
      '고친 뒤 끝내세요. 이번 작업과 무관한 실패라면 사용자에게 알리고 '
      '끝내도 됩니다.',
      *shown,
      '다시 확인: python3 .agents/scripts/check.py',
  ])
  return {'decision': 'continue', 'reason': reason}


def main() -> None:
  parser = argparse.ArgumentParser(
      description='ytcreator 변경 파일 검사 (ruff, 80자, tsc, README)')
  parser.add_argument('--all', action='store_true', help='저장소 전체를 검사')
  parser.add_argument(
      '--hook', action='store_true', help='Jetski Stop 훅으로 실행')
  args = parser.parse_args()
  if args.hook:
    try:
      payload = json.load(sys.stdin)
      decision = hook(payload) if isinstance(payload, dict) else None
    except (json.JSONDecodeError, OSError, subprocess.SubprocessError):
      return  # Empty output lets the agent stop.
    if decision:
      print(json.dumps(decision, ensure_ascii=False))
    return
  files = sorted(all_files() if args.all else changed_files())
  problems, notes = run_checks(files, everything=args.all)
  for note in notes:
    print('참고:', note)
  for problem in problems:
    print('문제:', problem)
  print(f'문제 {len(problems)}건' if problems else 'OK')
  sys.exit(1 if problems else 0)


if __name__ == '__main__':
  main()
