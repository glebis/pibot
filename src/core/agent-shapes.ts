/** Structural shape the command layer needs from agents (PiBot passes real LoadedAgents). */
export interface LoadedAgentShape {
  id: string;
  dir: string;
  manifest: {
    name: string;
    description?: string;
    model?: string;
    thinking?: string;
    heartbeat?: { enabled?: boolean; interval?: string; model?: string; quietHours?: { from: string; to: string } };
    evolution?: { enabled?: boolean; interval?: string; model?: string };
  };
}