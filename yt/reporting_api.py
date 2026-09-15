"""YouTube Reporting API v1 샘플 (벌크 리포트).

Reporting API는 쿼리형이 아니라 "작업(job)을 등록해 두면 YouTube가 매일
CSV 리포트를 생성"하는 방식이다. 등록 후 첫 리포트가 나오기까지 최대
48시간이 걸리며, 과거 30일치가 소급 생성된다.

사용법:
  uv run python -m yt.reporting_api list-types
  uv run python -m yt.reporting_api create-job channel_basic_a2
  uv run python -m yt.reporting_api list-jobs
  uv run python -m yt.reporting_api download <JOB_ID> [-o out.csv]
"""

from __future__ import annotations

import argparse
import io
from typing import Any

from googleapiclient.http import MediaIoBaseDownload

from yt import auth


def list_report_types(reporting: Any) -> list[dict[str, Any]]:
  """사용 가능한 리포트 유형 목록을 반환한다.

  Args:
    reporting: youtubereporting v1 서비스 객체.

  Returns:
    reportType 리소스 목록.
  """
  response = reporting.reportTypes().list().execute()
  return response.get('reportTypes', [])


def create_job(reporting: Any, report_type_id: str, name: str = '') -> dict[str, Any]:
  """리포트 생성 작업을 등록한다.

  Args:
    reporting: youtubereporting v1 서비스 객체.
    report_type_id: 리포트 유형 ID (예: 'channel_basic_a2').
    name: 작업 이름. 비워두면 유형 ID를 사용한다.

  Returns:
    생성된 job 리소스.
  """
  body = {'reportTypeId': report_type_id, 'name': name or report_type_id}
  return reporting.jobs().create(body=body).execute()


def list_jobs(reporting: Any) -> list[dict[str, Any]]:
  """등록된 작업 목록을 반환한다.

  Args:
    reporting: youtubereporting v1 서비스 객체.

  Returns:
    job 리소스 목록.
  """
  response = reporting.jobs().list().execute()
  return response.get('jobs', [])


def list_reports(reporting: Any, job_id: str) -> list[dict[str, Any]]:
  """특정 작업이 생성한 리포트 목록을 반환한다.

  Args:
    reporting: youtubereporting v1 서비스 객체.
    job_id: 작업 ID.

  Returns:
    report 리소스 목록 (생성 시각 오름차순).
  """
  response = reporting.jobs().reports().list(jobId=job_id).execute()
  return response.get('reports', [])


def download_report(reporting: Any, download_url: str, output_path: str) -> None:
  """리포트 CSV를 내려받아 파일로 저장한다.

  Args:
    reporting: youtubereporting v1 서비스 객체.
    download_url: report 리소스의 `downloadUrl`.
    output_path: 저장할 로컬 파일 경로.
  """
  request = reporting.media().download(resourceName='')
  request.uri = download_url
  with io.FileIO(output_path, mode='wb') as file_handle:
    downloader = MediaIoBaseDownload(file_handle, request, chunksize=-1)
    done = False
    while not done:
      _, done = downloader.next_chunk()


def _cmd_list_types(reporting: Any, _: argparse.Namespace) -> None:
  """리포트 유형을 출력한다."""
  for report_type in list_report_types(reporting):
    print(f'{report_type["id"]:40s} {report_type["name"]}')


def _cmd_create_job(reporting: Any, args: argparse.Namespace) -> None:
  """작업을 등록하고 결과를 출력한다."""
  job = create_job(reporting, args.report_type_id, args.name)
  print(f'작업 생성됨: id={job["id"]} name={job["name"]}')
  print('첫 리포트는 최대 48시간 후에 생성됩니다.')


def _cmd_list_jobs(reporting: Any, _: argparse.Namespace) -> None:
  """작업과 각 작업의 최신 리포트를 출력한다."""
  jobs = list_jobs(reporting)
  if not jobs:
    print('등록된 작업이 없습니다. create-job 으로 먼저 등록하세요.')
    return
  for job in jobs:
    reports = list_reports(reporting, job['id'])
    print(
        f'{job["id"]} | {job["name"]} | type={job["reportTypeId"]} | '
        f'리포트 {len(reports)}개'
    )
    if reports:
      latest = reports[-1]
      print(
          f'    최신: {latest["startTime"]} ~ {latest["endTime"]} '
          f'(reportId={latest["id"]})'
      )


def _cmd_download(reporting: Any, args: argparse.Namespace) -> None:
  """최신 리포트를 내려받는다."""
  reports = list_reports(reporting, args.job_id)
  if not reports:
    print('아직 생성된 리포트가 없습니다.')
    return
  latest = reports[-1]
  download_report(reporting, latest['downloadUrl'], args.output)
  print(f'{args.output} 저장 완료 ({latest["startTime"]} ~ {latest["endTime"]})')


def main() -> None:
  """CLI 진입점."""
  parser = argparse.ArgumentParser(description='YouTube Reporting API 샘플')
  sub = parser.add_subparsers(dest='command', required=True)

  sub.add_parser('list-types', help='리포트 유형 목록')

  create = sub.add_parser('create-job', help='리포트 작업 등록')
  create.add_argument('report_type_id')
  create.add_argument('--name', default='')

  sub.add_parser('list-jobs', help='등록된 작업 목록')

  download = sub.add_parser('download', help='최신 리포트 CSV 다운로드')
  download.add_argument('job_id')
  download.add_argument('-o', '--output', default='report.csv')

  args = parser.parse_args()
  reporting = auth.build_service('youtubereporting', 'v1')
  handlers = {
      'list-types': _cmd_list_types,
      'create-job': _cmd_create_job,
      'list-jobs': _cmd_list_jobs,
      'download': _cmd_download,
  }
  handlers[args.command](reporting, args)


if __name__ == '__main__':
  main()
