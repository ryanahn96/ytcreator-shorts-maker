/**
 * "다시 분석": edit the Editorial Prompt and analyze the same video again,
 * either from the stored transcript alone (fast) or watching the video
 * again (deep). Mount it only while open; the draft starts from the
 * current prompt and becomes the prompt only when the analysis starts.
 */

import {useState} from 'react';

import type {ReanalyzeMode} from '../types';
import {PromptEditor} from './PromptEditor';
import {Button, Dialog, Notice, Segmented} from './ui';

const MODE_OPTIONS: readonly {value: ReanalyzeMode; label: string}[] = [
  {value: 'fast', label: '빠른 재분석 (자막)'},
  {value: 'deep', label: '화면 재탐색 (비디오 캐시)'},
];

const MODE_HINTS: Record<ReanalyzeMode, string> = {
  fast:
    '처음 분석 때 받아 둔 전체 자막만으로 구간을 다시 골라요. 대부분의 ' +
    '편집 요청은 이걸로 충분하고, 몇 초면 끝나며 비용도 거의 들지 않아요.',
  deep:
    '영상을 다시 봐요. 슬라이드·판서·표정처럼 화면을 봐야 고를 수 있는 ' +
    '요청에 쓰세요. 분석 후 1시간 안에는 캐시해 둔 영상을 다시 써서 더 ' +
    '싸고 빨라요.',
};

export function ReanalyzeDialog(props: {
  prompt: string;
  defaultPrompt: string;
  onClose: () => void;
  onStart: (prompt: string, mode: ReanalyzeMode) => void;
}) {
  const [draft, setDraft] = useState(props.prompt);
  const [mode, setMode] = useState<ReanalyzeMode>('fast');
  return (
    <Dialog
      open
      title="다시 분석"
      width={720}
      onClose={props.onClose}
      actions={
        <>
          <Button variant="text" onClick={props.onClose}>
            취소
          </Button>
          <Button
            icon="refresh"
            disabled={draft.trim() === ''}
            onClick={() => props.onStart(draft, mode)}
          >
            다시 분석
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <PromptEditor
          value={draft}
          defaultValue={props.defaultPrompt}
          rows={14}
          onChange={setDraft}
        />
        <Segmented<ReanalyzeMode>
          label="분석 방식"
          value={mode}
          options={MODE_OPTIONS}
          onChange={setMode}
        />
        <p className="text-xs text-on-surface-variant">{MODE_HINTS[mode]}</p>
        <Notice tone="warning">새 결과가 오면 지금 편집 내용은 사라져요</Notice>
      </div>
    </Dialog>
  );
}
