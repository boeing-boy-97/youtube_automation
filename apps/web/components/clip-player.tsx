'use client';

import { useState } from 'react';

/**
 * Vertical clip preview with an honest failure state.
 *
 * A stored object can disappear out of band (bucket lifecycle rule, manual delete, a restored
 * database). The API then answers 404 MEDIA_NOT_FOUND, and a bare <video> would show a silent
 * black rectangle — indistinguishable from a bug in the app. This surfaces what actually happened.
 */
export function ClipPlayer({ src, className = '' }: { src: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`mb-2 grid aspect-[9/16] w-full max-w-[210px] place-items-center rounded-lg border border-line bg-surface-sunken px-3 text-center ${className}`}
        role="status"
      >
        <div>
          <p className="text-xs font-medium text-ink">Preview unavailable</p>
          <p className="mt-1 text-[11px] text-ink-soft">The rendered file is no longer in storage.</p>
        </div>
      </div>
    );
  }

  return (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
      className={`mb-2 aspect-[9/16] w-full max-w-[210px] rounded-lg bg-black ${className}`}
    />
  );
}
