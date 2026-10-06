/**
 * Images and music the user added. Each file is uploaded to the server
 * (which renders with it) and kept as a local object URL for the preview.
 * Assets outlive a re-analysis, so a Scenario keeps its images and music
 * while the user iterates on the Editorial Prompt.
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import {uploadAsset} from '../lib/api';
import type {AssetKind, UploadedAsset} from '../types';

export interface AssetStore {
  /** Asset id -> object URL of the local file. */
  urls: ReadonlyMap<string, string>;
  /** Asset id -> server record. */
  records: ReadonlyMap<string, UploadedAsset>;
  /** Uploads a file; resolves with its record or rejects with the error. */
  add: (file: File, kind: AssetKind) => Promise<UploadedAsset>;
}

export function useAssets(): AssetStore {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [records, setRecords] = useState<ReadonlyMap<string, UploadedAsset>>(new Map());
  const created = useRef<string[]>([]);

  const add = useCallback(async (file: File, kind: AssetKind) => {
    const asset = await uploadAsset(file, kind);
    const url = URL.createObjectURL(file);
    created.current.push(url);
    setUrls((current) => new Map(current).set(asset.assetId, url));
    setRecords((current) => new Map(current).set(asset.assetId, asset));
    return asset;
  }, []);

  useEffect(
    () => () => {
      for (const url of created.current) {
        URL.revokeObjectURL(url);
      }
    },
    [],
  );

  return {urls, records, add};
}
