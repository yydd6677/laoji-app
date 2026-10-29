import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  addHardwareRecordingListener,
  addHardwareStateListener,
  addHardwareRealtimeListener,
  listHardwareRealtimeSessions,
  connectHardwareBle,
  disconnectHardware,
  getHardwareState,
  hasNativeHardwareSupport,
  scanHardwareBleDevices,
  listPendingHardwareRecordings,
  listHardwareDeviceRecordings,
  getHardwareDeviceRecording,
  pauseHardwareCapture,
  resumeHardwareCapture,
  receiveHardwareDeviceRecording,
  renameHardwareDeviceRecording,
  deleteHardwareDeviceRecording,
  startHardwareCapture,
  stopHardwareCapture,
  type HardwareConnectionPhase,
  type HardwareConnectionState,
  type HardwareBleDevice,
  type PendingHardwareRecording,
  type HardwareRecordingPreview,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsGroup, SettingsTitleBar } from '../components/SettingsGroup';
import { HardwareRecordingLevel } from '../components/HardwareRecordingLevel';
import { useAppDialog } from '../components/AppDialog';
import type { RootStackParamList } from '../types';
import { useTheme } from '../theme/ThemeProvider';
import { hardwareConnectionOwnsError, hardwareNeedsWifiSettings, hardwareUserMessage } from '../services/hardwareUserMessages';
import { hasReceivedHardwareRecording } from '../services/hardwareRecordingIdentity';
import { hardwareDeviceRows, orderHardwareCatalog, type HardwareDeviceRow } from '../services/hardwareCatalogPresentation';
import { prewarmDeviceV2RealtimeRecording } from '../services/deviceV2Realtime';
import { sqliteMeetingNoteRepository } from '../data/repositories/sqliteMeetingNoteRepository';
import { receivedScheduleInputIds } from '../data/repositories/scheduleInputRepository';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'HardwareDevices'>;
};

const PHASE_LABEL: Record<HardwareConnectionPhase, string> = {
  disconnected: '未连接',
  discovered: '已发现设备',
  permission_required: '等待连接授权',
  connecting: '正在连接',
  handshaking: '正在核对设备',
  ready: '设备已就绪',
  recording: '正在录音',
  paused: '录音已暂停',
  finalizing: '正在保存录音',
  transferring: '正在接收录音',
  retryable_error: '连接已中断',
  incompatible: '设备不兼容',
};

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function hasNearbyDevicePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (Number(Platform.Version) >= 31) {
    const [scan, connect] = await Promise.all([
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN),
      PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT),
    ]);
    return scan && connect;
  }
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
}

async function requestNearbyDevicePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const permissions = Number(Platform.Version) >= 31
    ? [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const results = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every(permission => results[permission] === PermissionsAndroid.RESULTS.GRANTED);
}

export function HardwareDevicesScreen({ navigation }: Props) {
  const focused = useIsFocused();
  const { tokens, appearance } = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = useMemo(() => createStyles(appearance.fontFamily, fontScale), [appearance.fontFamily, fontScale]);
  const C = tokens.colors;
  const { showDialog } = useAppDialog();
  const [state, setState] = useState<HardwareConnectionState | null>(null);
  const [bleDevices, setBleDevices] = useState<HardwareBleDevice[]>([]);
  const [recordings, setRecordings] = useState<PendingHardwareRecording[]>([]);
  const [adoptedAssetIds, setAdoptedAssetIds] = useState<ReadonlySet<string>>(new Set());
  const [receivedInputs, setReceivedInputs] = useState<ReadonlySet<string>>(new Set());
  const [deviceRecordings, setDeviceRecordings] = useState<HardwareRecordingPreview[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveIssue, setLiveIssue] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const refreshing = useRef(false);
  const previousPhase = useRef<HardwareConnectionPhase | null>(null);
  const filesDirty = useRef(true);
  const recordingRevision = useRef(0);
  const scanInFlight = useRef(false);
  const scanGeneration = useRef(0);
  const currentPhase = useRef(state?.phase);
  const prewarmedAt = useRef(0);
  currentPhase.current = state?.phase;

  useEffect(() => {
    // Prepare only an explicit, connected hardware workflow. This opens no
    // microphone/ASR session, creates no meeting and sends no source audio.
    if (!focused || state?.phase !== 'ready' || !hasNativeHardwareSupport()
      || Date.now() - prewarmedAt.current < 60_000) return;
    prewarmedAt.current = Date.now();
    void prewarmDeviceV2RealtimeRecording().catch(() => undefined);
  }, [focused, state?.phase]);

  const refresh = useCallback(async (quiet = false, includeFiles = true) => {
    if (!hasNativeHardwareSupport()) {
      setLoading(false);
      return;
    }
    if (refreshing.current) return;
    refreshing.current = true;
    const revision = recordingRevision.current;
    if (!quiet) setLoading(true);
    try {
      // Read pending first: adoption commits the asset before deleting pending
      // media, so this order cannot observe a gap at that ownership handoff.
      const [nextState, nextRecordings] = await Promise.all([
        getHardwareState(),
        listPendingHardwareRecordings(),
      ]);
      const localAssetIds = await sqliteMeetingNoteRepository.listLocalRecordingAssetIds('guest');
      setReceivedInputs(new Set(await receivedScheduleInputIds()));
      setState(current => current && current.updatedAtMs > nextState.updatedAtMs ? current : nextState);
      if (revision === recordingRevision.current) {
        setRecordings(nextRecordings);
        setAdoptedAssetIds(new Set(localAssetIds));
      }
      if ((includeFiles || filesDirty.current) && nextState.phase === 'ready') {
        setFilesLoading(true);
        const entries = await listHardwareDeviceRecordings();
        const latest = await getHardwareState();
        if (latest.locator === nextState.locator && latest.phase === 'ready') {
          setDeviceRecordings(orderHardwareCatalog(entries));
          filesDirty.current = false;
        }
      } else if (!['ready', 'recording', 'paused', 'finalizing', 'transferring'].includes(nextState.phase)) {
        setDeviceRecordings([]);
      }
    } catch (reason) {
      if (!quiet) {
        showDialog({ title: '无法读取设备', message: hardwareUserMessage(reason), tone: 'error' });
      }
    } finally {
      refreshing.current = false;
      setFilesLoading(false);
      if (!quiet) setLoading(false);
    }
  }, [showDialog]);

  const scanWireless = useCallback(async (requestPermission: boolean) => {
    if (!hasNativeHardwareSupport() || Platform.OS !== 'android' || scanInFlight.current) return;
    scanInFlight.current = true;
    const generation = scanGeneration.current;
    try {
      if (!requestPermission) {
        const connection = await getHardwareState();
        if (generation !== scanGeneration.current
          || !['disconnected', 'discovered', 'retryable_error'].includes(connection.phase)) return;
      }
      let allowed = await hasNearbyDevicePermission();
      if (!allowed && requestPermission) allowed = await requestNearbyDevicePermission();
      if (!allowed || generation !== scanGeneration.current) return;
      setScanning(true);
      const devices = await scanHardwareBleDevices();
      if (generation === scanGeneration.current) setBleDevices(devices);
    } catch (reason) {
      if (requestPermission && generation === scanGeneration.current) {
        showDialog({ title: '无法搜索设备', message: hardwareUserMessage(reason), tone: 'error' });
      }
    } finally {
      scanInFlight.current = false;
      setScanning(false);
    }
  }, [showDialog]);

  useFocusEffect(useCallback(() => {
    scanGeneration.current += 1;
    void refresh();
    void scanWireless(false);
    const timer = setInterval(() => { void refresh(true, false); }, 4_000);
    const discovery = setInterval(() => {
      // A board powered on after page entry should appear without repeated
      // manual refreshes. Never scan behind a live connection or off-screen.
      if (!currentPhase.current || ['disconnected', 'discovered', 'retryable_error'].includes(currentPhase.current)) {
        void scanWireless(false);
      }
    }, 12_000);
    return () => {
      scanGeneration.current += 1;
      clearInterval(timer);
      clearInterval(discovery);
    };
  }, [refresh, scanWireless]));

  useEffect(() => {
    let active = true;
    const updateLiveText = () => {
      void listHardwareRealtimeSessions().then(sessions => {
        if (!active) return;
        const live = sessions.filter(item => !item.inputEnded).sort((a, b) => b.recordedAtMs - a.recordedAtMs)[0];
        setLiveText(live?.preview ?? '');
        setLiveIssue(Boolean(live && (live.hasGap || live.asrPhase === 'unavailable')));
      }).catch(() => {});
    };
    const realtimeSubscription = addHardwareRealtimeListener(updateLiveText);
    updateLiveText();
    const stateSubscription = addHardwareStateListener(next => {
      if (!['recording', 'paused'].includes(next.phase)) setLiveText('');
      setState(current => current && current.updatedAtMs > next.updatedAtMs ? current : next);
      if (next.phase === 'ready' && ['recording', 'finalizing', 'transferring'].includes(previousPhase.current || '')) {
        filesDirty.current = true;
        void refresh(true);
      }
      previousPhase.current = next.phase;
    });
    const recordingSubscription = addHardwareRecordingListener(recording => {
      recordingRevision.current += 1;
      setRecordings(current => [
        recording,
        ...current.filter(item => item.recordingId !== recording.recordingId),
      ]);
    });
    return () => {
      active = false;
      realtimeSubscription.remove();
      stateSubscription.remove();
      recordingSubscription.remove();
    };
  }, [refresh]);

  const run = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    const attempt = {
      locator: key.startsWith('connect:') ? key.slice('connect:'.length) : state?.locator ?? null,
      afterMs: Date.now(),
    };
    setBusy(key);
    filesDirty.current = true;
    try {
      await operation();
      // Catalog work must not hold recording, disconnect or local-import controls.
      void refresh(true);
    } catch (reason) {
      // The bridge event can precede the React render. Read its authoritative
      // outcome once; don't put the same connection failure in a modal too.
      const connection = await getHardwareState().catch(() => null);
      if (connection && hardwareConnectionOwnsError(reason, connection, attempt)) {
        setState(previous => !previous || connection.updatedAtMs >= previous.updatedAtMs ? connection : previous);
        return;
      }
      if (hardwareNeedsWifiSettings(reason)) {
        showDialog({
          title: '无线网络已关闭',
          tone: 'info',
          actions: [
            { text: '取消', role: 'cancel' },
            { text: '开启 WLAN', role: 'primary', onPress: async () => {
              try {
                // Android owns the toggle; do not enable radios or change the
                // user's network silently, and do not auto-retry on cancellation.
                try { await Linking.sendIntent('android.settings.panel.action.WIFI'); }
                catch { await Linking.sendIntent('android.settings.WIFI_SETTINGS'); }
              } catch {
                showDialog({ title: '无法打开无线网络设置', tone: 'error' });
              }
            } },
          ],
        });
      } else {
        showDialog({ title: '操作未完成', message: hardwareUserMessage(reason), tone: 'error' });
      }
    } finally {
      setBusy(null);
    }
  }, [busy, refresh, showDialog, state?.locator]);

  const connect = useCallback((device: HardwareDeviceRow) => {
    void run(`connect:${device.locator}`, async () => {
      const allowed = await hasNearbyDevicePermission() || await requestNearbyDevicePermission();
      if (!allowed) throw new Error('未允许老记连接附近设备。');
      await connectHardwareBle(device.locator);
    });
  }, [run]);

  const toggleCapture = useCallback(() => {
    if (!state) return;
    if (state.phase === 'recording') {
      void run('capture', async () => { await pauseHardwareCapture(); });
      return;
    }
    if (state.phase === 'paused') {
      void run('capture', async () => { await resumeHardwareCapture(); });
      return;
    }
    if (state.phase === 'ready') {
      void run('capture', async () => { await startHardwareCapture(); });
    }
  }, [run, state]);

  const stopCapture = useCallback(() => {
    void run('stop-capture', async () => { await stopHardwareCapture(); });
  }, [run]);

  const receiveFromDevice = useCallback((entry: HardwareRecordingPreview) => {
    void run(`receive:${entry.recordingId}`, async () => {
      const recording = await getHardwareDeviceRecording(entry);
      const needsWifi = recording.requiresWifi;
      if (needsWifi && Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        const permission = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES;
        const allowed = await PermissionsAndroid.check(permission)
          || await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
        if (!allowed) throw new Error('未允许老记连接录音设备的传输网络。');
      } else if (needsWifi && Platform.OS === 'android' && Number(Platform.Version) >= 29) {
        const permission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
        const allowed = await PermissionsAndroid.check(permission)
          || await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
        if (!allowed) throw new Error('未允许老记连接录音设备的传输网络。');
      }
      await receiveHardwareDeviceRecording(recording.recordingId, recording.generation);
    });
  }, [run]);

  const saveDeviceTitle = useCallback((entry: HardwareRecordingPreview) => {
    void run(`rename:${entry.recordingId}`, async () => {
      const recording = await getHardwareDeviceRecording(entry);
      await renameHardwareDeviceRecording(recording.recordingId, recording.generation, renameTitle);
      setRenameTarget(null);
      setRenameTitle('');
    });
  }, [renameTitle, run]);

  const removeDeviceRecording = useCallback((entry: HardwareRecordingPreview) => {
    showDialog({
      title: '删除设备中的录音？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: () => {
            void run(`device-delete:${entry.recordingId}`, async () => {
              const recording = await getHardwareDeviceRecording(entry);
              await deleteHardwareDeviceRecording(recording.recordingId, recording.generation);
            });
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [run, showDialog]);

  const isConnected = Boolean(state?.phase && ![
    'disconnected', 'discovered', 'permission_required', 'retryable_error', 'incompatible',
  ].includes(state.phase));
  const captureEnabled = ['ready', 'recording', 'paused'].includes(state?.phase ?? '');
  const statusTone = state?.phase === 'retryable_error' || state?.phase === 'incompatible'
    ? C.danger
    : ['ready', 'recording', 'paused'].includes(state?.phase ?? '')
      ? C.primary
      : C.textCaption;
  const connectedDevice = useMemo(
    () => bleDevices.find(device => device.locator === state?.locator),
    [bleDevices, state?.locator],
  );
  const allDevices = useMemo(() => hardwareDeviceRows(bleDevices, state)
    .filter(device => !isConnected || device.locator !== state?.locator), [bleDevices, state, isConnected]);

  return (
    <ScreenContainer edges={['top', 'bottom']} bg={C.backgroundBase}>
      <SettingsTitleBar
        title="外接录音设备"
        onBack={() => navigation.goBack()}
        trailing={(
          <TouchableOpacity
            style={styles.headerAction}
            onPress={() => {
              void refresh();
              void scanWireless(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="刷新外接设备"
            testID="hardware-refresh"
          >
            <Ionicons name="refresh" size={20} color={C.iconPrimary} />
          </TouchableOpacity>
        )}
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <SettingsGroup testID="hardware-current-group">
          <View style={[styles.current, { backgroundColor: C.backgroundFloat }]}>
            <View style={[styles.deviceIcon, { backgroundColor: C.primarySoft }]}>
              <Ionicons name="radio-outline" size={25} color={C.primary} />
            </View>
            <View style={styles.currentCopy}>
              <Text style={[styles.currentTitle, { color: C.textTitle }]} numberOfLines={1}>
                {state?.model || connectedDevice?.productName || '外接录音设备'}
              </Text>
              <Text style={[styles.currentStatus, { color: statusTone }]} numberOfLines={2}>
                {state?.errorMessage ? hardwareUserMessage({ code: state.errorCode, message: state.errorMessage })
                  : state?.purpose === 'schedule' && ['recording','paused','finalizing'].includes(state.phase)
                    ? state.phase === 'recording' ? '正在录入日程' : state.phase === 'paused' ? '日程录音已暂停' : '正在保存日程录音'
                    : state ? PHASE_LABEL[state.phase] : '正在读取状态'}
                {state?.phase === 'transferring' && state.transferProgress != null
                  ? ` ${Math.round(state.transferProgress * 100)}%`
                  : ''}
              </Text>
            </View>
            {loading || scanning ? <ActivityIndicator size="small" color={C.primary} /> : null}
          </View>
          {isConnected ? (
            <View style={[styles.actionRow, { borderTopColor: C.divider, backgroundColor: C.backgroundFloat }]}>
              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: C.divider }]}
                onPress={state?.phase === 'recording' || state?.phase === 'paused'
                  ? stopCapture
                  : () => { void run('disconnect', async () => { await disconnectHardware(); }); }}
                disabled={Boolean(busy) || state?.phase === 'finalizing' || state?.phase === 'transferring'}
                accessibilityRole="button"
              >
                <Text numberOfLines={1} style={[styles.secondaryButtonText, { color: C.textTitle }]}>
                  {state?.phase === 'recording' || state?.phase === 'paused' ? '结束' : '断开'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  { backgroundColor: captureEnabled ? C.primary : C.primaryLoading },
                ]}
                onPress={toggleCapture}
                disabled={Boolean(busy) || !captureEnabled}
                accessibilityRole="button"
                testID="hardware-capture-toggle"
              >
                {busy === 'capture' ? <ActivityIndicator size="small" color={C.onPrimary} /> : (
                  <>
                    <Ionicons
                      name={state?.phase === 'recording' ? 'pause' : state?.phase === 'paused' ? 'play' : 'mic'}
                      size={18}
                      color={C.onPrimary}
                    />
                    <Text numberOfLines={1} style={[styles.primaryButtonText, { color: C.onPrimary }]}>
                      {state?.phase === 'recording' ? '暂停' : state?.phase === 'paused' ? '继续' : '开始录音'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
          {state?.phase === 'recording' ? (
            <HardwareRecordingLevel sessionId={state.sessionId} foreground={focused}
              trackColor={C.primarySoft} fillColor={C.primary} />
          ) : null}
          {liveText && ['recording', 'paused'].includes(state?.phase ?? '') ? (
            <Text testID="hardware-live-transcript" numberOfLines={3} style={[styles.liveTranscript, { color: C.textTitle }]}>
              {liveText}
            </Text>
          ) : null}
          {liveIssue && ['recording', 'paused'].includes(state?.phase ?? '') ? (
            <Text style={[styles.liveIssue, { color: C.textCaption }]}>实时文字暂不可用</Text>
          ) : null}
        </SettingsGroup>

        {!isConnected || allDevices.length > 0 ? <>
        <Text style={[styles.sectionLabel, { color: C.textCaption }]}>可连接设备</Text>
        <SettingsGroup testID="hardware-device-list">
          {allDevices.length === 0 ? (
            <View style={[styles.empty, { backgroundColor: C.backgroundFloat }]}>
              <Text style={[styles.emptyTitle, { color: C.textTitle }]}>没有发现录音设备</Text>
            </View>
          ) : allDevices.map((device, index) => {
            const connected = state?.locator === device.locator && isConnected;
            const itemBusy = busy === `connect:${device.locator}`;
            return (
              <View
                key={device.locator}
                style={[
                  styles.deviceRow,
                  { backgroundColor: C.backgroundFloat },
                  index > 0 && { borderTopColor: C.divider, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <View style={styles.deviceCopy}>
                  <Text style={[styles.deviceName, { color: C.textTitle }]} numberOfLines={1}>
                    {device.productName || '录音设备'}
                  </Text>
                  {!connected ? (
                    <Text style={[styles.deviceMeta, { color: C.textCaption }]} numberOfLines={1}>
                      {device.compatible ? '可连接' : '待确认'}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  style={[styles.compactButton, { backgroundColor: connected ? C.primarySoft : C.primary }]}
                  onPress={() => connect(device)}
                  disabled={Boolean(busy) || connected}
                  accessibilityRole="button"
                >
                  {itemBusy ? <ActivityIndicator size="small" color={C.onPrimary} /> : (
                    <Text numberOfLines={1} style={[styles.compactButtonText, { color: connected ? C.primary : C.onPrimary }]}>
                      {connected ? '已连接' : '连接'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </SettingsGroup>
        </> : null}

        {isConnected ? (
          <>
            <Text style={[styles.sectionLabel, { color: C.textCaption }]}>设备中的录音</Text>
            <SettingsGroup testID="hardware-device-recordings">
              {deviceRecordings.length === 0 ? (
                <View style={[styles.empty, { backgroundColor: C.backgroundFloat }]}>
                  {filesLoading ? <ActivityIndicator color={C.primary} />
                    : <Text style={[styles.emptyTitle, { color: C.textTitle }]}>暂无录音</Text>}
                </View>
              ) : deviceRecordings.map((recording, index) => {
                const localCopy = hasReceivedHardwareRecording(recordings, state?.deviceId, recording, adoptedAssetIds)
                  || Boolean(recording.captureId && receivedInputs.has(`capture:${state?.deviceId}:${recording.captureId}`));
                const receiving = busy === `receive:${recording.recordingId}`;
                const renaming = renameTarget === recording.recordingId;
                const dateLabel = recording.createdEpochMs
                  ? new Date(recording.createdEpochMs).toLocaleString('zh-CN', { hour12: false })
                  : '设备录音';
                const displayTitle = recording.title?.trim() || dateLabel;
                return (
                  <View
                    key={`${recording.recordingId}:${recording.generation}`}
                    style={[
                      styles.deviceRecordingBlock,
                      { backgroundColor: C.backgroundFloat },
                      index > 0 && { borderTopColor: C.divider, borderTopWidth: StyleSheet.hairlineWidth },
                    ]}
                  >
                    {renaming ? (
                      <View style={styles.renameRow}>
                        <TextInput
                          style={[styles.renameInput, { color: C.textTitle, borderColor: C.divider }]}
                          value={renameTitle}
                          onChangeText={setRenameTitle}
                          maxLength={120}
                          autoFocus
                          placeholder="录音标题"
                          placeholderTextColor={C.textCaption}
                          returnKeyType="done"
                          onSubmitEditing={() => saveDeviceTitle(recording)}
                        />
                        <TouchableOpacity
                          style={styles.inlineAction}
                          onPress={() => { setRenameTarget(null); setRenameTitle(''); }}
                          accessibilityLabel="取消重命名"
                        >
                          <Ionicons name="close" size={20} color={C.iconSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.inlineAction}
                          onPress={() => saveDeviceTitle(recording)}
                          accessibilityLabel="保存录音标题"
                        >
                          <Ionicons name="checkmark" size={20} color={C.primary} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.recordingRow}>
                        <View style={styles.recordingCopy}>
                          <Text style={[styles.recordingTitle, { color: C.textTitle }]} numberOfLines={2}>
                            {displayTitle}
                          </Text>
                          <Text style={[styles.recordingMeta, { color: C.textCaption }]} numberOfLines={1}>
                            {recording.durationMs != null && recording.byteSize != null
                              ? `${formatDuration(recording.durationMs)} · ${formatBytes(recording.byteSize)}` : dateLabel}
                            {recording.recovered ? ' · 已恢复' : ''}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={styles.iconButton}
                          onPress={() => { setRenameTarget(recording.recordingId); setRenameTitle(displayTitle); }}
                          disabled={Boolean(busy)}
                          accessibilityLabel="重命名设备录音"
                        >
                          <Ionicons name="pencil-outline" size={19} color={C.iconSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.iconButton}
                          onPress={() => removeDeviceRecording(recording)}
                          disabled={Boolean(busy)}
                          accessibilityLabel="删除设备录音"
                        >
                          <Ionicons name="trash-outline" size={19} color={C.iconSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.importButton,
                            { backgroundColor: localCopy ? C.primarySoft : C.primary },
                          ]}
                          onPress={() => receiveFromDevice(recording)}
                          disabled={Boolean(busy) || localCopy}
                          accessibilityRole="button"
                        >
                          {receiving ? <ActivityIndicator size="small" color={C.onPrimary} /> : (
                            <Text numberOfLines={1} style={[styles.importButtonText, { color: localCopy ? C.primary : C.onPrimary }]}>
                              {localCopy ? '已接收' : '接收'}
                            </Text>
                          )}
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                );
              })}
            </SettingsGroup>
          </>
        ) : null}

      </ScrollView>
    </ScreenContainer>
  );
}

const createStyles = (fontFamily: string, fontScale = 1) => {
  // Keep room for native CJK pixel rounding instead of tight intrinsic boxes.
  const labelWidth = (characters: number, size: number) => Math.ceil(characters * size * fontScale) + 4;
  const compactHeight = Math.max(34, Math.ceil(20 * fontScale) + 8);
  const captureHeight = Math.max(40, Math.ceil(20 * fontScale) + 8);
  return StyleSheet.create({
  liveTranscript: { fontFamily, fontSize: 16, lineHeight: 24, padding: 16, minHeight: 104, includeFontPadding: false },
  liveIssue: { fontFamily, fontSize: 13, lineHeight: 20, paddingHorizontal: 16, paddingBottom: 12, includeFontPadding: false },
  content: { paddingBottom: 32 },
  headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontFamily, fontSize: 12, lineHeight: 18, marginTop: 18, marginHorizontal: 16, marginBottom: -4 },
  current: { minHeight: 76, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  deviceIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  currentCopy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
  currentTitle: { fontFamily, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  currentStatus: { fontFamily, fontSize: 13, lineHeight: 19, marginTop: 3 },
  actionRow: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, flexDirection: 'row', gap: 10 },
  secondaryButton: { height: captureHeight, minWidth: 88, paddingHorizontal: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { minWidth: labelWidth(2, 14), textAlign: 'center', fontFamily, fontSize: 14, lineHeight: 20, includeFontPadding: false, fontWeight: '500' },
  primaryButton: { flex: 1, height: captureHeight, borderRadius: 8, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { minWidth: labelWidth(4, 14), textAlign: 'center', fontFamily, fontSize: 14, lineHeight: 20, includeFontPadding: false, fontWeight: '600' },
  empty: { minHeight: 64, paddingHorizontal: 16, justifyContent: 'center' },
  emptyTitle: { fontFamily, fontSize: 15, lineHeight: 21, fontWeight: '500' },
  deviceRow: { minHeight: 68, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  deviceCopy: { flex: 1, minWidth: 0, marginRight: 12 },
  deviceName: { fontFamily, fontSize: 15, lineHeight: 21, fontWeight: '500' },
  deviceMeta: { fontFamily, fontSize: 12, lineHeight: 18, marginTop: 3 },
  compactButton: { minWidth: Math.max(72, labelWidth(3, 13) + 24), height: compactHeight, borderRadius: 7, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  compactButtonText: { minWidth: labelWidth(3, 13), textAlign: 'center', fontFamily, fontSize: 13, lineHeight: 20, includeFontPadding: false, fontWeight: '600' },
  recordingRow: { minHeight: 72, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  recordingCopy: { flex: 1, minWidth: 0, marginRight: 4 },
  recordingTitle: { fontFamily, fontSize: 14, lineHeight: 20, fontWeight: '500' },
  recordingMeta: { fontFamily, fontSize: 12, lineHeight: 18, marginTop: 3 },
  deviceRecordingBlock: { minHeight: 72, justifyContent: 'center' },
  renameRow: { minHeight: 72, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4 },
  renameInput: { flex: 1, height: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 11, paddingVertical: 0, fontFamily, fontSize: 14, includeFontPadding: false, textAlignVertical: 'center' },
  inlineAction: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  importButton: { height: compactHeight, minWidth: Math.max(64, labelWidth(4, 13) + 24), flexShrink: 0, borderRadius: 7, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  importButtonText: { minWidth: labelWidth(4, 13), textAlign: 'center', fontFamily, fontSize: 13, lineHeight: 20, includeFontPadding: false, fontWeight: '600' },
});
};
