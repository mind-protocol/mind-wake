export type DataMode = 'demo' | 'live';
export type ReadState = 'ready' | 'loading' | 'unavailable';
export type Signal = { label: string; value: string; detail: string; source: string; observedAt: string };
export type Creator = {
  username: string; name: string; initials: string; role: string; category: string;
  color: string; title: string; description: string; momentum: number; spark: number[];
  reasons: string[]; signals: Signal[]; tags: string[];
};
export type Position = {
  id: string; username: string; name: string; principal: string; returned: string;
  status: 'pending' | 'settled'; endsAt: string; activation: string | null;
  purchase: string | null; donations: string | null; proof: string | null;
};
export type Receipt = { id: string; title: string; detail: string; amount: string | null; at: string; status: 'confirmed' | 'pending' };
export type Snapshot = {
  schemaVersion: 1; mode: DataMode; network: 'solana-devnet'; observedAt: string;
  username: string; balance: string | null; creators: Creator[]; positions: Position[];
  receipts: Receipt[];
};
export type Draft = { id: string; username: string; name: string; amount: string; text: string; kind: 'gift'; savedAt: string };
