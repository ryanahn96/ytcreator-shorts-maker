"""YouTube Analytics API v2 샘플.

채널 단위 시계열 지표, 영상별 상위 성과, 트래픽 소스 분해를 조회한다.
Analytics API는 최근 2~3일 데이터가 아직 집계되지 않을 수 있다.

실행:
  uv run python -m yt.analytics_api
"""

from __future__ import annotations

import datetime
from typing import Any

from yt import auth

_CHANNEL_ID = 'channel==MINE'


def run_query(
    analytics: Any,
    *,
    start_date: str,
    end_date: str,
    metrics: str,
    dimensions: str | None = None,
    sort: str | None = None,
    filters: str | None = None,
    max_results: int | None = None,
) -> dict[str, Any]:
  """Analytics 리포트 쿼리를 실행한다.

  Args:
    analytics: youtubeAnalytics v2 서비스 객체.
    start_date: 시작일 (YYYY-MM-DD).
    end_date: 종료일 (YYYY-MM-DD).
    metrics: 콤마로 구분된 지표 목록.
    dimensions: 콤마로 구분된 차원 목록.
    sort: 정렬 기준 (예: '-views').
    filters: 필터 문자열 (예: 'country==KR').
    max_results: 최대 행 수.

  Returns:
    `columnHeaders`와 `rows`를 포함하는 응답 dict.
  """
  params: dict[str, Any] = {
      'ids': _CHANNEL_ID,
      'startDate': start_date,
      'endDate': end_date,
      'metrics': metrics,
  }
  if dimensions:
    params['dimensions'] = dimensions
  if sort:
    params['sort'] = sort
  if filters:
    params['filters'] = filters
  if max_results:
    params['maxResults'] = max_results
  return analytics.reports().query(**params).execute()


def print_report(title: str, response: dict[str, Any]) -> None:
  """리포트 응답을 표 형태로 출력한다.

  Args:
    title: 출력할 리포트 제목.
    response: `run_query` 응답.
  """
  headers = [column['name'] for column in response.get('columnHeaders', [])]
  rows = response.get('rows', [])
  print(f'\n== {title} ==')
  if not rows:
    print('  (데이터 없음)')
    return
  print('  ' + ' | '.join(headers))
  for row in rows:
    print('  ' + ' | '.join(str(value) for value in row))


def main() -> None:
  """최근 28일치 대표 Analytics 리포트 3종을 출력한다."""
  analytics = auth.build_service('youtubeAnalytics', 'v2')

  # Analytics 데이터는 2~3일 지연되므로 종료일을 3일 전으로 잡는다.
  end = datetime.date.today() - datetime.timedelta(days=3)
  start = end - datetime.timedelta(days=27)
  start_date, end_date = start.isoformat(), end.isoformat()
  print(f'기간: {start_date} ~ {end_date}')

  print_report(
      '일자별 조회수/시청시간/구독자',
      run_query(
          analytics,
          start_date=start_date,
          end_date=end_date,
          metrics='views,estimatedMinutesWatched,subscribersGained',
          dimensions='day',
          sort='day',
      ),
  )

  print_report(
      '상위 10개 영상',
      run_query(
          analytics,
          start_date=start_date,
          end_date=end_date,
          metrics='views,estimatedMinutesWatched,averageViewDuration',
          dimensions='video',
          sort='-views',
          max_results=10,
      ),
  )

  print_report(
      '트래픽 소스별 조회수',
      run_query(
          analytics,
          start_date=start_date,
          end_date=end_date,
          metrics='views,estimatedMinutesWatched',
          dimensions='insightTrafficSourceType',
          sort='-views',
      ),
  )


if __name__ == '__main__':
  main()
