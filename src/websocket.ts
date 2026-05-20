// Using the global WebSocket type from Node
export interface CairoState {
  status: string;
  last_input: string;
  last_response: string;
  logs: Array<{ time: string; text: string }>;
  last_updated: string;
}

export const cairoState: CairoState = {
  status: 'offline',
  last_input: '',
  last_response: '',
  logs: [],
  last_updated: new Date().toISOString(),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const connectedClients: Set<any> = new Set();

export function broadcastState(): void {
  broadcastJson({ type: 'state', ...cairoState });
}

export function broadcastJson(payload: unknown): void {
  const message = JSON.stringify(payload);
  for (const client of connectedClients) {
    try {
      if (client.readyState === 1 /* OPEN */) {
        client.send(message);
      }
    } catch (err) {
      console.error('[WS] Failed to send to client:', err);
      connectedClients.delete(client);
    }
  }
}

export function updateState(
  status?: string,
  last_input?: string,
  last_response?: string
): void {
  if (status !== undefined) cairoState.status = status;
  if (last_input !== undefined) cairoState.last_input = last_input;
  if (last_response !== undefined) cairoState.last_response = last_response;
  cairoState.last_updated = new Date().toISOString();
}

export function addLog(message: string): void {
  const entry = { time: new Date().toISOString(), text: message };
  cairoState.logs.push(entry);
  if (cairoState.logs.length > 10) {
    cairoState.logs = cairoState.logs.slice(-10);
  }
  cairoState.last_updated = new Date().toISOString();
  broadcastState();
}

export const lastHeartbeat: { value: Date | null } = { value: null };

export function startHeartbeatMonitor(): void {
  setInterval(() => {
    if (!lastHeartbeat.value) return;
    const diff = Date.now() - lastHeartbeat.value.getTime();
    if (diff > 12000 && cairoState.status !== 'offline') {
      updateState('offline');
      broadcastState();
    }
  }, 5000);
}
