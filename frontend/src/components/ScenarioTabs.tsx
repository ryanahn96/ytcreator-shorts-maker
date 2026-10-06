/** Tabs of the Scenarios Gemini proposed, with the selected one's rationale. */

import {RotateCcw} from 'lucide-react';

import {formatSeconds} from '../lib/format';
import type {Scenario} from '../types';
import {Panel, TextButton} from './ui';

export function ScenarioTabs(props: {
  scenarios: readonly Scenario[];
  original: readonly Scenario[];
  durations: readonly number[];
  index: number;
  onSelect: (index: number) => void;
  onReset: () => void;
}) {
  const {scenarios, index} = props;
  const selected = scenarios[index];
  const edited = selected !== props.original[index];
  return (
    <Panel
      title={`시나리오 ${scenarios.length}개`}
      actions={
        <TextButton disabled={!edited} onClick={props.onReset}>
          <RotateCcw size={14} />
          Gemini 제안으로 되돌리기
        </TextButton>
      }
    >
      <div className="flex flex-wrap gap-2" role="tablist">
        {scenarios.map((scenario, position) => (
          <button
            key={scenario.scenarioId}
            type="button"
            role="tab"
            aria-selected={position === index}
            onClick={() => props.onSelect(position)}
            className={`rounded-lg border px-3 py-2 text-left text-xs ${
              position === index
                ? 'border-indigo-500 bg-indigo-500/10 text-white'
                : 'border-zinc-800 text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <span className="block font-semibold">
              {scenario.title}
              {scenario !== props.original[position] && (
                <span className="ml-1 text-amber-300">•</span>
              )}
            </span>
            <span className="block text-[11px] text-zinc-400">
              Clip {scenario.clips.length}개 · {formatSeconds(props.durations[position] ?? 0)}
            </span>
          </button>
        ))}
      </div>
      {selected?.rationale && (
        <p className="mt-3 text-xs text-zinc-300">{selected.rationale}</p>
      )}
    </Panel>
  );
}
