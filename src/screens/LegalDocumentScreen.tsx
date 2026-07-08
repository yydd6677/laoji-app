import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackHeader } from '../components/Common';
import { Colors as C } from '../theme/colors';
import { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Legal'>;
  route: RouteProp<RootStackParamList, 'Legal'>;
};

const DOCS: Record<RootStackParamList['Legal']['kind'], {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  updated: string;
  sections: { heading: string; body: string }[];
}> = {
  terms: {
    title: '用户协议',
    icon: 'document-text-outline',
    updated: '2026-07-08',
    sections: [
      { heading: '服务范围', body: '老记提供日程管理、自然语言创建日程、会议记录查看、转写展示和总结展示等功能。语音识别、会议总结和会议资料存储可能由外部服务提供，老记 App 负责调用、展示、错误处理和本机交互。' },
      { heading: '账号与访客模式', body: '注册或登录账号后，日程和个人资料会按账号同步到老记服务。访客模式不需要账号，访客日程、资料和偏好仅保存在本机，卸载应用或清除本机数据后可能无法恢复。' },
      { heading: '用户责任', body: '你应保证输入内容、上传头像和会议资料不侵犯他人权益，不包含违法、侵权或超出工作授权范围的信息。请妥善保管账号密码，发现账号异常时及时提交密码重置请求。' },
      { heading: '服务可用性', body: '老记会尽力保持服务稳定，但外部语音识别、会议总结、网络连接或服务器维护可能导致部分功能暂时不可用。App 会提供手动文字输入、错误提示和重试入口。' },
      { heading: '数据删除', body: '你可以在应用内删除日程、会议记录或清除本机数据。云端账号数据删除会按服务端接口能力执行；本机清除不会删除登录账号的云端日程。' },
    ],
  },
  privacy: {
    title: '隐私政策',
    icon: 'shield-checkmark-outline',
    updated: '2026-07-08',
    sections: [
      { heading: '我们处理的数据', body: '老记会处理账号信息、昵称、邮箱、手机号、头像、日程标题、日期时间、地点、备注、提醒设置，以及外部会议服务返回的会议列表、转写和总结。' },
      { heading: '语音与会议服务', body: '语音输入会调用外部 ASR 服务转换为文字；会议模块会调用外部会议总结服务读取会议、转写、总结和可用录音地址。App 不负责训练或改造这些服务端模型。' },
      { heading: '本机权限', body: '麦克风用于语音输入日程；照片权限用于选择头像；通知权限用于日程提醒；系统验证权限用于启动时保护 App。拒绝权限不会影响手动文字创建日程。' },
      { heading: '存储与同步', body: '登录账号的日程、资料和头像会同步到老记服务；访客模式数据只在本机保存。通知提醒由每台设备本机调度，多设备登录时每台设备会按同步到的提醒字段自行创建通知。' },
      { heading: '你的控制权', body: '你可以编辑资料、删除头像、关闭通知提醒、清除本机数据或退出登录。分享转写和总结时会打开系统分享面板，由你自行选择接收方。' },
    ],
  },
  help: {
    title: '帮助中心',
    icon: 'help-circle-outline',
    updated: '2026-07-08',
    sections: [
      { heading: '创建日程', body: '在日程首页输入文字或点击底部麦克风，说出包含事项与时间的内容。语音识别失败时，可以直接使用文字输入作为稳定路径。' },
      { heading: '提醒设置', body: '新建有具体开始时间的日程默认提前 15 分钟提醒。你可以在新建/编辑日程页调整为不提醒、开始时提醒或其他提前时间。' },
      { heading: '会议记录', body: '会议页展示外部会议服务返回的列表。进入详情后可以查看转写、总结，若服务端提供 HTTPS 录音地址，则可以播放真实录音。' },
      { heading: '常见问题', body: '登录失败时请检查账号、密码和网络；语音识别不准确时请靠近麦克风并保持语句完整；通知没有弹出时请确认系统通知权限已开启。' },
    ],
  },
  guide: {
    title: '使用指南',
    icon: 'map-outline',
    updated: '2026-07-08',
    sections: [
      { heading: '推荐流程', body: '先用文字或语音创建日程，再在详情页补充地点、备注、颜色和提醒。重要安排建议保留明确开始时间，方便系统提醒。' },
      { heading: '访客与登录', body: '访客适合快速体验；需要跨设备或长期保存时，请注册并登录账号。退出登录不会删除云端日程，清除本机数据只影响本机缓存和访客资料。' },
      { heading: '会议资料', body: '会议列表、转写、总结和录音播放均依赖会议服务端。服务不可用时，老记会保留页面入口并显示可恢复错误。' },
    ],
  },
  version: {
    title: '版本信息',
    icon: 'information-circle-outline',
    updated: '2026-07-08',
    sections: [
      { heading: '当前版本', body: '老记 Android 1.0.0。当前版本聚焦 Android 发布候选版，支持账号登录、访客体验、日程管理、提醒、会议资料查看和外部语音输入集成。' },
      { heading: '发布说明', body: '生产构建需要使用 HTTPS 域名配置老记 API 与会议 API，不使用裸 HTTP IP。Android 安装包不依赖 Expo Go 或 Metro 开发服务。' },
    ],
  },
  contact: {
    title: '联系我们',
    icon: 'mail-outline',
    updated: '2026-07-08',
    sections: [
      { heading: '反馈渠道', body: '问题反馈邮箱：support@laoji.app。提交问题时请包含账号、发生时间、操作步骤、网络环境和截图，便于定位。' },
      { heading: '密码重置', body: '忘记密码时，请在登录页输入账号后点击“忘记密码”，系统会创建人工重置请求。管理员处理后会通过账号绑定联系方式反馈。' },
    ],
  },
};

export function LegalDocumentScreen({ navigation, route }: Props) {
  const doc = DOCS[route.params.kind];
  return (
    <ScreenContainer edges={['top']}>
      <BackHeader title={doc.title} onBack={() => navigation.goBack()} />
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.hero}>
          <View style={s.iconBox}>
            <Ionicons name={doc.icon} size={26} color={C.purple} />
          </View>
          <Text style={s.heroTitle}>{doc.title}</Text>
          <Text style={s.updated}>更新日期：{doc.updated}</Text>
        </View>
        {doc.sections.map(section => (
          <View key={section.heading} style={s.section}>
            <Text style={s.heading}>{section.heading}</Text>
            <Text style={s.body}>{section.body}</Text>
          </View>
        ))}
      </ScrollView>
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  hero: { backgroundColor: C.card, borderRadius: 18, padding: 18, marginBottom: 14, alignItems: 'center', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  iconBox: { width: 54, height: 54, borderRadius: 18, backgroundColor: C.purpleLight, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  heroTitle: { fontSize: 20, color: C.text, fontWeight: '800', marginBottom: 4 },
  updated: { fontSize: 12, color: C.sub },
  section: { backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 10, shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.05, shadowRadius:7, elevation:1 },
  heading: { fontSize: 15, color: C.text, fontWeight: '800', marginBottom: 8 },
  body: { fontSize: 13, color: '#4A4666', lineHeight: 22 },
});
