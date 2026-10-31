// Server-sent events from a fetch body: the streaming answers of the Anthropic
// and OpenAI APIs (chat/anthropic.ts, chat/openai.ts). Lines are split on any
// line break, "data:" lines of one event are joined with "\n", a blank line
// ends the event, comments (":") are skipped. Multi-byte characters split
// across chunks are decoded whole.

export interface SseEvent {
  event: string;
  data: string;
}

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  let event = '';
  let data: string[] = [];
  const line = function* (l: string): Generator<SseEvent> {
    if (l === '') {
      if (data.length) yield { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      return;
    }
    if (l.startsWith(':')) return;
    const at = l.indexOf(':');
    const field = at < 0 ? l : l.slice(0, at);
    const value = at < 0 ? '' : l.slice(at + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        if (buf[nl] === '\r' && nl === buf.length - 1) break; // maybe the first half of \r\n: wait for the next chunk
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
        yield* line(l);
      }
    }
    buf += decoder.decode();
    if (buf) yield* line(buf);
    yield* line('');
  } finally {
    reader.releaseLock();
  }
}
