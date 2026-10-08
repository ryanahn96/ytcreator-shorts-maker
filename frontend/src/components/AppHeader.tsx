/** The app icon and name, creator profile badge, and top bar. */

import type {ReactNode} from 'react';

import type {CreatorProfile} from '../types';
import {BrandMark, Icon} from './Icon';
import {IconButton} from './ui';

export const APP_NAME = 'Agentic Shorts 생성 스튜디오';

/** The app icon with the app name; `titleClassName` can hide the name. */
export function Brand(props: {titleClassName?: string}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <BrandMark size={32} />
      <h1
        className={`truncate text-lg font-medium tracking-tight text-on-surface ${props.titleClassName ?? ''}`}
      >
        {APP_NAME}
      </h1>
    </div>
  );
}

/** Shows the signed-in YouTube creator's channel avatar, title and logout button. */
export function CreatorBadge(props: {
  user: CreatorProfile | null;
  onLogout: () => void;
}) {
  const {user, onLogout} = props;
  if (!user) {
    return null;
  }
  const label = user.channelTitle || user.name || user.email || '크리에이터';
  const sub = user.channelHandle || user.email;
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-surface-container py-1 pr-1 pl-2.5">
      {user.pictureUrl ? (
        <img
          src={user.pictureUrl}
          alt={label}
          referrerPolicy="no-referrer"
          className="h-6 w-6 rounded-full object-cover"
        />
      ) : (
        <Icon name="account_circle" size={22} className="text-on-surface-variant" />
      )}
      <div className="max-w-40 min-w-0 pr-1 max-md:hidden">
        <p className="truncate text-xs font-medium text-on-surface" title={label}>
          {label}
        </p>
        {sub && sub !== label && (
          <p className="truncate text-[11px] leading-tight text-on-surface-variant" title={sub}>
            {sub}
          </p>
        )}
      </div>
      <IconButton label="로그아웃" icon="logout" size="sm" onClick={onLogout} />
    </div>
  );
}

/** A plain top bar: the brand on the left, `children` on the right. */
export function AppHeader(props: {children?: ReactNode}) {
  return (
    <header className="sticky top-0 z-30 bg-surface">
      <div className="mx-auto flex h-16 max-w-[1720px] items-center gap-3 px-4 sm:px-6">
        <Brand />
        <div className="ms-auto flex shrink-0 items-center gap-1.5">{props.children}</div>
      </div>
    </header>
  );
}
