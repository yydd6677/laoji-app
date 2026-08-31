import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  acknowledgeHardwareRecording,
  addHardwareLevelListener,
  addHardwareRecordingListener,
  addHardwareStateListener,
  connectHardwareUsb,
  connectHardwareBle,
  disconnectHardware,
  getHardwareState,
  hasNativeHardwareSupport,
  listHardwareUsbDevices,
  scanHardwareBleDevices,
  listPendingHardwareRecordings,
  listHardwareDeviceRecordings,
  pauseHardwareCapture,
  resumeHardwareCapture,
  receiveHardwareDeviceRecording,
  renameHardwareDeviceRecording,
  deleteHardwareDeviceRecording,
  requestHardwareUsbPermission,
  startHardwareCapture,
  stopHardwareCapture,
  type HardwareConnectionPhase,
  type HardwareConnectionState,
  type HardwareUsbDevice,
  type HardwareBleDevice,
  type HardwareDevice,
  type PendingHardwareRecording,
  type HardwareDeviceRecording,
} from 'laoji-native-platform';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsGroup, SettingsTitleBar } from '../components/SettingsGroup';
import { useAppDialog } from '../components/AppDialog';
import { useMeetingMediaImport } from '../components/MeetingMediaImportProvider';
import type { RootStackParamList } from '../types';
import { useTheme } from '../theme/ThemeProvider';
import { hardwareUserMessage } from '../services/hardwareUserMessages';

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
  const { tokens } = useTheme();
  const C = tokens.colors;
  const { showDialog } = useAppDialog();
  const { importHardwareRecording } = useMeetingMediaImport();
  const [state, setState] = useState<HardwareConnectionState | null>(null);
  const [devices, setDevices] = useState<HardwareUsbDevice[]>([]);
  const [bleDevices, setBleDevices] = useState<HardwareBleDevice[]>([]);
  const [recordings, setRecordings] = useState<PendingHardwareRecording[]>([]);
  const [deviceRecordings, setDeviceRecordings] = useState<HardwareDeviceRecording[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [level, setLevel] = useState(0);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const refresh = useCallback(async (quiet = false) => {
    if (!hasNativeHardwareSupport()) {
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const [nextState, nextDevices, nextRecordings] = await Promise.all([
        getHardwareState(),
        listHardwareUsbDevices(),
        listPendingHardwareRecordings(),
      ]);
      setState(nextState);
      setDevices(nextDevices);
      setRecordings(nextRecordings);
      if (['ready', 'paused'].includes(nextState.phase)) {
        setDeviceRecordings(await listHardwareDeviceRecordings());
      } else if (!['recording', 'finalizing', 'transferring'].includes(nextState.phase)) {
        setDeviceRecordings([]);
      }
    } catch (reason) {
      if (!quiet) {
        showDialog({ title: '无法读取设备', message: hardwareUserMessage(reason), tone: 'error' });
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [showDialog]);

  const scanWireless = useCallback(async (requestPermission: boolean) => {
    if (!hasNativeHardwareSupport() || Platform.OS !== 'android') return;
    let allowed = await hasNearbyDevicePermission();
    if (!allowed && requestPermission) allowed = await requestNearbyDevicePermission();
    if (!allowed) return;
    setScanning(true);
    try {
      setBleDevices(await scanHardwareBleDevices());
    } catch (reason) {
      if (requestPermission) {
        showDialog({ title: '无法搜索设备', message: hardwareUserMessage(reason), tone: 'error' });
      }
    } finally {
      setScanning(false);
    }
  }, [showDialog]);

  useFocusEffect(useCallback(() => {
    void refresh();
    void scanWireless(false);
    const timer = setInterval(() => { void refresh(true); }, 4_000);
    return () => clearInterval(timer);
  }, [refresh, scanWireless]));

  useEffect(() => {
    const stateSubscription = addHardwareStateListener(next => {
      setState(next);
      if (next.phase !== 'recording') setLevel(0);
    });
    const recordingSubscription = addHardwareRecordingListener(recording => {
      setRecordings(current => [
        recording,
        ...current.filter(item => item.recordingId !== recording.recordingId),
      ]);
    });
    const levelSubscription = addHardwareLevelListener(value => setLevel(value.normalized));
    return () => {
      stateSubscription.remove();
      recordingSubscription.remove();
      levelSubscription.remove();
    };
  }, []);

  const run = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await operation();
      await refresh(true);
    } catch (reason) {
      showDialog({ title: '操作未完成', message: hardwareUserMessage(reason), tone: 'error' });
    } finally {
      setBusy(null);
    }
  }, [busy, refresh, showDialog]);

  const connect = useCallback((device: HardwareDevice) => {
    void run(`connect:${device.locator}`, async () => {
      if (device.transport === 'ble') {
        const allowed = await hasNearbyDevicePermission() || await requestNearbyDevicePermission();
        if (!allowed) throw new Error('未允许老记连接附近设备。');
        await connectHardwareBle(device.locator);
        return;
      }
      if (!device.hasPermission) {
        const granted = await requestHardwareUsbPermission(device.locator);
        if (!granted) throw new Error('未允许老记访问这个 USB 录音设备。');
      }
      await connectHardwareUsb(device.locator);
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

  const receiveFromDevice = useCallback((recording: HardwareDeviceRecording) => {
    void run(`receive:${recording.recordingId}`, async () => {
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        const permission = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES;
        const allowed = await PermissionsAndroid.check(permission)
          || await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
        if (!allowed) throw new Error('未允许老记连接录音设备的传输网络。');
      } else if (Platform.OS === 'android' && Number(Platform.Version) >= 29) {
        const permission = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
        const allowed = await PermissionsAndroid.check(permission)
          || await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
        if (!allowed) throw new Error('未允许老记连接录音设备的传输网络。');
      }
      await receiveHardwareDeviceRecording(recording.recordingId, recording.generation);
    });
  }, [run]);

  const saveDeviceTitle = useCallback((recording: HardwareDeviceRecording) => {
    void run(`rename:${recording.recordingId}`, async () => {
      await renameHardwareDeviceRecording(recording.recordingId, recording.generation, renameTitle);
      setRenameTarget(null);
      setRenameTitle('');
    });
  }, [renameTitle, run]);

  const removeDeviceRecording = useCallback((recording: HardwareDeviceRecording) => {
    showDialog({
      title: '删除设备中的录音？',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: () => {
            void run(`device-delete:${recording.recordingId}`, async () => {
              await deleteHardwareDeviceRecording(recording.recordingId, recording.generation);
            });
          },
        },
        { text: '取消', role: 'cancel' },
      ],
    });
  }, [run, showDialog]);

  const discard = useCallback((recording: PendingHardwareRecording) => {
    showDialog({
      title: '删除这段外接录音？',
      message: '这段录音尚未加入会议记录，删除后无法恢复。',
      tone: 'danger',
      actions: [
        {
          text: '删除',
          role: 'destructive',
          onPress: () => {
            void run(`delete:${recording.recordingId}`, async () => {
              const removed = await acknowledgeHardwareRecording(recording.recordingId);
              if (!removed) throw new Error('录音暂时无法删除，请稍后重试。');
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
    () => [...devices, ...bleDevices].find(device => device.locator === state?.locator),
    [bleDevices, devices, state?.locator],
  );
  const allDevices = useMemo<HardwareDevice[]>(() => [...bleDevices, ...devices], [bleDevices, devices]);

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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.sectionLabel, { color: C.textCaption }]}>连接状态</Text>
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
                {state ? PHASE_LABEL[state.phase] : '正在读取状态'}
                {state?.phase === 'transferring' && state.transferProgress != null
                  ? ` ${Math.round(state.transferProgress * 100)}%`
                  : ''}
                {state?.errorMessage ? ` · ${hardwareUserMessage({
                  code: state.errorCode,
                  message: state.errorMessage,
                })}` : ''}
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
                <Text style={[styles.secondaryButtonText, { color: C.textTitle }]}>
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
                    <Text style={[styles.primaryButtonText, { color: C.onPrimary }]}>
                      {state?.phase === 'recording' ? '暂停' : state?.phase === 'paused' ? '继续' : '开始录音'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
          {state?.phase === 'recording' ? (
            <View style={[styles.levelTrack, { backgroundColor: C.primarySoft }]}>
              <View style={[styles.levelFill, { width: `${Math.max(2, level * 100)}%`, backgroundColor: C.primary }]} />
            </View>
          ) : null}
        </SettingsGroup>

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
                    {device.productName || 'USB 录音设备'}
                  </Text>
                  <Text style={[styles.deviceMeta, { color: C.textCaption }]} numberOfLines={1}>
                    {device.transport === 'ble' ? '无线' : 'USB'} · {device.compatible ? '可连接' : '待确认'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.compactButton, { backgroundColor: connected ? C.primarySoft : C.primary }]}
                  onPress={() => connect(device)}
                  disabled={Boolean(busy) || connected}
                  accessibilityRole="button"
                >
                  {itemBusy ? <ActivityIndicator size="small" color={C.onPrimary} /> : (
                    <Text style={[styles.compactButtonText, { color: connected ? C.primary : C.onPrimary }]}>
                      {connected ? '已连接' : device.transport === 'usb' && !device.hasPermission ? '授权连接' : '连接'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
        </SettingsGroup>

        {isConnected ? (
          <>
            <Text style={[styles.sectionLabel, { color: C.textCaption }]}>设备中的录音</Text>
            <SettingsGroup testID="hardware-device-recordings">
              {deviceRecordings.length === 0 ? (
                <View style={[styles.empty, { backgroundColor: C.backgroundFloat }]}>
                  <Text style={[styles.emptyTitle, { color: C.textTitle }]}>暂无录音</Text>
                </View>
              ) : deviceRecordings.map((recording, index) => {
                const localCopy = recordings.some(item => (
                  item.sourceDeviceRecordingId === recording.recordingId
                  && item.sourceGeneration === recording.generation
                ) || item.sessionId === recording.recordingId);
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
                          <Text style={[styles.recordingTitle, { color: C.textTitle }]} numberOfLines={1}>
                            {displayTitle}
                          </Text>
                          <Text style={[styles.recordingMeta, { color: C.textCaption }]} numberOfLines={1}>
                            {formatDuration(recording.durationMs)} · {formatBytes(recording.byteSize)}
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
                            <Text style={[styles.importButtonText, { color: localCopy ? C.primary : C.onPrimary }]}>
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

        <Text style={[styles.sectionLabel, { color: C.textCaption }]}>待加入会议的录音</Text>
        <SettingsGroup testID="hardware-pending-recordings">
          {recordings.length === 0 ? (
            <View style={[styles.empty, { backgroundColor: C.backgroundFloat }]}>
              <Text style={[styles.emptyTitle, { color: C.textTitle }]}>暂无待处理录音</Text>
            </View>
          ) : recordings.map((recording, index) => (
            <View
              key={recording.recordingId}
              style={[
                styles.recordingRow,
                { backgroundColor: C.backgroundFloat },
                index > 0 && { borderTopColor: C.divider, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
              <View style={styles.recordingCopy}>
                <Text style={[styles.recordingTitle, { color: C.textTitle }]} numberOfLines={1}>
                  {new Date(recording.recordedAtMs).toLocaleString('zh-CN', { hour12: false })}
                </Text>
                <Text style={[styles.recordingMeta, { color: C.textCaption }]} numberOfLines={1}>
                  {formatDuration(recording.durationMs)} · {formatBytes(recording.byteSize)}
                  {recording.interrupted ? ' · 中断后已保留' : ''}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => discard(recording)}
                disabled={Boolean(busy)}
                accessibilityRole="button"
                accessibilityLabel="删除待处理录音"
              >
                <Ionicons name="trash-outline" size={20} color={C.iconSecondary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.importButton, { backgroundColor: C.primary }]}
                onPress={() => {
                  if (!importHardwareRecording(recording)) {
                    showDialog({ title: '暂时无法导入', message: '请先完成当前正在进行的文件导入。', tone: 'warning' });
                  }
                }}
                disabled={Boolean(busy)}
                accessibilityRole="button"
              >
                <Text style={[styles.importButtonText, { color: C.onPrimary }]}>加入会议</Text>
              </TouchableOpacity>
            </View>
          ))}
        </SettingsGroup>

      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  headerAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 12, lineHeight: 18, marginTop: 18, marginHorizontal: 16, marginBottom: -4 },
  current: { minHeight: 76, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  deviceIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  currentCopy: { flex: 1, minWidth: 0, marginLeft: 12, marginRight: 8 },
  currentTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  currentStatus: { fontSize: 13, lineHeight: 19, marginTop: 3 },
  actionRow: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, flexDirection: 'row', gap: 10 },
  secondaryButton: { height: 40, minWidth: 88, paddingHorizontal: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 14, fontWeight: '500' },
  primaryButton: { flex: 1, height: 40, borderRadius: 8, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { fontSize: 14, fontWeight: '600' },
  levelTrack: { height: 4, overflow: 'hidden' },
  levelFill: { height: 4 },
  empty: { minHeight: 64, paddingHorizontal: 16, justifyContent: 'center' },
  emptyTitle: { fontSize: 15, lineHeight: 21, fontWeight: '500' },
  deviceRow: { minHeight: 68, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  deviceCopy: { flex: 1, minWidth: 0, marginRight: 12 },
  deviceName: { fontSize: 15, lineHeight: 21, fontWeight: '500' },
  deviceMeta: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  compactButton: { minWidth: 72, height: 34, borderRadius: 7, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  compactButtonText: { fontSize: 13, fontWeight: '600' },
  recordingRow: { minHeight: 72, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  recordingCopy: { flex: 1, minWidth: 0, marginRight: 4 },
  recordingTitle: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  recordingMeta: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  deviceRecordingBlock: { minHeight: 72, justifyContent: 'center' },
  renameRow: { minHeight: 72, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4 },
  renameInput: { flex: 1, height: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 11, fontSize: 14 },
  inlineAction: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  importButton: { height: 34, borderRadius: 7, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  importButtonText: { fontSize: 13, fontWeight: '600' },
});
