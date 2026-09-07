export type DesktopBridge = {
  onVoiceCommand(callback: (command: string) => void): () => void;
  setVoiceState(state: { joined: boolean; muted: boolean; deafened: boolean }): void;
};
declare global {
  interface Window { nexusDesktop?: DesktopBridge }
}
