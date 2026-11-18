export const CALL_TARGET: RegExp;
export type DialInput = {
  caller: string;
  label: string;
  target: string | string[];
  human?: boolean;
  call_id?: string;
  reason?: string;
};
export type DialResult = {
  request: string;
  state: string;
  status?: string;
  call_id?: string;
  [key: string]: unknown;
};
export function openCallRequests(
  dir: string,
  options?: { now?: () => number },
): {
  close(): void;
  enqueue(input: DialInput): DialResult;
  pending(): (DialInput & { request: string })[];
  claim(): (DialInput & { request: string }) | null;
  settle(id: string, result: Record<string, unknown>): void;
  get(id: string, caller: string): DialResult | null;
};
