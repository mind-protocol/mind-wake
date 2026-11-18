export function runPontSettings(dataDir: string, input: string): Promise<{ exitCode: number; stdout: string }>;
export function pontAction(dataDir: string, action: string, payload?: Record<string, unknown>): Promise<unknown>;
export function pontStatus(dataDir: string): Record<string, unknown>;
