/**
 * Audio settings that apply to the whole Scenario, never to a single Clip:
 * the Audio Transition between Clips (Gemini recommends one) and the
 * Background Music with its volume.
 */

import {Music, Trash2} from 'lucide-react';
import {useState, type Dispatch} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import {errorMessage} from '../lib/api';
import type {EditorAction} from '../lib/editor';
import {formatSeconds} from '../lib/format';
import type {CatalogEntry, Scenario, StudioConfig} from '../types';
import {ChoiceList, FilePicker, Panel, SliderField, TextButton} from './ui';

// Kind whose behavior the controls depend on (see yt/studio/composer.py).
const HARD_CUT = 'hard_cut';

function labelOf(entries: readonly CatalogEntry[], kind: string): string {
  return entries.find((entry) => entry.kind === kind)?.label ?? kind;
}

export function ScenarioAudioControls(props: {
  config: StudioConfig;
  scenario: Scenario;
  /** Gemini's version of this Scenario, for the recommendation. */
  recommended: Scenario;
  assets: AssetStore;
  dispatch: Dispatch<EditorAction>;
}) {
  const {config, scenario, recommended, assets, dispatch} = props;
  const composition = config.composition;
  const transition = scenario.audioTransition;
  const music = scenario.music;
  const musicRecord = music ? assets.records.get(music.assetId) : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addMusic = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const asset = await assets.add(file, 'audio');
      dispatch({
        type: 'setMusic',
        music: {
          assetId: asset.assetId,
          volume: music?.volume ?? composition.defaultMusicVolume,
        },
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="소리 (시나리오 전체)">
      <div className="space-y-4">
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-zinc-200">Clip 사이 음성 전환</h3>
          <p className="text-[11px] text-zinc-400">
            Gemini 추천: {labelOf(config.audioTransitions, recommended.audioTransition.kind)}
            {recommended.audioTransition.kind !== HARD_CUT &&
              ` ${recommended.audioTransition.durationSec.toFixed(2)}초`}
          </p>
          <ChoiceList
            name={`transition-${scenario.scenarioId}`}
            entries={config.audioTransitions}
            value={transition.kind}
            onChange={(kind) => dispatch({type: 'setTransition', transition: {...transition, kind}})}
          />
          <SliderField
            label="음성 겹침 길이"
            value={transition.durationSec}
            min={0}
            max={config.maxTransitionSec}
            step={0.01}
            disabled={transition.kind === HARD_CUT}
            format={(value) => `${value.toFixed(2)}초`}
            onChange={(durationSec) =>
              dispatch({type: 'setTransition', transition: {...transition, durationSec}})
            }
          />
        </section>
        <section className="space-y-2 border-t border-zinc-800 pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-zinc-200">배경음악</h3>
            <FilePicker
              label={music ? '다른 음악' : '음악 추가'}
              accept="audio/*"
              busy={busy}
              icon={<Music size={14} />}
              onFile={addMusic}
            />
          </div>
          {music ? (
            <div className="space-y-2">
              <p className="text-[11px] text-zinc-300">
                {musicRecord
                  ? `${musicRecord.filename} · ${formatSeconds(musicRecord.durationSec)}`
                  : music.assetId}
              </p>
              <SliderField
                label="음악 볼륨 (원본 음성은 그대로)"
                value={music.volume}
                min={0}
                max={config.maxMusicVolume}
                step={0.01}
                format={(volume) => `${Math.round(volume * 100)}%`}
                onChange={(volume) => dispatch({type: 'setMusic', music: {...music, volume}})}
              />
              <TextButton onClick={() => dispatch({type: 'setMusic', music: null})}>
                <Trash2 size={14} />
                음악 빼기
              </TextButton>
            </div>
          ) : (
            <p className="text-[11px] text-zinc-500">
              음악은 숏폼 길이에 맞춰 반복되고, 끝에서 {composition.musicFadeOutSec}초 동안
              줄어듭니다.
            </p>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </section>
      </div>
    </Panel>
  );
}
