// Prop and terrain art in the browser: each asset is fetched once, the first
// time a map needs it (the server has already cleaned it), then kept. Custom
// props (custom-props.ts) wait for the library list, which gives their size,
// and are fetched again when they are redrawn.
import { assetInfo, isCustomAsset, parseAssetSvg, type DelveMap } from '@delve/core';
import { artUrl, loadCustomProps, onCustomProps } from './custom-props.ts';

export interface ArtLoader {
  /** Start loading whatever this map uses that isn't loaded yet; onLoaded runs as each arrives. */
  ensure(map: DelveMap): void;
  /** For buildScene's `assets` option: the body, or undefined while it's loading (or failed). */
  body(id: string): string | undefined;
}

export function artLoader(onLoaded: () => void): ArtLoader {
  const bodies = new Map<string, string | null>(); // null: loading or failed, don't ask again
  const versions = new Map<string, string>(); // custom prop -> the version its body is from
  const asked = new Set<string>(); // custom props missing from the list, asked about once (new elsewhere, or deleted)
  onCustomProps(() => {
    // a redrawn or deleted custom prop: forget its old art
    for (const [id, v] of versions) {
      if (assetInfo(id)?.updated !== v) {
        bodies.delete(id);
        versions.delete(id);
      }
    }
    onLoaded();
  });
  return {
    ensure(map) {
      let waiting = false;
      let unknown = false;
      for (const o of map.objects) {
        if ((o.type !== 'prop' && o.type !== 'terrain') || bodies.has(o.asset)) continue;
        const id = o.asset;
        if (isCustomAsset(id)) {
          const info = assetInfo(id);
          if (!info) {
            // not in the list (yet): the list says its size, or that it's gone
            waiting = true;
            if (!asked.has(id)) {
              asked.add(id);
              unknown = true;
            }
            continue;
          }
          versions.set(id, info.updated ?? '');
        }
        bodies.set(id, null);
        void fetch(artUrl(id))
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
          .then((svg) => {
            bodies.set(id, parseAssetSvg(svg).body);
            onLoaded();
          })
          .catch(() => {});
      }
      // a prop made since the list was loaded (another GM, Claude Code): load the list again, once per prop
      if (waiting) void loadCustomProps(unknown);
    },
    body: (id) => bodies.get(id) ?? undefined,
  };
}
