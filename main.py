"""에이전틱 숏폼 점프컷 스튜디오 진입점 모듈.

Python FastAPI 백엔드 서버(`yt.server`)를 실행한다.
"""

from __future__ import annotations

import argparse
import sys

from yt import server


def main(argv: list[str] | None = None) -> int:
  """애플리케이션 진입점.

  Args:
    argv: 명령줄 인자 목록.

  Returns:
    종료 코드 정수.
  """
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
      '--serve',
      action='store_true',
      help='FastAPI 숏폼 점프컷 스튜디오 백엔드 서버를 시작한다.',
  )
  args = parser.parse_args(argv)
  if args.serve:
    return server.main()
  print('Agentic Shortform Jumpcut Studio ready. Run with --serve to start API.')
  return 0


if __name__ == '__main__':
  sys.exit(main())
