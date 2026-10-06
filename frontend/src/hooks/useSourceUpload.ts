/**
 * Uploads the Source Video MP4. The local object URL is available at once,
 * so the preview can play the file while it is still uploading.
 */

import {useCallback, useEffect, useRef, useState} from 'react';

import {errorMessage, uploadSource} from '../lib/api';
import type {UploadedSource} from '../types';

interface LocalFile {
  /** The Source Video this file was uploaded for. */
  videoId: string;
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
    (file: File, videoId: string) => {
      release();
      const url = URL.createObjectURL(file);
      const abort = new AbortController();
      objectUrl.current = url;
      controller.current = abort;
      const local: LocalFile = {videoId, file, objectUrl: url};
      setState({status: 'uploading', loadedBytes: 0, ...local});
      uploadSource(
        file,
        (loadedBytes) =>
          setState((current) =>
            current.status === 'uploading' && isSameFile(current, url)
              ? {...current, loadedBytes}
              : current,
          ),
        abort.signal,
      )
        .then((source) =>
          setState((current) =>
            isSameFile(current, url)
              ? {status: 'ready', source, ...local}
              : current,
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
