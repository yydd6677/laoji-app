import {
  isPlaceholderProductionHost,
  isSecureDeploymentMode,
  isSubmissionDeploymentMode,
  resolveDeploymentMode,
} from '../config/deploymentMode';

describe('deployment mode policy', () => {
  it('gives a production EAS profile precedence over APP_ENV', () => {
    expect(resolveDeploymentMode({
      APP_ENV: 'production-rehearsal',
      EAS_BUILD_PROFILE: 'production',
    })).toBe('production');
  });

  it('treats rehearsal as secure but not submit-ready', () => {
    expect(isSecureDeploymentMode('production-rehearsal')).toBe(true);
    expect(isSubmissionDeploymentMode('production-rehearsal')).toBe(false);
    expect(isSubmissionDeploymentMode('production')).toBe(true);
  });

  it.each([
    'api.example.com',
    'api.example.test',
    'api.internal',
    'api.home.arpa',
    'placeholder.release-domain.cn',
    'localhost',
  ])('recognizes a non-submittable host: %s', hostname => {
    expect(isPlaceholderProductionHost(hostname)).toBe(true);
  });

  it('does not classify an ordinary public-style domain as a placeholder', () => {
    expect(isPlaceholderProductionHost('api.release-domain.cn')).toBe(false);
  });
});
