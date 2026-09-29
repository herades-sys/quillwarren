// Prop and terrain art in the browser: each asset is fetched once, the first
// time a map needs it (the server has already cleaned it), then kept.
import { parseAssetSvg, type DelveMap } from '@delve/core';

export interface ArtLoader {
  /** Start loading whatever this map uses that isn't loaded yet; onLoaded runs as each arrives. */
  ensure(map: DelveMap): void;
  /** For buildScene's `assets` option: the body, or undefined while it's loading (or failed). */
  body(id: string): string | undefined;
}

export function artLoader(onLoaded: () => void): ArtLoader {
  const bodies = new Map<string, string | null>(); // null: loading or failed, don't ask again
  return {
    ensure(map) {
      for (const o of map.objects) {
        if ((o.type !== 'prop' && o.type !== 'terrain') || bodies.has(o.asset)) continue;
        const id = o.asset;
        bodies.set(id, null);
        void fetch(`/assets/props/${encodeURIComponent(id)}.svg`)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
          .then((svg) => {
            bodies.set(id, parseAssetSvg(svg).body);
            onLoaded();
          })
          .catch(() => {});
      }
    },
    body: (id) => bodies.get(id) ?? undefined,
  };
}
