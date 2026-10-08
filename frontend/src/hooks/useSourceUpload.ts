/**
 * Uploads the Source Video file. The local object URL exists from the
 * start, so the editor plays the file from the browser while the server
 * keeps its own copy for the analysis and the render.
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import {errorMessage, uploadSource} from '../lib/api';
import type {LocalVideoMetadata, UploadedSource} from '../types';

interface LocalFile {
  file: File;
  objectUrl: string;
}

export type UploadState =
  | {status: 'empty'}
  | ({status: 'uploading'; loadedBytes: number} & LocalFile)
  | ({status: 'ready'; source: UploadedSource} & LocalFile)
  | ({status: 'failed'; error: string} & LocalFile);

function isSameFile(state: UploadState, objectUrl: string): boolean {
  return state.status !== 'empty' && state.objectUrl === objectUrl;
}

function probeLocalVideo(objectUrl: string): Promise<LocalVideoMetadata> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    let settled = false;
    const finish = (meta: LocalVideoMetadata) => {
      if (settled) {
        return;
      }
      settled = true;
      video.removeAttribute('src');
      video.load();
      resolve(meta);
    };
    const timer = window.setTimeout(
      () => finish({durationSec: 0, width: 0, height: 0}),
      3000,
    );
    video.onloadedmetadata = () => {
      window.clearTimeout(timer);
      finish({
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      });
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      finish({durationSec: 0, width: 0, height: 0});
    };
    video.src = objectUrl;
  });
}

export function useSourceUpload() {
  const [state, setState] = useState<UploadState>({status: 'empty'});
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);

  const release = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, []);

  const upload = useCallback(
    (file: File) => {
      release();
      const url = URL.createObjectURL(file);
      const abort = new AbortController();
      objectUrl.current = url;
      controller.current = abort;
      const local: LocalFile = {file, objectUrl: url};
      setState({status: 'uploading', loadedBytes: 0, ...local});
      probeLocalVideo(url)
        .then((meta) =>
          uploadSource(
            file,
            (loadedBytes) =>
              setState((current) =>
                current.status === 'uploading' && isSameFile(current, url)
                  ? {...current, loadedBytes}
                  : current,
              ),
            abort.signal,
            meta,
          ),
        )
        .then((source) =>
          setState((current) =>
            isSameFile(current, url) ? {status: 'ready', source, ...local} : current,
          ),
        )
        .catch((error: unknown) => {
          if (!abort.signal.aborted) {
            setState((current) =>
              isSameFile(current, url)
                ? {status: 'failed', error: errorMessage(error), ...local}
                : current,
            );
          }
        });
    },
    [release],
  );

  const clear = useCallback(() => {
    release();
    setState({status: 'empty'});
  }, [release]);

  useEffect(() => release, [release]);

  return {state, upload, clear};
}
