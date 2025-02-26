export class ReconnectingWebSocket {
  private url: string;
  private socket: WebSocket | null;
  private hasConnectedBefore: boolean;
  private reconnectAttempts: number;
  private maxReconnectAttempts: number;
  private reconnectInterval: number;
  private maxReconnectInterval: number;
  private reconnectTimeoutId: number | null;
  private visibilityChangeHandler: (event: Event) => void;

  public onopen: ((event: Event) => void) | null;
  public onclose: ((event: CloseEvent) => void) | null;
  public onreconnect: ((event: Event) => void) | null;
  public onmessage: ((event: MessageEvent) => void) | null;
  public onerror: ((event: Event) => void) | null;
  public ontimeout: ((event: CloseEvent) => void) | null;

  constructor(url: string) {
    this.url = url;
    this.socket = null;
    this.hasConnectedBefore = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 100;
    this.reconnectInterval = 1000;
    this.maxReconnectInterval = 30000;
    this.reconnectTimeoutId = null;

    this.onopen = null;
    this.onclose = null;
    this.onreconnect = null;
    this.onmessage = null;
    this.onerror = null;
    this.ontimeout = null;

    this.visibilityChangeHandler = this.handleVisibilityChange.bind(this);
    document.addEventListener("visibilitychange", this.visibilityChangeHandler);
  }

  connect() {
    if (document.hidden || this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    this.socket = new WebSocket(this.url);
    this.scheduleReconnect();

    this.socket.onopen = (event: Event) => {
      this.reconnectAttempts = 0;
      this.reconnectInterval = 1000;

      if (!this.hasConnectedBefore) {
        this.hasConnectedBefore = true;
        if (this.onopen) this.onopen(event);
      } else {
        if (this.onreconnect) this.onreconnect(event);
      }
    };

    this.socket.onclose = (event: CloseEvent) => {
      if (this.onclose) this.onclose(event);

      if (!document.hidden) {
        if (event.code === 1001) {
          // Away code = server idle timeout
          if (this.ontimeout) this.ontimeout(event);
        } else {
          this.scheduleReconnect();
        }
      }
    };

    this.socket.onmessage = (event: MessageEvent) => {
      if (this.onmessage) this.onmessage(event);
    };

    this.socket.onerror = (event: Event) => {
      if (this.onerror) this.onerror(event);
    };
  }

  private handleVisibilityChange() {
    if (!document.hidden && this.socket?.readyState !== WebSocket.OPEN) {
      this.reconnectAttempts = 0;
      this.reconnectInterval = 1000;
      this.connect();
    }
  }

  private scheduleReconnect() {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      document.hidden ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }

    const timeout = this.reconnectInterval;
    this.reconnectInterval = Math.min(
      this.reconnectInterval * 1.5,
      this.maxReconnectInterval,
    );
    this.reconnectAttempts++;

    this.reconnectTimeoutId = globalThis.setTimeout(
      () => this.connect(),
      timeout,
    );
  }

  public send(
    data: string | ArrayBufferLike | Blob | ArrayBufferView,
  ): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
      return true;
    }
    return false;
  }
}
