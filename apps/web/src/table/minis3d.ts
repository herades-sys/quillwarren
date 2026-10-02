// The tokens as minis in the 3D table view: each one a standee (its picture on
// an upright card that turns to face the camera) on a round base in the colour
// of the member who controls it, or, with "flat" on, the picture lying on the
// base like a disc seen from above. Map-layer tokens always lie on the floor.
// GM-layer tokens (the GM only ever gets them) are translucent. Name plates and
// bars are HTML over the canvas, placed each frame, so they read like the 2D table's.
import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { Member, Token } from '@delve/table';
import { baseColor, faceYaw, miniShape, pickable, pxPerCell, tagParts, type MiniShape } from './scene3d-logic.ts';
import type { TextureCache } from './textures3d.ts';

export interface MiniHost {
  members(): Member[];
  me(): Member;
  flat(): boolean;
  selection(): ReadonlySet<string>;
  hovered(): string | null;
  /** Ids being dragged (lifted a little). */
  dragging(): ReadonlySet<string>;
  textures: TextureCache;
  /** The ground's height under a point (raised and sunken areas of the map), in cells; unset: 0. */
  groundY?(x: number, y: number): number;
  requestRender(): void;
}

interface Mini {
  token: Token;
  root: Group;
  /** Turned with the token (base, ring, a flat picture). */
  turn: Group;
  /** Turned to face the camera (the standee's card). */
  pivot: Group;
  base: Mesh | null;
  ring: Mesh | null;
  card: Mesh;
  shape: MiniShape;
  key: string;
  tag: HTMLElement;
  tagKey: string;
}

// one of each shape, scaled per mini
const unitCylinder = new CylinderGeometry(1, 1.04, 1, 48);
const unitPlane = new PlaneGeometry(1, 1);
const flatPlane = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const unitRing = new RingGeometry(1.04, 1.2, 64).rotateX(-Math.PI / 2);
const placeholderMat = new MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.9, transparent: true, opacity: 0.7, side: DoubleSide });
const hoverMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
const selectMat = new MeshBasicMaterial({ color: 0xd4a017, transparent: true, opacity: 0.95, depthWrite: false });

export interface Minis {
  /** Build, update and drop minis to match the tokens (positions with drags laid over). */
  sync(tokens: readonly Token[], at: ReadonlyMap<string, { x: number; y: number }>): void;
  /** Turn the standees to the camera and place the tags; call before each render. */
  face(camera: PerspectiveCamera, width: number, height: number): void;
  /** The mini under a ray (pickable tokens only), nearest first. */
  pick(ray: Raycaster): string | null;
  /** Re-read colours (members changed, theme). */
  refresh(): void;
}

export function createMinis(group: Group, tagLayer: HTMLElement, host: MiniHost): Minis {
  const minis = new Map<string, Mini>();
  const baseMats = new Map<string, MeshStandardMaterial>();
  const cardMats = new Map<string, MeshStandardMaterial>();
  const tmp = new Vector3();

  const baseMat = (color: string, ghost: boolean): MeshStandardMaterial => {
    const key = `${color}|${ghost}`;
    let m = baseMats.get(key);
    if (!m) {
      m = new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...(ghost ? { transparent: true, opacity: 0.45, depthWrite: false } : {}) });
      baseMats.set(key, m);
    }
    return m;
  };

  const cardMat = (url: string, ghost: boolean): MeshStandardMaterial | null => {
    const got = host.textures.get(url, host.requestRender);
    if (!got) return null;
    const key = `${url}|${ghost}`;
    let m = cardMats.get(key);
    if (!m) {
      // a little self-light keeps a standee readable with the sun behind it
      m = new MeshStandardMaterial({
        map: got.tex,
        emissiveMap: got.tex,
        emissive: 0xffffff,
        emissiveIntensity: 0.32,
        roughness: 0.8,
        side: DoubleSide,
        ...(ghost ? { transparent: true, opacity: 0.5, alphaTest: 0.05, depthWrite: false } : { alphaTest: 0.5 }),
      });
      cardMats.set(key, m);
    }
    return m;
  };

  function build(m: Mini, t: Token): void {
    m.turn.clear();
    m.pivot.clear();
    const ghost = t.layer === 'gm';
    const tex = host.textures.get(t.image, host.requestRender);
    const s = miniShape(t, tex?.aspect ?? 1, host.flat());
    m.shape = s;
    m.base = null;
    if (s.baseH > 0) {
      const base = new Mesh(unitCylinder, baseMat(baseColor(t, host.members()), ghost));
      base.scale.set(s.rx, s.baseH, s.rz);
      base.position.y = s.baseH / 2;
      base.castShadow = !ghost;
      base.receiveShadow = true;
      base.userData.tokenId = t.id;
      m.turn.add(base);
      m.base = base;
    }
    m.ring = null;
    if (t.layer !== 'map') {
      const ring = new Mesh(unitRing, hoverMat);
      ring.scale.set(s.rx, 1, s.rz);
      ring.position.y = 0.012;
      ring.renderOrder = 3;
      ring.visible = false;
      m.turn.add(ring);
      m.ring = ring;
    }
    const mat = cardMat(t.image, ghost) ?? placeholderMat;
    if (s.flat) {
      const card = new Mesh(flatPlane, mat);
      card.scale.set(s.cardW, 1, s.cardH);
      card.position.y = s.baseH + 0.006 + (t.layer === 'map' ? 0.002 : 0);
      card.receiveShadow = true;
      card.userData.tokenId = t.id;
      m.turn.add(card);
      m.card = card;
    } else {
      const card = new Mesh(unitPlane, mat);
      card.scale.set(s.cardW, s.cardH, 1);
      card.position.y = s.baseH + s.cardH / 2;
      card.castShadow = !ghost;
      card.userData.tokenId = t.id;
      m.pivot.add(card);
      m.card = card;
    }
  }

  function visualKey(t: Token): string {
    const tex = host.textures.get(t.image, host.requestRender);
    return JSON.stringify([t.image, t.w, t.h, t.layer, baseColor(t, host.members()), host.flat(), tex ? tex.aspect : null]);
  }

  return {
    sync(tokens, at) {
      const seen = new Set<string>();
      const lifted = host.dragging();
      const sel = host.selection();
      const hov = host.hovered();
      for (const t0 of tokens) {
        const p = at.get(t0.id);
        const t = p ? { ...t0, x: p.x, y: p.y } : t0;
        seen.add(t.id);
        let m = minis.get(t.id);
        if (!m) {
          const root = new Group();
          const turn = new Group();
          const pivot = new Group();
          root.add(turn, pivot);
          group.add(root);
          const tag = document.createElement('div');
          tag.className = 'tag3d';
          tag.hidden = true;
          tagLayer.append(tag);
          m = { token: t, root, turn, pivot, base: null, ring: null, card: new Mesh(), shape: miniShape(t, 1, false), key: '', tag, tagKey: '' };
          minis.set(t.id, m);
        }
        m.token = t;
        const key = visualKey(t);
        if (key !== m.key) {
          build(m, t);
          m.key = key;
        }
        const ground = host.groundY?.(t.x + t.w / 2, t.y + t.h / 2) ?? 0;
        m.root.position.set(t.x + t.w / 2, ground + (lifted.has(t.id) ? 0.14 : t.layer === 'map' ? 0 : 0.001), t.y + t.h / 2);
        // page rotation is clockwise with y down; about the world's up axis that's the other way
        m.turn.rotation.y = (-(t.rotation ?? 0) * Math.PI) / 180;
        if (m.ring) {
          const on = sel.has(t.id) || hov === t.id;
          m.ring.visible = on;
          m.ring.material = sel.has(t.id) ? selectMat : hoverMat;
        }
      }
      selectMat.color.set(host.me().color);
      for (const [id, m] of minis) {
        if (seen.has(id)) continue;
        group.remove(m.root);
        m.tag.remove();
        minis.delete(id);
      }
    },

    face(camera, width, height) {
      const sel = host.selection();
      const hov = host.hovered();
      for (const m of minis.values()) {
        const t = m.token;
        if (!m.shape.flat) m.pivot.rotation.y = faceYaw(m.root.position.x, m.root.position.z, camera.position.x, camera.position.z);
        // the tag: bars and name plate just over the mini
        tmp.set(m.root.position.x, m.root.position.y + m.shape.top + 0.12, m.root.position.z);
        const dist = camera.position.distanceTo(tmp);
        tmp.project(camera);
        const parts = tagParts(t, hov === t.id, sel.has(t.id), pxPerCell(dist, camera.fov, height));
        const show = (parts.name !== null || parts.bars.length > 0) && tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
        m.tag.hidden = !show;
        if (!show) continue;
        const k = JSON.stringify(parts);
        if (k !== m.tagKey) {
          m.tagKey = k;
          const kids: HTMLElement[] = [];
          if (parts.bars.length) {
            const bars = document.createElement('div');
            bars.className = 'bars';
            const w = Math.max(26, Math.min(80, pxPerCell(dist, camera.fov, height) * t.w));
            bars.style.width = `${Math.round(w)}px`;
            for (const b of parts.bars) {
              const bar = document.createElement('div');
              bar.className = 'bar';
              const fill = document.createElement('i');
              fill.style.width = `${Math.round((b.fraction ?? 1) * 100)}%`;
              fill.style.background = b.color;
              if (b.fraction === null) fill.style.opacity = '0.6';
              bar.append(fill);
              bars.append(bar);
            }
            kids.push(bars);
          }
          if (parts.name !== null) {
            const plate = document.createElement('div');
            plate.className = 'plate';
            plate.textContent = parts.name;
            kids.push(plate);
          }
          m.tag.replaceChildren(...kids);
        }
        const sx = ((tmp.x + 1) / 2) * width;
        const sy = ((1 - tmp.y) / 2) * height;
        m.tag.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translate(-50%, -100%)`;
      }
    },

    pick(ray) {
      const targets: Object3D[] = [];
      for (const m of minis.values()) {
        if (!pickable(m.token)) continue;
        targets.push(m.card);
        if (m.base) targets.push(m.base);
      }
      const hit = ray.intersectObjects(targets, false)[0];
      return (hit?.object.userData.tokenId as string | undefined) ?? null;
    },

    refresh() {
      for (const m of minis.values()) m.key = '';
    },
  };
}
