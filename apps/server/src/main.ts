// Entry point. The release bundle (release/main.mjs) is built from this file.
// Env: PORT (default 8790; 0 = any free port), HOST, DELVE_DATA (database dir),
// DELVE_API_TOKEN (needed for any change; without it the API is read-only),
// DELVE_CHAT_URL (the chat bridge, e.g. http://127.0.0.1:8792) and DELVE_CHAT_MODEL.
// Discord login for Delve Table: DELVE_DISCORD_CLIENT_ID + DELVE_DISCORD_CLIENT_SECRET,
// optional DELVE_PUBLIC_URL, DELVE_GM_DISCORD_IDS, DELVE_DISCORD_API and DELVE_DISCORD_CDN.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { parsePort } from './config.ts';
import { MapStore } from './store.ts';
import { parseDiscordIds, parsePublicUrl, type DiscordConfig } from './table/discord.ts';

function readVersion(): string {
  try {
    return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

const port = parsePort(process.env.PORT);
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DELVE_DATA || './data';
mkdirSync(dataDir, { recursive: true });
const store = new MapStore(join(dataDir, 'delve.db'));
const token = process.env.DELVE_API_TOKEN || undefined;
const passwordHash = process.env.DELVE_EDIT_PASSWORD_HASH || undefined;
const openEdit = process.env.DELVE_INSECURE_OPEN_EDIT === '1';
const chatUrl = process.env.DELVE_CHAT_URL || undefined;
const chat = chatUrl ? { bridgeUrl: chatUrl, port: port || 8790, model: process.env.DELVE_CHAT_MODEL || undefined } : undefined;

const discordId = process.env.DELVE_DISCORD_CLIENT_ID?.trim() || undefined;
const discordSecret = process.env.DELVE_DISCORD_CLIENT_SECRET?.trim() || undefined;
const discord: DiscordConfig | undefined =
  discordId && discordSecret
    ? {
        clientId: discordId,
        clientSecret: discordSecret,
        publicUrl: parsePublicUrl(process.env.DELVE_PUBLIC_URL),
        gmIds: parseDiscordIds(process.env.DELVE_GM_DISCORD_IDS),
        api: process.env.DELVE_DISCORD_API?.trim() || undefined,
        cdn: process.env.DELVE_DISCORD_CDN?.trim() || undefined,
      }
    : undefined;

const app = buildApp(
  { version: readVersion(), started: new Date().toISOString() },
  { logger: true, store, token, passwordHash, openEdit, chat, dataDir, discord, publicUrl: parsePublicUrl(process.env.DELVE_PUBLIC_URL) },
);
if (discord) app.log.info({ coGms: discord.gmIds?.length ?? 0, publicUrl: discord.publicUrl ?? null }, 'Discord login for Delve Table is on');
else if (discordId || discordSecret) app.log.warn('Discord login needs both DELVE_DISCORD_CLIENT_ID and DELVE_DISCORD_CLIENT_SECRET: it stays off');
if (process.env.DELVE_PUBLIC_URL?.trim() && !parsePublicUrl(process.env.DELVE_PUBLIC_URL)) app.log.warn('DELVE_PUBLIC_URL is not an http(s) URL: ignored');
if (!token) app.log.warn('DELVE_API_TOKEN is not set: the API is read-only');
if (!passwordHash && !openEdit) app.log.info('no editor password set (run delve-passwd): the browser editor is read-only');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}

await app.listen({ port, host }); // Fastify logs the address it actually bound
