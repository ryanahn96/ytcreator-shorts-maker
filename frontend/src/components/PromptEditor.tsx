/** The user-editable Editorial Prompt (Shorts 생성 프롬프트) with a reset to the default. */

import {Button} from './ui';

export function PromptEditor(props: {
  value: string;
  defaultValue: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  const edited = props.value !== props.defaultValue;
  return (
    <div className="space-y-2">
      <textarea
        aria-label="Shorts 생성 프롬프트"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        rows={props.rows ?? 12}
        spellCheck={false}
        className="block w-full resize-y rounded-2xl border border-outline-variant bg-surface p-4 text-[13px] leading-6 text-on-surface transition-colors hover:border-outline focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex justify-end">
        <Button
          variant="text"
          size="sm"
          icon="undo"
          disabled={!edited}
          onClick={() => props.onChange(props.defaultValue)}
        >
          기본값으로
        </Button>
      </div>
    </div>
  );
}
