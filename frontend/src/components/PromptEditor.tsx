/** The user-editable Editorial Prompt, prefilled with the default. */

import {RotateCcw} from 'lucide-react';

import {Panel, TextButton} from './ui';

export function PromptEditor(props: {
  value: string;
  defaultValue: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const edited = props.value !== props.defaultValue;
  return (
    <Panel
      title={
        <span>
          Editorial Prompt
          {edited && <span className="ml-2 text-[11px] font-normal text-amber-300">수정됨</span>}
        </span>
      }
      actions={
        <TextButton
          disabled={!edited || props.disabled}
          onClick={() => props.onChange(props.defaultValue)}
        >
          <RotateCcw size={14} />
          기본 프롬프트로
        </TextButton>
      }
    >
      <details open className="group">
        <summary className="mb-2 cursor-pointer text-[11px] text-zinc-400">
          어떤 장면을 고르고 어떻게 이야기를 엮을지에 대한 편집 기준입니다. 각 Clip을
          어디서 시작하고 끝낼지는 Gemini가 영상을 직접 보고 정합니다.
        </summary>
        <textarea
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
          rows={12}
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100 disabled:opacity-60"
        />
      </details>
    </Panel>
  );
}
