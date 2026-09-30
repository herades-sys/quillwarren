// QR codes as inline SVG (qrcode-generator does the encoding). Always dark on
// white with a quiet zone, whatever the page theme, so phone cameras read it.
import qrcode from 'qrcode-generator';

export function qrSvg(text: string, opts: { size?: number; title?: string } = {}): string {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  let d = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const size = opts.size ?? 220;
  const title = opts.title ? `<title>${opts.title.replace(/[&<>"]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img">${title}<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
