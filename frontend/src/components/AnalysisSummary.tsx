/** What Gemini saw: the Source Video, its summary and how the run went. */

import {formatClock, formatSeconds, geminiBackendLabel} from '../lib/format';
import type {AnalysisResult, CatalogEntry} from '../types';
import {Panel} from './ui';

export function AnalysisSummary(props: {
  result: AnalysisResult;
  captionSources: readonly CatalogEntry[];
}) {
  const {sourceVideo, analysis} = props.result;
  const caption = props.captionSources.find(
    (entry) => entry.kind === sourceVideo.captionSource,
  );
  const stats = [
    `${geminiBackendLabel(analysis.geminiBackend)} · 모델 ${analysis.geminiModel}`,
    analysis.mediaProcessing,
    analysis.structuredOutput ? '구조화 출력(스키마)' : '스키마 없이 JSON 파싱',
    // Vertex AI does not return the navigation parts, so 0 means "not
    // reported"; the tool-use tokens still show the agentic work.
    analysis.agenticSteps > 0 && `에이전틱 단계 ${analysis.agenticSteps}`,
    `도구 토큰 ${analysis.toolUseTokens.toLocaleString()}`,
    `생각 토큰 ${analysis.thoughtsTokens.toLocaleString()}`,
    `소요 ${formatSeconds(analysis.elapsedSec)}`,
  ].filter((stat): stat is string => stat !== false);
  return (
    <Panel title={sourceVideo.title || sourceVideo.videoId}>
      <div className="space-y-2 text-xs text-zinc-300">
        <p className="text-zinc-400">
          {[
            sourceVideo.channel,
            formatClock(sourceVideo.durationSec),
            sourceVideo.width > 0 && `${sourceVideo.width}×${sourceVideo.height}`,
            sourceVideo.language,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p title={caption?.description}>
          자막: {caption?.label ?? sourceVideo.captionSource}
          {caption && <span className="text-zinc-500"> ({caption.description})</span>}
        </p>
        {props.result.videoSummary && <p>{props.result.videoSummary}</p>}
        {props.result.speakers.length > 0 && (
          <p className="text-zinc-400">화자: {props.result.speakers.join(', ')}</p>
        )}
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          {stats.map((stat) => (
            <span key={stat}>{stat}</span>
          ))}
        </p>
        {analysis.warnings.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-amber-300">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
