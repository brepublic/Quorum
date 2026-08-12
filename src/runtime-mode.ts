export type RuntimeMode = 'firebase' | 'self-hosted';

export function getRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === undefined || value === '' || value === 'firebase') return 'firebase';
  if (value === 'self-hosted') return 'self-hosted';
  throw new Error(`Unsupported VITE_RUNTIME_MODE: ${value}`);
}

export const runtimeMode = getRuntimeMode(import.meta.env.VITE_RUNTIME_MODE);
