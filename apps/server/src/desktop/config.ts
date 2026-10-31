// What the desktop app's server reads from its environment. The Electron app
// (apps/desktop) sets all of it when it starts the server; nothing here falls
// back to the web server's defaults (./data, 0.0.0.0, port 8790).
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SECRET_PATTERN } from './gate.ts';

export interface DesktopConfig {
  /** The per-launch secret only the Electron window gets (DELVE_DESKTOP_SECRET). */
  secret: string;
  /** Maps, pictures, props, settings: %APPDATA%\Delve\data (DELVE_DATA). */
  dataDir: string;
  /** %APPDATA%\Delve\logs (DELVE_LOG_DIR). */
  logDir: string;
  /** GGUF model files: %LOCALAPPDATA%\Delve\models (DELVE_MODELS_DIR); big, so not in the roaming profile. */
  modelsDir: string;
  /** The port to try first (PORT; 0 = any free one). The server falls back to a free one when it is taken. */
  port: number;
  /** llama-server.exe in the app's resources (DELVE_LLAMA_SERVER), when this build has it. */
  llamaServer?: string;
  /** Ollama's model store, for "import from Ollama": OLLAMA_MODELS, else ~/.ollama/models. */
  ollamaModels: string;
  /** The app's version (DELVE_VERSION). */
  version: string;
  /** The Claude Desktop key while the user has connected Claude Desktop (DELVE_CLAUDE_DESKTOP_KEY); unset: not connected. */
  claudeKey?: string;
}

/** The desktop configuration from the environment, or an error saying what is missing. */
export function desktopConfig(env: NodeJS.ProcessEnv, home = homedir()): DesktopConfig {
  const secret = env.DELVE_DESKTOP_SECRET ?? '';
  if (!SECRET_PATTERN.test(secret)) throw new Error('DELVE_DESKTOP_SECRET is missing or too short: the desktop server only runs inside the Delve app');
  const dataDir = env.DELVE_DATA ?? '';
  if (!dataDir || !isAbsolute(dataDir)) throw new Error('DELVE_DATA must be an absolute folder (the Delve app passes %APPDATA%\\Delve\\data)');
  const port = env.PORT === undefined || env.PORT === '' ? 0 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  const abs = (v: string | undefined, fallback: string) => (v && isAbsolute(v) ? v : fallback);
  return {
    secret,
    dataDir,
    logDir: abs(env.DELVE_LOG_DIR, join(dataDir, '..', 'logs')),
    modelsDir: abs(env.DELVE_MODELS_DIR, join(dataDir, 'models')),
    port,
    ...(env.DELVE_LLAMA_SERVER && isAbsolute(env.DELVE_LLAMA_SERVER) ? { llamaServer: env.DELVE_LLAMA_SERVER } : {}),
    ollamaModels: abs(env.OLLAMA_MODELS, join(home, '.ollama', 'models')),
    version: env.DELVE_VERSION?.trim() || 'desktop',
    ...(env.DELVE_CLAUDE_DESKTOP_KEY && SECRET_PATTERN.test(env.DELVE_CLAUDE_DESKTOP_KEY) ? { claudeKey: env.DELVE_CLAUDE_DESKTOP_KEY } : {}),
  };
}
