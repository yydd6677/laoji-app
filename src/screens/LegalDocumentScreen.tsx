import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import { SettingsGroup, SettingsRow, SettingsTitleBar } from '../components/SettingsGroup';
import { RootStackParamList } from '../types';
import { getApiConfig } from '../services/config';
import { useAppDialog } from '../components/AppDialog';
import { FEISHU_DIMENSIONS, getFeishuTokens } from '../theme/feishuTokens';

const { colors: F } = getFeishuTokens();

// UI-SHELL-001 / UI-TOKENS-001: legal documents use the same title and semantic text hierarchy.

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Legal'>;
  route: RouteProp<RootStackParamList, 'Legal'>;
};

const APP_VERSION = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? '未知';

const DOCS: Record<RootStackParamList['Legal']['kind'], {
  title: string;
  updated: string;
  sections: { heading: string; body: string; linkLabel?: string; linkUrl?: string }[];
}> = {
  terms: {
    title: '用户协议',
    updated: '2026-07-11',
    sections: [
      { heading: '服务范围', body: '老记提供日程管理、自然语言创建日程、会议记录查看、转写展示和总结展示等功能。语音识别、会议总结和会议资料存储可能由外部服务提供，老记 App 负责调用、展示、错误处理和本机交互。' },
      { heading: '本机使用', body: '老记不要求注册或登录账号。日程、会议索引、原始录音和本机资料归当前设备所有，卸载应用或清除本机数据后可能无法恢复。' },
      { heading: '用户责任', body: '你应保证输入内容和会议资料不侵犯他人权益，不包含违法、侵权或超出工作授权范围的信息。' },
      { heading: '服务可用性', body: '老记会尽力保持服务稳定，但外部语音识别、会议总结、网络连接或服务器维护可能导致部分功能暂时不可用。App 会提供手动文字输入、错误提示和重试入口。' },
      { heading: '数据删除', body: '你可以逐项删除日程或会议，也可以在设置中清除本机数据。清除本机数据会删除当前设备上的日程、会议文件、缓存和设备服务数据。' },
    ],
  },
  privacy: {
    title: '隐私政策',
    updated: '2026-07-16',
    sections: [
      { heading: '我们处理的数据', body: '老记只在本机保存日程、提醒、会议索引、原始录音、转写缓存、整理结果和本机资料。为完成转写、整理、问答和日程解析，必要的音频或生成式输入会按设备数据域临时发送到老记服务。' },
      { heading: '语音与会议服务', body: '日程语音和会议录音会发送到老记服务器上的语音识别服务并转换为文字；整理和问答会发送转写内容到生成服务。原始音频处理完成后会从服务端删除，生成式结果可短期保留以便当前设备恢复续跑。' },
      { heading: '讲话人声纹', body: '你可以主动创建讲话人并录制一段朗读音频，用于在会议转写中辅助区分讲话人。只有在录入页单独勾选同意并点击保存后，讲话人名称和本次 WAV 录音才会上传到声纹服务。你可以重新录制、放弃上传，或在讲话人管理中删除已保存的讲话人资料。' },
      { heading: '本机权限', body: '麦克风用于语音输入日程；照片权限用于选择头像；通知权限用于日程提醒；系统验证权限用于启动时保护 App。拒绝权限不会影响手动文字创建日程。' },
      { heading: '存储与同步', body: '日程和会议操作直接写入本机数据库，不通过云端同步。通知提醒由当前设备本机调度；跨设备同步和账号迁移不在当前版本提供。' },
      { heading: '你的控制权', body: '你可以编辑或删除日程、会议和讲话人资料，也可以在设置中关闭通知、清除本机数据。分享文件时由你在系统分享面板选择接收方。' },
      { heading: '保留与安全', body: '生产通信要求 HTTPS/WSS。设备服务使用独立设备凭据和可轮换的数据域；清除本机数据时会请求删除对应的服务端生成数据。' },
    ],
  },
  help: {
    title: '帮助中心',
    updated: '2026-07-08',
    sections: [
      { heading: '创建日程', body: '在日程页点击右下角新建按钮，可以选择语音输入或手动新建。语音识别失败时，可以直接使用文字输入。' },
      { heading: '提醒设置', body: '新建有具体开始时间的日程默认提前 15 分钟提醒。你可以在新建/编辑日程页调整为不提醒、开始时提醒或其他提前时间。' },
      { heading: '会议记录', body: '会议页可以直接录音并实时显示转写。结束录音后可查看转写、生成总结、播放本机或云端录音，并按你选择的内容生成分享文件。' },
      { heading: '数据存储', body: '日程和会议主体保存在本机数据库。需要转写、整理、问答或语音解析时，服务只接收完成当前任务所需的临时输入；原始录音处理完成后会删除。' },
      { heading: '录音与文件分享', body: '会议录音先保存在本机，再按需发送到转写服务。分享前可选择基本信息、整理结果、行动项、文字记录、标记、附件、录音或我的笔记，确认后会打开系统分享面板。' },
      { heading: '常见问题', body: '服务暂时不可用时请稍后重试；语音识别不准确时请靠近麦克风并保持语句完整；通知没有弹出时请确认系统通知权限已开启。' },
    ],
  },
  guide: {
    title: '使用指南',
    updated: '2026-07-08',
    sections: [
      { heading: '推荐流程', body: '先用文字或语音创建日程，再在详情页补充地点、备注和提醒。重要安排建议保留明确开始时间，方便系统提醒。' },
      { heading: '设备资料', body: '老记以当前设备为唯一使用主体。更换设备不会自动带来旧日程和会议记录；在同一设备上，服务任务会按设备数据域恢复续跑。' },
      { heading: '会议资料', body: '会议主体和原始录音保存在本机；使用语音转写、整理或问答时，必要输入会发送到对应服务。服务不可用时，已缓存内容仍可查看，页面会提供明确错误和重试入口。' },
    ],
  },
  version: {
    title: '版本信息',
    updated: '2026-07-08',
    sections: [],
  },
  contact: {
    title: '联系我们',
    updated: '2026-07-08',
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
    return (
      <ScreenContainer edges={['top', 'bottom']} bg={F.backgroundBase}>
        <SettingsTitleBar title="版本信息" onBack={() => navigation.goBack()} />
        <ScrollView style={s.scroll} contentContainerStyle={s.aboutContent} showsVerticalScrollIndicator={false}>
          <View style={s.aboutBrand}>
            <View style={s.aboutLogo} testID="legal-about-logo">
              <Ionicons name="calendar-clear-outline" size={32} color={F.onPrimary} />
            </View>
            <View style={s.aboutVersionLine}>
              <Text style={s.aboutName}>老记</Text>
              <Text style={s.aboutVersion} testID="legal-about-version">{APP_VERSION}</Text>
            </View>
          </View>

          <SettingsGroup testID="legal-about-group">
            <SettingsRow label="当前版本" value={APP_VERSION} />
            <SettingsRow label="构建编号" value={String(Constants.expoConfig?.android?.versionCode ?? '未知')} last />
          </SettingsGroup>

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
  documentLink: { minHeight: 52, marginTop: 12, borderTopWidth: FEISHU_DIMENSIONS.divider, borderTopColor: F.divider, flexDirection: 'row', alignItems: 'center', gap: 8 },
  linkText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: F.textLink },
  onlineActions: { marginTop: 24 },
  onlineDangerText: { color: F.danger },
  aboutContent: { paddingBottom: 32 },
  aboutBrand: { alignItems: 'center' },
  aboutLogo: { width: 72, height: 72, marginTop: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: F.primary },
  aboutVersionLine: { minHeight: 44, marginTop: 2, marginBottom: 9, paddingVertical: 8, flexDirection: 'row', alignItems: 'center' },
  aboutName: { minHeight: 28, fontSize: 20, lineHeight: 28, fontWeight: '600', color: F.textTitle },
  aboutVersion: { minHeight: 24, marginLeft: 7, fontSize: 18, lineHeight: 24, color: F.textCaption },
});
