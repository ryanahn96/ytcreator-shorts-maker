#!/usr/bin/env bash
# 로컬 개발 서버를 띄운다. Google Cloud 프로젝트가 설정돼 있으면 먼저
# ADC(Application Default Credentials)를 확인하고, 없거나 만료됐으면
# `gcloud auth application-default login`을 띄운 뒤 시작한다.
#
#   ./dev.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Vertex AI와 Speech-to-Text는 ADC로 부른다. 프로젝트가 없으면
# Gemini API 키만 쓰는 구성이라 ADC가 필요 없다.
project="${STUDIO_SPEECH_PROJECT:-${GOOGLE_CLOUD_PROJECT:-}}"
if [[ -n "$project" ]] && command -v gcloud >/dev/null; then
  if gcloud auth application-default print-access-token \
      >/dev/null 2>&1; then
    echo "ADC 확인 완료 (프로젝트 $project)"
  elif [[ -t 0 ]]; then
    echo "ADC가 없거나 만료됐습니다. Google Cloud 로그인을 시작합니다."
    gcloud auth application-default login
    gcloud auth application-default set-quota-project "$project" || true
  else
    echo "ADC가 만료됐지만 터미널이 아니라 로그인을 띄울 수 없습니다." >&2
    echo "터미널에서 gcloud auth application-default login 을 실행하세요." >&2
  fi
fi

exec npm --prefix frontend run dev
