// The shared stylesheet (/assets/delve-ui.css) and the style guide (/ui).
// The stylesheet's ?v= is a hash of its content, so a matching request may be
// cached for good; any other gets a short cache.
import type { FastifyInstance } from 'fastify';
import { UI_CSS, UI_CSS_PATH, UI_CSS_VERSION } from '@delve/ui';
import type { AppInfo } from './app.ts';
import { uiGuidePage } from './ui-guide.ts';

export function registerUi(app: FastifyInstance, info: AppInfo): void {
  app.get(UI_CSS_PATH, async (req, reply) => {
    const v = (req.query as { v?: unknown }).v;
    return reply
      .type('text/css; charset=utf-8')
      .header('cache-control', v === UI_CSS_VERSION ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      .send(UI_CSS);
  });

  let guide: string | undefined;
  app.get('/ui', async (_req, reply) => {
    guide ??= uiGuidePage({ version: info.version });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(guide);
  });
}
