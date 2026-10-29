type HardwareErrorLike = {
  code?: unknown;
  errorCode?: unknown;
  message?: unknown;
};

function errorFields(reason: unknown): { code: string; message: string } {
  if (!reason || typeof reason !== 'object') {
    return {
      code: '',
      message: typeof reason === 'string' ? reason.trim() : '',
    };
  }
  const source = reason as HardwareErrorLike;
  const rawCode = source.errorCode ?? source.code;
  return {
    code: typeof rawCode === 'string' ? rawCode.trim().toLowerCase() : '',
    message: typeof source.message === 'string' ? source.message.trim() : '',
  };
}

/**
 * Expo wraps rejected native calls with implementation text such as
 * `Call to function ... has been rejected`. This boundary deliberately maps
 * stable codes and known outcomes instead of returning that wrapper to UI.
 */
export function hardwareUserMessage(
  reason: unknown,
  fallback = '外接录音设备暂时无法完成这项操作。',
): string {
  const { code, message } = errorFields(reason);
  const normalized = `${code} ${message}`.toLowerCase();

  if (code === 'device_storage_failed') return '录音设备未能保存录音，请检查存储卡。';
  if (code === 'device_audio_failed' || code === 'device_recording_interrupted') {
    return '录音设备录音中断，可重新录制。';
  }

  if (hardwareNeedsWifiSettings(reason)) return '无线网络已关闭。';
  if (code === 'wifi_transfer_interrupted' || /录音接收中断|录音设备的传输连接已断开/.test(message)) {
    return '录音接收中断，请重试。';
  }
  if (code === 'wifi_unavailable' || /未能连接录音设备的传输网络/.test(message)) {
    return '未能连接录音设备的传输网络。';
  }

  if (code === 'checksum_mismatch' || /checksum_mismatch|录音校验未通过/.test(normalized)) {
    return '录音校验未通过，请重新接收。';
  }
  if (code === 'resume_mismatch' || /设备录音已发生变化/.test(message)) {
    return '设备录音已变化，请刷新后重试。';
  }

  if (
    code === 'bluetooth_disabled'
    || /bluetooth[^\n]*(?:disabled|turned off)/i.test(message)
    || /蓝牙[^\n]*(?:尚未开启|未开启|已关闭)/.test(message)
  ) {
    return '请先开启蓝牙。';
  }
  if (code === 'bluetooth_unavailable') return '此手机暂时无法使用蓝牙。';
  if (
    code === 'bluetooth_permission_required'
    || code === 'permission_denied'
    || /(?:bluetooth|nearby)[^\n]*(?:permission|denied)/i.test(message)
  ) {
    return '请允许老记连接附近设备。';
  }
  if (code === 'bluetooth_scan_failed') return '暂时无法搜索附近设备。';
  if (code === 'incompatible' || /(协议|握手|端点|接口|身份信息|安全信息|能力信息)/.test(message)) {
    return '此设备与当前版本不兼容。';
  }
  if (/timeout|timed out|超时/i.test(normalized)) return '连接超时，请重试。';
  if (/storage|存储空间|保存位置/.test(normalized)) return '录音暂时无法保存，请检查本机存储空间。';
  if (/已断开|连接已中断|连接中断/.test(message)) return '设备连接已中断。';

  // Preserve concise app-authored Chinese outcomes, but never pass through a
  // bridge/provider wrapper or a mixed implementation message.
  const internal = /call to function|has been rejected|codedexception|native module|java\.|kotlin|expo/i;
  if (
    message.length <= 80
    && /[\u3400-\u9fff]/.test(message)
    && !/[A-Za-z]/.test(message)
    && !internal.test(message)
  ) {
    return message;
  }
  return fallback;
}

export function hardwareNeedsWifiSettings(reason: unknown): boolean {
  const { code, message } = errorFields(reason);
  return code === 'wifi_disabled' || /无线网络已关闭/.test(message);
}

/** A fresh, same-device durable connection error already has a visible owner.
 * Compare recognized public outcomes, not arbitrary wrapper strings or generic
 * fallbacks. A file/generation failure still needs its own operation dialog. */
export function hardwareConnectionOwnsError(
  reason: unknown,
  connection: {
    locator: string | null;
    updatedAtMs: number;
    errorCode: string | null;
    errorMessage: string | null;
  } | null,
  attempt: { locator: string | null; afterMs: number },
): boolean {
  if (!connection?.errorMessage || !attempt.locator || connection.locator !== attempt.locator
    || connection.updatedAtMs < attempt.afterMs) return false;
  const outcome = hardwareUserMessage(reason, '');
  return Boolean(outcome) && outcome === hardwareUserMessage({
    code: connection.errorCode, message: connection.errorMessage,
  }, '');
}
