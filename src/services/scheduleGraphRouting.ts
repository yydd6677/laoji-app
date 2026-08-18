/**
 * Admission policy for the isolated MentionGraph candidate.
 *
 * The local parser may still classify an input, but it must not become a
 * second semantic owner for complex creation or clarification once the
 * candidate is available. Read-only/operation intents remain outside this
 * path and are not admitted as model-created event drafts here.
 */

export type ScheduleGraphAdmissionRoute = 'local_safe' | 'server_required' | 'clarify' | 'reject';
export type ScheduleGraphAdmissionIntent = 'create' | 'clarify' | 'query' | 'delete' | 'reject';

export interface ScheduleGraphAdmissionInput {
  featureEnabled: boolean;
  capabilityEnabled: boolean;
  route: ScheduleGraphAdmissionRoute;
  intent: ScheduleGraphAdmissionIntent;
}

export function isScheduleGraphCandidateRequest(
  input: Omit<ScheduleGraphAdmissionInput, 'capabilityEnabled'>,
): boolean {
  if (!input.featureEnabled) return false;
  if (input.intent !== 'create' && input.intent !== 'clarify') return false;
  return input.route === 'server_required' || input.route === 'clarify';
}

export function shouldUseScheduleGraphCandidate(input: ScheduleGraphAdmissionInput): boolean {
  return input.capabilityEnabled && isScheduleGraphCandidateRequest(input);
}
