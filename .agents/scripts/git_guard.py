"""Makes Jetski ask the user before git commands that push or discard work.

PreToolUse hook for run_command, wired in .agents/hooks.json. Several Jetski
sessions share this working tree, so stash, reset --hard, checkout, switch,
restore and clean can wipe another session's uncommitted edits, and the user
pushes only on request. For those commands the hook prints a force_ask
decision. For every other command it prints nothing, which leaves the normal
permission flow alone. A PreToolUse hook that fails blocks the tool call, so
this one swallows every error and always exits 0.
"""

from __future__ import annotations

import json
import re
import shlex
import sys

_OPERATOR = re.compile(r'[;&|()]+')
# git options that take the next word as their value.
_OPTIONS_WITH_VALUE = frozenset(
    {'-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'})
_PUSH = 'push는 사용자가 시킬 때만 합니다.'
_DISCARD = ('여러 세션이 이 작업 트리를 함께 씁니다. 이 명령은 다른 세션이 '
            '커밋하지 않은 변경을 지우거나 브랜치를 바꿀 수 있습니다.')


def _words(command: str) -> list[str]:
  """Splits a shell command into words, operators such as && on their own."""
  lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
  lexer.whitespace_split = True
  try:
    return list(lexer)
  except ValueError:
    return command.split()


def _git_calls(words: list[str]) -> list[tuple[str, list[str]]]:
  """Returns (subcommand, arguments) for every git call in `words`."""
  calls = []
  for index, word in enumerate(words):
    if word != 'git' and not word.endswith('/git'):
      continue
    rest = words[index + 1:]
    position = 0
    while position < len(rest) and rest[position].startswith('-'):
      position += 2 if rest[position] in _OPTIONS_WITH_VALUE else 1
    if position < len(rest):
      calls.append((rest[position], rest[position + 1:]))
  return calls


def _reason(subcommand: str, args: list[str]) -> str:
  """Returns why the user must confirm this git command, or ''."""
  flags = set(args)
  if subcommand == 'push':
    return _PUSH
  if subcommand in ('checkout', 'switch'):
    return _DISCARD
  if subcommand == 'stash' and (not args or args[0] not in ('list', 'show')):
    return _DISCARD
  if subcommand == 'reset' and flags & {'--hard', '--merge', '--keep'}:
    return _DISCARD
  if subcommand == 'restore' and (
      flags & {'--worktree', '-W'} or not flags & {'--staged', '-S'}):
    return _DISCARD
  if subcommand == 'clean' and not flags & {'-n', '--dry-run'}:
    return _DISCARD
  if subcommand == 'branch' and (
      '-D' in flags
      or (flags & {'-d', '--delete'} and flags & {'-f', '--force'})):
    return _DISCARD
  return ''


def reasons(command: str, depth: int = 0) -> list[str]:
  """Returns why `command` needs the user's OK, looking into `sh -c` scripts."""
  words = _words(command)
  found = []
  segment: list[str] = []
  for word in [*words, ';']:
    if not _OPERATOR.fullmatch(word):
      segment.append(word)
      continue
    for subcommand, args in _git_calls(segment):
      if reason := _reason(subcommand, args):
        found.append(reason)
    segment = []
  if depth < 2:
    for word in words:
      if ' ' in word and 'git' in word:
        found += reasons(word, depth + 1)
  return found


def main() -> None:
  try:
    payload = json.load(sys.stdin)
    found = reasons(payload['toolCall']['args']['CommandLine'])
  except Exception:  # pylint: disable=broad-exception-caught
    # A crash here would block every command, so any error means no opinion.
    return
  if found:
    reason = ' '.join(dict.fromkeys(found))
    print(json.dumps({'decision': 'force_ask', 'reason': reason},
                     ensure_ascii=False))


if __name__ == '__main__':
  main()
