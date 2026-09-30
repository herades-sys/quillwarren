// Uploading a picture for tokens or page backgrounds: the raw bytes go to
// POST /api/v1/games/:id/assets, which checks them and answers with the URL.
import { api } from './dom.ts';

const OK_TYPE = /^image\/(png|jpeg|webp|gif)$/;
const OK_NAME = /\.(png|jpe?g|webp|gif)$/i;
export const MAX_UPLOAD = 10 * 1024 * 1024;

/** The picture's size in pixels, read locally before (or without) uploading. */
function pictureSize(file: Blob): Promise<{ width: number; height: number }> {
  const src = URL.createObjectURL(file);
  return new Promise<{ width: number; height: number }>((ok, fail) => {
    const img = new Image();
    img.onload = () => ok({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => fail(new Error('That file isn’t a picture this browser can read.'));
    img.src = src;
  }).finally(() => URL.revokeObjectURL(src));
}

export async function uploadImage(gameId: string, file: File): Promise<{ url: string; width: number; height: number }> {
  if (!OK_TYPE.test(file.type) && !OK_NAME.test(file.name)) throw new Error('Pick a PNG, JPEG, WebP or GIF picture.');
  if (file.size > MAX_UPLOAD) throw new Error('That picture is over 10 MB.');
  const size = await pictureSize(file);
  const res = await api<{ url: string }>(`/api/v1/games/${encodeURIComponent(gameId)}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  if (!res?.url) throw new Error('The upload gave no picture address back.');
  return { url: res.url, ...size };
}
