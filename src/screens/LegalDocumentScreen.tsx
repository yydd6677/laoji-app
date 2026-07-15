import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackHeader } from '../components/Common';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { Colors as C } from '../theme/colors';
import { RootStackParamList } from '../types';
import { getApiConfig } from '../services/config';
import { useAppDialog } from '../components/AppDialog';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Legal'>;
  route: RouteProp<RootStackParamList, 'Legal'>;
};

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

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
      { heading: '账号与访客模式', body: '注册或登录账号后，日程和个人资料会按账号同步到老记服务。访客模式不需要账号，访客日程、资料和偏好仅保存在本机，卸载应用或清除本机数据后可能无法恢复。' },
      { heading: '用户责任', body: '你应保证输入内容、上传头像和会议资料不侵犯他人权益，不包含违法、侵权或超出工作授权范围的信息。请妥善保管账号密码，发现账号异常时及时提交密码重置请求。' },
      { heading: '服务可用性', body: '老记会尽力保持服务稳定，但外部语音识别、会议总结、网络连接或服务器维护可能导致部分功能暂时不可用。App 会提供手动文字输入、错误提示和重试入口。' },
      { heading: '数据删除', body: '你可以逐项删除日程或会议，也可以在账号与安全页面输入当前密码并永久删除账号、云端日程、会议录音、转写、总结、头像和登录会话。无法进入 App 时可使用公开账号删除页面提交人工核验请求。' },
    ],
  },
  privacy: {
    title: '隐私政策',
    updated: '2026-07-11',
    sections: [
      { heading: '我们处理的数据', body: '老记会处理账号信息、昵称、邮箱、手机号、头像、日程标题、日期时间、地点、备注、提醒设置，以及外部会议服务返回的会议列表、转写和总结。' },
      { heading: '语音与会议服务', body: '日程语音和会议录音会发送到老记服务器上的语音识别服务并转换为文字；会议总结会发送转写文本到总结服务。登录账号的会议资料按账号隔离。访客会议主体保存在本机；访客主动生成总结时，转写会临时发送到服务端，临时文件在任务结束时删除，结果最多保留一小时供 App 获取。' },
      { heading: '本机权限', body: '麦克风用于语音输入日程；照片权限用于选择头像；通知权限用于日程提醒；系统验证权限用于启动时保护 App。拒绝权限不会影响手动文字创建日程。' },
      { heading: '存储与同步', body: '登录账号的日程、资料、头像和会议索引会同步到老记服务，已读取的会议内容也会缓存在本机；访客模式数据只在本机保存。通知提醒由每台设备本机调度，多设备登录时每台设备会按同步到的提醒字段自行创建通知。' },
      { heading: '你的控制权', body: '你可以编辑资料、删除头像、关闭通知提醒、清除本机数据、退出登录或永久删除账号。账号删除会清理云端日程、会议资料和所有会话；网页请求处理后会擦除请求中的账号与联系方式。分享文件时由你在系统分享面板选择接收方。' },
      { heading: '保留与安全', body: '密码以带随机盐的 PBKDF2 哈希保存，服务端 token 只保存摘要；生产通信要求 HTTPS/WSS。尚未处理的网页删号申请最长保留 90 天，逾期自动删除；完成或驳回后会擦除账号、联系方式和说明，仅保留处理状态最多 30 天。账号删除后，仅保留不含会议内容的随机会议 ID 墓碑最多 30 天，用于阻止后台任务重新写入已删除数据。' },
    ],
  },
  help: {
    title: '帮助中心',
    updated: '2026-07-08',
    sections: [
      { heading: '创建日程', body: '在日程页点击右下角新建按钮，可以选择语音输入或手动新建。语音识别失败时，可以直接使用文字输入。' },
      { heading: '提醒设置', body: '新建有具体开始时间的日程默认提前 15 分钟提醒。你可以在新建/编辑日程页调整为不提醒、开始时提醒或其他提前时间。' },
      { heading: '会议记录', body: '会议页可以直接录音并实时显示转写。结束录音后可查看转写、生成总结、播放本机或云端录音，并以会议文档、完整资料包或单独录音文件分享。' },
      { heading: '常见问题', body: '登录失败时请检查账号、密码和网络；语音识别不准确时请靠近麦克风并保持语句完整；通知没有弹出时请确认系统通知权限已开启。' },
    ],
  },
  guide: {
    title: '使用指南',
    updated: '2026-07-08',
    sections: [
      { heading: '推荐流程', body: '先用文字或语音创建日程，再在详情页补充地点、备注和提醒。重要安排建议保留明确开始时间，方便系统提醒。' },
      { heading: '访客与登录', body: '访客适合快速体验；需要跨设备或长期保存时，请注册并登录账号。退出登录不会删除云端日程，清除本机数据只影响本机缓存和访客资料。' },
      { heading: '会议资料', body: '登录账号使用按用户隔离的会议服务，并在本机缓存会议列表、转写和总结；访客会议完全保存在本机。服务不可用时，已缓存内容仍可查看，页面会提供明确错误和重试入口。' },
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
        body: '请附上发生时间、操作步骤、网络环境和截图；不要公开账号密码、访问令牌或原始私密会议内容。',
        linkLabel: '打开 GitHub Issues',
        linkUrl: 'https://github.com/yydd6677/laoji-app/issues',
      },
      { heading: '密码重置', body: '忘记密码时，请在登录页输入账号后点击“忘记密码”，系统会创建人工重置请求。管理员处理后会通过账号绑定联系方式反馈。' },
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
    ? [
        { label: '打开公开隐私政策', url: config.privacyPolicyUrl, icon: 'open-outline' as const },
        { label: '账号与数据删除', url: config.accountDeletionUrl, icon: 'trash-outline' as const },
      ]
    : route.params.kind === 'terms'
      ? [{ label: '打开公开用户协议', url: config.termsOfServiceUrl, icon: 'open-outline' as const }]
      : [];
  if (route.params.kind === 'version') {
    return (
      <ScreenContainer edges={['top', 'bottom']}>
        <BackHeader title="关于老记" onBack={() => navigation.goBack()} />
        <ScrollView style={s.scroll} contentContainerStyle={s.aboutContent} showsVerticalScrollIndicator={false}>
          <View style={s.aboutBrand}>
            <View style={s.aboutLogo} testID="legal-about-logo">
              <Text style={s.aboutLogoText}>记</Text>
            </View>
            <View style={s.aboutVersionLine}>
              <Text style={s.aboutName}>老记</Text>
              <Text style={s.aboutVersion}>{APP_VERSION}</Text>
            </View>
          </View>

          <SettingsGroup testID="legal-about-group">
            <SettingsRow label="当前版本" value={APP_VERSION} />
            <SettingsRow label="用户协议" onPress={() => navigation.navigate('Legal', { kind: 'terms' })} />
            <SettingsRow label="隐私政策" onPress={() => navigation.navigate('Legal', { kind: 'privacy' })} last />
          </SettingsGroup>

        </ScrollView>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer bg={C.body} edges={['top', 'bottom']}>
      <BackHeader title={doc.title} onBack={() => navigation.goBack()} />
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
                <Ionicons name="open-outline" size={16} color={C.primary} />
                <Text style={s.linkText}>{section.linkLabel}</Text>
                <Ionicons name="chevron-forward" size={16} color={C.faint} />
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
                <Ionicons name={link.icon} size={16} color={link.icon === 'trash-outline' ? C.red : C.primary} />
                <Text style={[s.linkText, link.icon === 'trash-outline' && s.onlineDangerText]}>{link.label}</Text>
                <Ionicons name="chevron-forward" size={16} color={C.faint} />
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
  articleContent: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 36, backgroundColor: C.body },
  updated: { fontSize: 12, lineHeight: 18, color: C.faint },
  section: { marginTop: 24 },
  firstSection: { marginTop: 20 },
  heading: { fontSize: 17, lineHeight: 24, color: C.text, fontWeight: '600', marginBottom: 8 },
  body: { fontSize: 15, color: C.sub, lineHeight: 26 },
  documentLink: { minHeight: 52, marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.divider, flexDirection: 'row', alignItems: 'center', gap: 8 },
  linkText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22, color: C.primary },
  onlineActions: { marginTop: 24 },
  onlineDangerText: { color: C.red },
  aboutContent: { paddingBottom: 32 },
  aboutBrand: { alignItems: 'center' },
  aboutLogo: { width: 72, height: 72, marginTop: 18, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  aboutLogoText: { fontSize: 30, lineHeight: 38, fontWeight: '700', color: '#fff' },
  aboutVersionLine: { minHeight: 44, marginTop: 2, marginBottom: 9, paddingVertical: 8, flexDirection: 'row', alignItems: 'center' },
  aboutName: { minHeight: 28, fontSize: 20, lineHeight: 28, fontWeight: '700', color: C.text },
  aboutVersion: { minHeight: 22, marginLeft: 7, fontSize: 18, lineHeight: 24, color: C.text },
});
