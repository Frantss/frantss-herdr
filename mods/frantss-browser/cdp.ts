// A minimal Chrome DevTools Protocol session over one page target's WebSocket.

export interface CdpSocket {
  write(data: string): Promise<void>;
}
export interface CdpEvent {
  method: string;
  params: any;
}

export class CdpSession {
  private nextId = 0;
  private pending = new Map<number, (result: any) => void>();
  private socket: CdpSocket;
  private onEvent: (event: CdpEvent) => void;

  constructor(socket: CdpSocket, onEvent: (event: CdpEvent) => void) {
    this.socket = socket;
    this.onEvent = onEvent;
  }

  /** Resolves with the command's result, or null when it fails or the socket closes. */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    const reply = new Promise((resolve) => this.pending.set(id, resolve));
    this.socket.write(JSON.stringify({ id, method, params })).catch(() => this.settle(id, null));
    return reply;
  }

  receive(raw: string) {
    const message = JSON.parse(raw);
    if (message.id) this.settle(message.id, message.result ?? null);
    else if (message.method) this.onEvent({ method: message.method, params: message.params });
  }

  close() {
    for (const id of this.pending.keys()) this.settle(id, null);
  }

  private settle(id: number, result: any) {
    this.pending.get(id)?.(result);
    this.pending.delete(id);
  }
}

/** The first page target's WebSocket address, from the browser's HTTP endpoint. */
export async function pageSocketUrl(port: number): Promise<{ url: string; socket: string } | null> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((target) => target.type === "page");
  return page ? { url: page.url, socket: page.webSocketDebuggerUrl } : null;
}
