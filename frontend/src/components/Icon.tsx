/**
 * Material Symbols Rounded icons. Only the glyphs listed here are
 * downloaded: Google Fonts subsets the font to icon_names, which must be in
 * alphabetical order. display=block hides the ligature text until the font
 * arrives.
 */

const ICON_NAMES = [
  'account_circle',
  'add',
  'add_photo_alternate',
  'arrow_downward',
  'arrow_upward',
  'brightness_auto',
  'check',
  'chevron_left',
  'chevron_right',
  'close',
  'content_cut',
  'dark_mode',
  'delete',
  'download',
  'error',
  'expand_more',
  'fullscreen',
  'fullscreen_exit',
  'history',
  'image',
  'insights',
  'light_mode',
  'link',
  'login',
  'logout',
  'mic',
  'movie',
  'music_note',
  'open_in_new',
  'palette',
  'pause',
  'play_arrow',
  'redo',
  'refresh',
  'replay',
  'search',
  'send',
  'stop',
  'subtitles',
  'tune',
  'undo',
  'upload',
  'video_call',
  'video_library',
  'warning',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const ICON_FONT_URL =
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:' +
  `opsz,wght,FILL,GRAD@20..48,400,0..1,0&icon_names=${ICON_NAMES.join(',')}` +
  '&display=block';

if (!document.querySelector('link[data-icon-font]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = ICON_FONT_URL;
  link.dataset['iconFont'] = '';
  document.head.append(link);
}

export function Icon(props: {
  name: IconName;
  /** Size in CSS pixels; defaults to 20. */
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  const size = props.size ?? 20;
  return (
    <span
      aria-hidden
      className={[
        'material-symbols-rounded shrink-0 overflow-hidden',
        props.filled ? 'icon-filled' : '',
        props.className ?? '',
      ].join(' ')}
      style={{fontSize: size, width: size, height: size}}
    >
      {props.name}
    </span>
  );
}

/**
 * The app icon (public/favicon.svg): white scissors on a YouTube-red rounded
 * square.
 */
export function BrandMark(props: {size?: number}) {
  const size = props.size ?? 32;
  return (
    <img src="/favicon.svg" alt="" width={size} height={size} className="shrink-0" />
  );
}
