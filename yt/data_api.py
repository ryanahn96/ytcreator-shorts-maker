"""YouTube Data API v3 샘플.

내 채널 정보, 업로드 재생목록의 최근 영상, 각 영상의 통계를 조회한다.

실행:
  uv run python -m yt.data_api
"""

from __future__ import annotations

from typing import Any

from yt import auth


def get_my_channel(youtube: Any) -> dict[str, Any]:
  """인증된 사용자의 채널 리소스를 반환한다.

  Args:
    youtube: Data API v3 서비스 객체.

  Returns:
    채널 리소스 dict.

  Raises:
    RuntimeError: 계정에 연결된 채널이 없을 때.
  """
  response = (
      youtube.channels()
      .list(part='snippet,contentDetails,statistics', mine=True)
      .execute()
  )
  items = response.get('items', [])
  if not items:
    raise RuntimeError('이 계정에 연결된 YouTube 채널이 없습니다.')
  return items[0]


def list_recent_videos(
    youtube: Any, uploads_playlist_id: str, max_results: int = 10
) -> list[dict[str, Any]]:
  """업로드 재생목록에서 최근 영상 목록을 가져온다.

  Args:
    youtube: Data API v3 서비스 객체.
    uploads_playlist_id: 채널의 uploads 재생목록 ID.
    max_results: 가져올 최대 영상 수 (1~50).

  Returns:
    playlistItem 리소스 목록.
  """
  response = (
      youtube.playlistItems()
      .list(
          part='snippet,contentDetails',
          playlistId=uploads_playlist_id,
          maxResults=max_results,
      )
      .execute()
  )
  return response.get('items', [])


def get_video_stats(youtube: Any, video_ids: list[str]) -> list[dict[str, Any]]:
  """영상 ID 목록에 대한 통계를 조회한다.

  Args:
    youtube: Data API v3 서비스 객체.
    video_ids: 영상 ID 목록 (최대 50개).

  Returns:
    video 리소스 목록.
  """
  if not video_ids:
    return []
  response = (
      youtube.videos()
      .list(part='snippet,statistics,contentDetails', id=','.join(video_ids))
      .execute()
  )
  return response.get('items', [])


def search_videos(
    youtube: Any, query: str, max_results: int = 5
) -> list[dict[str, Any]]:
  """공개 영상을 키워드로 검색한다.

  Args:
    youtube: Data API v3 서비스 객체.
    query: 검색어.
    max_results: 최대 결과 수.

  Returns:
    search 결과 리소스 목록.
  """
  response = (
      youtube.search()
      .list(part='snippet', q=query, type='video', maxResults=max_results)
      .execute()
  )
  return response.get('items', [])


def main() -> None:
  """채널 요약과 최근 영상 통계를 출력한다."""
  youtube = auth.build_service('youtube', 'v3')

  channel = get_my_channel(youtube)
  stats = channel['statistics']
  print(f'채널: {channel["snippet"]["title"]} ({channel["id"]})')
  print(
      f'  구독자: {stats.get("subscriberCount", "비공개")} / '
      f'영상: {stats.get("videoCount")} / 총 조회수: {stats.get("viewCount")}'
  )

  uploads = channel['contentDetails']['relatedPlaylists']['uploads']
  items = list_recent_videos(youtube, uploads)
  video_ids = [item['contentDetails']['videoId'] for item in items]

  print(f'\n최근 영상 {len(video_ids)}개:')
  for video in get_video_stats(youtube, video_ids):
    vstats = video['statistics']
    print(
        f'  [{video["id"]}] {video["snippet"]["title"]}\n'
        f'    조회 {vstats.get("viewCount", 0)} · '
        f'좋아요 {vstats.get("likeCount", 0)} · '
        f'댓글 {vstats.get("commentCount", 0)} · '
        f'게시일 {video["snippet"]["publishedAt"]}'
    )


if __name__ == '__main__':
  main()
