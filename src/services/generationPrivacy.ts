import { deviceV2Request } from './deviceV2Api';

type RetentionPreference = { schema_version: 2; enabled: boolean; revision: number };

function enabledFrom(value: RetentionPreference): boolean {
  if (value?.schema_version !== 2 || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('生成结果保留设置响应无效');
  }
  return value.enabled;
}

// The server owns permission. Never revive the former local-only opt-in or
// report a successful change before the authenticated server confirms it.
export async function loadGenerationRetentionPreference(): Promise<boolean> {
  return enabledFrom(await deviceV2Request<RetentionPreference>(
    '/privacy/generated-results', {}, '暂时无法读取保留设置',
  ));
}

export async function saveGenerationRetentionPreference(enabled: boolean): Promise<boolean> {
  const result = enabledFrom(await deviceV2Request<RetentionPreference>(
    '/privacy/generated-results', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }, '保留设置未保存',
  ));
  if (result !== enabled) throw new Error('保留设置未确认');
  return result;
}
