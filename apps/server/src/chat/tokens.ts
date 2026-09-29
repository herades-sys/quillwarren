// Short-lived MCP tokens for chat runs. The bridge runs as another user and
// must never hold the live API token, so each chat message gets its own
// random token that /mcp accepts until the run ends (or 10 minutes pass).
import { randomBytes } from 'node:crypto';

export interface ChatGrant {
  /** The address the user's browser used, so links Claude hands out work for them. */
  base: string;
  expires: number;
}

export class ChatTokens {
  private readonly grants = new Map<string, ChatGrant>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60_000) {
    this.ttlMs = ttlMs;
  }

  mint(base: string, now = Date.now()): string {
    for (const [t, g] of this.grants) if (g.expires <= now) this.grants.delete(t);
    const token = randomBytes(24).toString('base64url');
    this.grants.set(token, { base, expires: now + this.ttlMs });
    return token;
  }

  lookup(token: string | undefined, now = Date.now()): ChatGrant | null {
    const g = token ? this.grants.get(token) : undefined;
    if (!g) return null;
    if (g.expires <= now) {
      this.grants.delete(token!);
      return null;
    }
    return g;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }
}
