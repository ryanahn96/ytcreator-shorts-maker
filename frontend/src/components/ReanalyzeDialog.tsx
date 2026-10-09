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
  {value: 'fast', label: '빠른 분석 (자막)'},
  {value: 'deep', label: '정밀 분석 (화면)'},
];

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
        <Notice tone="warning">새 결과가 오면 지금 편집 내용은 사라져요</Notice>
      </div>
    </Dialog>
  );
}
