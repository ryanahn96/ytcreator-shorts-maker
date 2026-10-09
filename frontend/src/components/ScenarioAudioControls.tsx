/**
 * Audio settings that apply to the whole Scenario, never to a single Clip:
 * the Background Music with its volume. Clips meet with hard cuts, so there
 * is nothing to set between them.
 */

import {useState, type Dispatch} from 'react';

import type {AssetStore} from '../hooks/useAssets';
import {errorMessage} from '../lib/api';
import type {EditorAction} from '../lib/editor';
import {formatLength} from '../lib/format';
import type {Scenario, StudioConfig} from '../types';
import {Button, FilePicker, Section, SliderField} from './ui';

export function ScenarioAudioControls(props: {
  config: StudioConfig;
  scenario: Scenario;
  assets: AssetStore;
  dispatch: Dispatch<EditorAction>;
}) {
  const {config, scenario, assets, dispatch} = props;
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
          volume: music?.volume ?? config.composition.defaultMusicVolume,
        },
      });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="배경음악"
      actions={
        <FilePicker
          label={music ? '다른 음악' : '음악 추가'}
          accept="audio/*"
          busy={busy}
          icon="music_note"
          onFile={addMusic}
        />
      }
    >
      {music && (
        <div className="space-y-3">
          <p className="truncate text-sm text-on-surface">
            {musicRecord
              ? `${musicRecord.filename} · ${formatLength(musicRecord.durationSec)}`
              : music.assetId}
          </p>
          <SliderField
            label="음악 볼륨"
            value={music.volume}
            min={0}
            max={config.maxMusicVolume}
            step={0.01}
            format={(volume) => `${Math.round(volume * 100)}%`}
            onChange={(volume) => dispatch({type: 'setMusic', music: {...music, volume}})}
          />
          <Button
            variant="text"
            size="sm"
            icon="delete"
            className="-ms-3"
            onClick={() => dispatch({type: 'setMusic', music: null})}
          >
            음악 빼기
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </Section>
  );
}
