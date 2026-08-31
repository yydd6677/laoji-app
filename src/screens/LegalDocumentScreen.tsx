import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsGroup, SettingsRow, SettingsTitleBar } from '../components/SettingsGroup';
import { RootStackParamList } from '../types';
import { getApiConfig } from '../services/config';
import { useAppDialog } from '../components/AppDialog';
import { UI_DIMENSIONS, getUiTokens } from '../theme/uiTokens';
import {
  checkForAppUpdate,
  appUpdateUserMessage,
  currentVersionCode,
  downloadAndInstallAppUpdate,
  useAppUpdate,
} from '../services/appUpdate';
import { openApkInstallSettings } from 'laoji-native-platform';

const { colors: F } = getUiTokens();

// UI-SHELL-001 / UI-TOKENS-001: legal documents use the same title and semantic text hierarchy.

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Legal'>;
  route: RouteProp<RootStackParamList, 'Legal'>;
};

const APP_VERSION = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '未知';
const APP_BUILD_NUMBER = currentVersionCode();

const DOCS: Record<RootStackParamList['Legal']['kind'], {
  title: string;
  updated: string;
  sections: { heading: string; body: string; linkLabel?: string; linkUrl?: string }[];
}> = {
  terms: {
    title: '用户协议',
    updated: '2026-08-16',
    sections: [
      { heading: '服务范围', body: '老记提供本机日程管理、文字或语音创建日程、会议录音与文件导入、文字记录、整理、会议问答、讲话人和标签等功能。需要识别或生成的任务会连接老记服务完成。' },
      { heading: '本机使用', body: '当前版本不要求注册或登录。日程、会议索引、原始录音、笔记和主要结果以当前设备为准；卸载应用、清除应用存储或设备损坏可能使这些资料无法恢复。' },
      { heading: '录音责任', body: '录制、导入或分享会议前，你应取得必要授权，并保证相关内容不侵犯他人隐私、知识产权或工作权限。' },
      { heading: '结果使用', body: '语音识别、整理和问答可能存在遗漏或误差。涉及重要日期、金额、责任人或决定时，应结合文字记录和原始录音核对后使用。' },
      { heading: '服务可用性', body: '网络、设备状态、服务器维护或第三方基础设施可能使在线处理暂时不可用。本机已有日程和已保存的会议内容仍可查看，未完成任务可在服务恢复后继续。' },
      { heading: '删除与更新', body: '会议删除后进入回收站，只有在回收站中才会永久删除；日程可直接删除。设置中的清除本机数据会删除当前设备资料，并尝试清理对应的设备服务数据。' },
    ],
  },
  privacy: {
    title: '隐私政策',
    updated: '2026-08-16',
    sections: [
      { heading: '本机资料', body: '日程、提醒、会议索引、原始录音、我的笔记、文字记录、整理结果、问答记录、标签和讲话人名称主要保存在当前设备。老记不以账号云盘方式长期保存这些资料。' },
      { heading: '在线处理', body: '日程语音和会议音频会在需要识别时发送到老记服务；整理会使用当前文字记录和我的笔记，会议问答也会将它们作为可引用来源。导入视频时，手机先提取音频，再上传用于转写。' },
      { heading: '临时音频', body: '待处理音频可能通过受控对象存储直接传输，并按临时对象清理规则删除。它只用于完成转写和任务恢复，不作为长期会议资料库。手机中的原始录音不会因此被覆盖。' },
      { heading: '生成结果保留', body: '转写和生成结果会回到本机保存。关闭“保留匿名生成结果”时，问答等生成任务默认按临时方式处理；开启后，服务可在设备隔离的数据域内保留匿名结果，用于恢复任务和质量评估。' },
      { heading: '讲话人声纹', body: '你可以主动创建讲话人并录制一段朗读音频，用于在会议转写中辅助区分讲话人。只有在录入页单独勾选同意并点击保存后，讲话人名称和本次 WAV 录音才会上传到声纹服务。你可以重新录制、放弃上传，或在讲话人管理中删除已保存的讲话人资料。' },
      { heading: '本机权限', body: '麦克风用于语音日程和会议录音；文件访问用于选择导入资料；通知用于日程提醒和录音状态；位置用于填写地址；系统验证用于启动保护；安装权限仅在你确认应用更新时使用。未授权的能力不会在后台自行启用。' },
      { heading: '存储与同步', body: '日程和会议操作直接写入本机数据库，不通过云端同步。通知提醒由当前设备本机调度；跨设备同步和账号迁移不在当前版本提供。' },
      { heading: '你的控制权', body: '你可以编辑或删除日程、会议、笔记、标签和讲话人资料，选择是否保留匿名生成结果，也可以清除本机数据。分享内容和接收方由你在分享前确认。' },
      { heading: '安全边界', body: '在线通信使用 HTTPS 或 WSS。每台设备使用独立凭据和数据域；日志不记录会议正文、笔记正文、原始坐标或访问密钥。' },
    ],
  },
  help: {
    title: '帮助中心',
    updated: '2026-08-16',
    sections: [
      { heading: '日程', body: '在日程页长按右下角新建按钮可选择语音或手动新建。日期是日程保存的必要信息，标题和具体钟点可以留空；解析不完整时只需补充缺少的内容。' },
      { heading: '录音与导入', body: '会议可来自实时录音，也可导入 WAV、M4A、MP3、MP4、WebM 等常见音视频。详情页会区分准备、上传、转写和整理状态，处理期间可以离开页面。' },
      { heading: '文字与整理', body: '转写处理中会逐步出现可读文字，完成后再确定讲话人与最终段落。整理会同时参考文字记录和当前我的笔记；切换整理模板不会重新上传或生成。' },
      { heading: '会议问答', body: '会议问答使用当前文字记录、已有整理结果和我的笔记。回答下方的引用可展开并跳回对应来源；会议内容发生变化后会自动开始一份新的问答记录。' },
      { heading: '标签与查找', body: '可从会议页的分类查看进入标签页，并在右上角管理标签。搜索可以查找标题、标签、我的笔记、文字记录、整理结果和事项。' },
      { heading: '删除与恢复', body: '长按会议记录可以删除，删除后的记录在回收站中保留一段时间；只有回收站提供永久删除。' },
      { heading: '更新应用', body: '在版本信息中可以检查并下载新版本。安装前系统会再次要求确认；首次使用时可能需要允许老记安装更新。' },
    ],
  },
  guide: {
    title: '使用指南',
    updated: '2026-08-16',
    sections: [
      { heading: '安排一天', body: '用语音或文字建立日程后，可在月视图快速浏览日期，在日视图查看时间顺序，并按需补充地点、备注和提醒。' },
      { heading: '记录会议', body: '需要现场记录时直接开始录音；已有音视频则使用导入。转写过程中可以先阅读已完成片段，最终结果完成后再生成整理和进行问答。' },
      { heading: '核对结果', body: '整理、行动候选和问答都应结合引用核对。我的笔记会作为补充来源，但与文字记录冲突时不会自动替你作出最终判断。' },
      { heading: '管理资料', body: '使用标签整理会议，使用搜索定位内容；不再需要的会议先移到回收站。当前版本以本机为主，不提供跨设备同步。' },
    ],
  },
  version: {
    title: '版本信息',
    updated: '2026-07-08',
    sections: [],
  },
  contact: {
    title: '联系我们',
    updated: '2026-08-16',
    sections: [
      {
        heading: '反馈渠道',
        body: '请附上发生时间、操作步骤、网络环境和截图；不要公开设备凭据、访问令牌或原始私密会议内容。',
        linkLabel: '打开 GitHub Issues',
        linkUrl: 'https://github.com/yydd6677/laoji-app/issues',
      },
    ],
  },
};

export function LegalDocumentScreen({ navigation, route }: Props) {
  const doc = DOCS[route.params.kind];
  const config = getApiConfig();
  const { showDialog } = useAppDialog();
  const update = useAppUpdate();
  const openExternalLink = async (url: string) => {
    try {
      if (!(await Linking.canOpenURL(url))) throw new Error('unsupported URL');
      await Linking.openURL(url);
    } catch {
      showDialog({
        title: '无法打开链接',
        message: '系统浏览器不可用，或链接暂时无法访问。请检查网络和默认浏览器后重试。',
        tone: 'error',
      });
    }
  };
  const onlineLinks = route.params.kind === 'privacy'
    ? [{ label: '打开公开隐私政策', url: config.privacyPolicyUrl, icon: 'open-outline' as const }]
    : route.params.kind === 'terms'
      ? [{ label: '打开公开用户协议', url: config.termsOfServiceUrl, icon: 'open-outline' as const }]
      : [];
  if (route.params.kind === 'version') {
    const checkUpdate = async () => {
      await checkForAppUpdate({ manual: true });
    };
    const installUpdate = async () => {
      try {
        await downloadAndInstallAppUpdate();
      } catch (error) {
        showDialog({
          title: '更新失败',
          message: appUpdateUserMessage(error),
          tone: 'error',
          actions: appUpdateUserMessage(error).includes('允许老记安装')
            ? [
              { text: '去设置', role: 'primary', onPress: () => { openApkInstallSettings(); } },
              { text: '取消', role: 'cancel' },
            ]
            : undefined,
        });
      }
    };
    const downloadPercent = update.status === 'downloading' && update.progress !== null
      ? Math.round(update.progress * 100)
      : null;
    const hasNewerManifest = Boolean(
      update.manifest && update.manifest.version_code > APP_BUILD_NUMBER,
    );
    const showUpdateNotice = hasNewerManifest && [
      'available',
      'downloading',
      'ready_to_install',
      'failed',
    ].includes(update.status);
    const checkLabel = update.status === 'checking'
      ? '正在检查'
      : update.status === 'failed'
        ? '重试检查'
        : '检查更新';
    const updateValue = update.status === 'up_to_date'
      ? '已是最新版本'
      : undefined;
    const noticeActionLabel = update.status === 'downloading'
      ? downloadPercent === null ? '正在下载' : `正在下载 ${downloadPercent}%`
      : update.status === 'ready_to_install'
        ? '安装更新'
        : update.status === 'failed'
          ? '重试下载'
          : '下载并安装';
    return (
      <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
        <SettingsTitleBar title="版本信息" onBack={() => navigation.goBack()} />
        <ScrollView style={s.scroll} contentContainerStyle={s.aboutContent} showsVerticalScrollIndicator={false}>
          <View style={s.aboutBrand}>
            <View style={s.aboutLogo} testID="legal-about-logo">
              <Ionicons name="calendar-clear-outline" size={32} color={F.onPrimary} />
            </View>
            <Text style={s.aboutVersionLine} numberOfLines={1} testID="legal-about-version">
              {`老记 ${APP_VERSION}`}
            </Text>
          </View>

          <SettingsGroup testID="legal-about-group">
            <SettingsRow label="构建编号" value={String(APP_BUILD_NUMBER || '未知')} />
            {!showUpdateNotice ? (
              <SettingsRow
                label={checkLabel}
                value={updateValue}
                onPress={update.status === 'checking' ? undefined : checkUpdate}
                disabled={update.status === 'checking'}
                last
                testID="legal-check-update"
              />
            ) : null}
          </SettingsGroup>

          {showUpdateNotice && update.manifest ? (
            <View style={s.updateNotice} testID="legal-update-available">
              <Text style={s.updateTitle}>发现新版本 {update.manifest.version_name}</Text>
              {update.manifest.release_notes.length ? (
                <Text style={s.updateNotes}>{update.manifest.release_notes.join('；')}</Text>
              ) : null}
              {update.status === 'failed' && update.message ? (
                <Text style={s.updateError}>{update.message}</Text>
              ) : null}
              <TouchableOpacity
                style={[s.updateButton, update.status === 'downloading' && s.updateButtonDisabled]}
                onPress={installUpdate}
                disabled={update.status === 'downloading'}
                accessibilityRole="button"
                accessibilityLabel={noticeActionLabel}
                testID="legal-update-install"
              >
                <Ionicons name="download-outline" size={18} color={F.onPrimary} />
                <Text style={s.updateButtonText}>{noticeActionLabel}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {update.message && update.status === 'failed' && !showUpdateNotice ? (
            <Text style={s.updateMessage} testID="legal-update-message">{update.message}</Text>
          ) : null}

        </ScrollView>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer bg={F.backgroundBody} edges={['top', 'bottom']}>
      <SettingsTitleBar title={doc.title} onBack={() => navigation.goBack()} />
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.articleContent}
        showsVerticalScrollIndicator={false}
        testID="legal-article"
      >
        <Text style={s.updated} testID="legal-updated">更新日期：{doc.updated}</Text>
        {doc.sections.map((section, index) => (
          <View key={section.heading} style={[s.section, index === 0 && s.firstSection]}>
            <Text style={s.heading}>{section.heading}</Text>
            <Text style={s.body}>{section.body}</Text>
            {section.linkLabel && section.linkUrl ? (
              <TouchableOpacity
                style={s.documentLink}
                onPress={() => { void openExternalLink(section.linkUrl!); }}
                accessibilityRole="link"
                accessibilityLabel={section.linkLabel}
              >
                <Ionicons name="open-outline" size={16} color={F.primary} />
                <Text style={s.linkText}>{section.linkLabel}</Text>
                <Ionicons name="chevron-forward" size={16} color={F.iconTertiary} />
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
        {onlineLinks.length ? (
          <View style={s.onlineActions}>
            {onlineLinks.map(link => (
              <TouchableOpacity
                key={link.label}
                style={s.documentLink}
                onPress={() => { void openExternalLink(link.url); }}
                accessibilityRole="link"
                accessibilityLabel={link.label}
              >
                <Ionicons name={link.icon} size={16} color={F.primary} />
                <Text style={s.linkText}>{link.label}</Text>
                <Ionicons name="chevron-forward" size={16} color={F.iconTertiary} />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  articleContent: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 36, backgroundColor: F.backgroundBody },
  updated: { fontSize: 12, lineHeight: 18, color: F.textCaption },
  section: { marginTop: 24 },
  firstSection: { marginTop: 20 },
  heading: { fontSize: 17, lineHeight: 24, color: F.textTitle, fontWeight: '600', marginBottom: 8 },
  body: { fontSize: 14, color: F.textCaption, lineHeight: 24 },
  documentLink: { minHeight: 52, marginTop: 12, borderTopWidth: UI_DIMENSIONS.divider, borderTopColor: F.divider, flexDirection: 'row', alignItems: 'center', gap: 8 },
  linkText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: F.textLink },
  onlineActions: { marginTop: 24 },
  onlineDangerText: { color: F.danger },
  aboutContent: { paddingBottom: 32 },
  aboutBrand: { alignItems: 'center' },
  aboutLogo: { width: 72, height: 72, marginTop: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: F.primary },
  aboutVersionLine: { width: '100%', minHeight: 44, marginTop: 2, marginBottom: 9, paddingVertical: 8, fontSize: 20, lineHeight: 28, fontWeight: '600', textAlign: 'center', color: F.textTitle },
  updateNotice: { marginHorizontal: 16, marginTop: 16, padding: 16, borderRadius: 8, backgroundColor: F.primarySoft },
  updateTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600', color: F.textTitle },
  updateNotes: { marginTop: 6, fontSize: 14, lineHeight: 21, color: F.textCaption },
  updateError: { marginTop: 8, fontSize: 13, lineHeight: 19, color: F.danger },
  updateButton: { minHeight: 40, marginTop: 14, paddingHorizontal: 14, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: F.primary },
  updateButtonDisabled: { opacity: 0.62 },
  updateButtonText: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: F.onPrimary },
  updateMessage: { marginHorizontal: 16, marginTop: 14, fontSize: 13, lineHeight: 19, color: F.textCaption },
});
