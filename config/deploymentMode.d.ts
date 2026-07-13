export const PRODUCTION: 'production';
export const PRODUCTION_REHEARSAL: 'production-rehearsal';

export function resolveDeploymentMode(
  env?: Record<string, string | undefined>,
): string;

export function isSecureDeploymentMode(mode: string): boolean;
export function isSubmissionDeploymentMode(mode: string): boolean;
export function isPlaceholderProductionHost(hostname: string): boolean;
