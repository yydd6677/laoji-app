import React, { useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { ScreenContainer } from '../components/ScreenContainer';

import { RootStackParamList } from '../types';
import { Avatar } from '../components/Common';
import { BottomTabBar } from '../components/BottomTabBar';
import { useEvents } from '../store/EventsStore';
import { useMeetings } from '../store/MeetingsStore';
import { openMeetingsTab, openScheduleTab } from '../navigation/tabTargets';
import { useAuth } from '../store/AuthStore';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export function ProfileScreen({ navigation }: Props) {
  const { events } = useEvents();
  const { meetings } = useMeetings();
  const { profile, isGuest } = useAuth();

  const currentYearMonth = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }, []);

  const stats = useMemo(() => {
    const monthlyEvents = events.filter(e => e.startDate.startsWith(currentYearMonth)).length;
    const meetingCount = meetings.length;
    const importantDates = events.filter(e => e.isAllDay !== true).length;
    return [
      { l: '本月日程', v: String(monthlyEvents), u: '个' },
      { l: '会议记录', v: String(meetingCount),   u: '篇' },
      { l: '定时日程', v: String(importantDates), u: '次' },
    ];
  }, [events, meetings, currentYearMonth]);

  const menu = useMemo(() => [
    { e: '💌', l: '邮箱设置',       v: profile.email, to: 'Account' as const },
    { e: '📱', l: '手机号设置',     v: profile.phone, to: 'Account' as const },
    { e: '🖼️', l: '头像设置',       v: '',            to: 'Account' as const },
    { e: '🔒', l: '隐私设置',       v: '',            to: 'Privacy' as const },
    { e: '❓', l: '操作指南与关于', v: '帮助中心 / 关于我们', to: 'Privacy' as const },
  ], [profile.email, profile.phone]);

  return (
    <ScreenContainer edges={['top']}>
      <View style={s.topBar}>
        <View style={{ width: 32 }} />
        <Text style={s.topTitle}>我</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Account')}>
          <Ionicons name="settings-outline" size={22} color={C.sub} />
        </TouchableOpacity>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
        {/* User card */}
        <View style={s.userCard}>
          <Avatar size={62} profile={profile} />
          <View>
            <View style={s.nameRow}>
              <Text style={s.name}>{profile.nickname}</Text>
              <LinearGradient colors={isGuest ? ['#FFD700', '#FFA500'] : [C.gradFrom, C.gradTo]} start={{ x:0,y:0 }} end={{ x:1,y:0 }} style={s.vipBadge}>
                <Text style={s.vipText}>{isGuest ? '访客' : '云端'}</Text>
              </LinearGradient>
            </View>
            <Text style={s.email}>{profile.email}</Text>
          </View>
        </View>

        {/* Account card */}
        <LinearGradient colors={['#FFD6EA', '#FFF2F8']} start={{ x:0,y:0 }} end={{ x:1,y:0 }} style={s.vipCard}>
          <View style={s.vipLeft}>
            <View style={s.starIcon}><Text style={{ fontSize: 18 }}>⭐</Text></View>
            <View>
              <Text style={s.vipCardTitle}>{isGuest ? '本地体验账号' : '云同步账号'}</Text>
              <Text style={s.vipCardSub}>{isGuest ? '资料和日程仅保存在本机' : '日程按账号同步到服务器'}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('Account')} activeOpacity={0.85}>
            <LinearGradient colors={['#FF8FAB', '#FF5C8A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.renewBtn}>
              <Text style={s.renewText}>编辑资料</Text>
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>

        {/* Stats */}
        <View style={s.statsCard}>
          {stats.map((stat, i) => (
            <View key={stat.l} style={[s.statItem, i < stats.length - 1 && s.statBorder]}>
              <Text style={s.statLabel}>{stat.l}</Text>
              <Text style={s.statValue}>{stat.v}<Text style={s.statUnit}> {stat.u}</Text></Text>
            </View>
          ))}
        </View>

        {/* Menu */}
        <View style={s.menuCard}>
          {menu.map((item, i) => (
            <TouchableOpacity
              key={item.l}
              style={[s.menuRow, i < menu.length - 1 && s.menuBorder]}
              onPress={() => navigation.navigate(item.to)}
            >
              <Text style={s.menuEmoji}>{item.e}</Text>
              <Text style={s.menuLabel}>{item.l}</Text>
              {item.v ? <Text style={s.menuValue}>{item.v}</Text> : null}
              <Ionicons name="chevron-forward" size={16} color={C.faint} />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <BottomTabBar
        active="schedule"
        onSchedule={() => openScheduleTab(navigation)}
        onMeetings={() => openMeetingsTab(navigation)}
      />
    </ScreenContainer>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.appBg },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  topTitle: { fontSize: 18, fontWeight: '800', color: C.text },
  scroll: { flex: 1 },
  userCard: { marginHorizontal: 14, marginBottom: 12, backgroundColor: C.card, borderRadius: 20, padding: 18, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: '#6432B4', shadowOffset:{width:0,height:2}, shadowOpacity:0.08, shadowRadius:14, elevation:3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
  name: { fontSize: 18, fontWeight: '800', color: C.text },
  vipBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  vipText: { fontSize: 10, fontWeight: '800', color: '#fff' },
  email: { fontSize: 12, color: C.sub },
  vipCard: { marginHorizontal: 14, marginBottom: 12, borderRadius: 18, padding: 14, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: '#FFD6EA' },
  vipLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  starIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#FFE0EE', alignItems: 'center', justifyContent: 'center' },
  vipCardTitle: { fontSize: 14, fontWeight: '700', color: '#C2437A', marginBottom: 3 },
  vipCardSub: { fontSize: 11, color: '#C2437A', opacity: 0.75 },
  renewBtn: { backgroundColor: '#FF8FAB', borderRadius: 18, paddingHorizontal: 18, paddingVertical: 8, shadowColor: '#FF5C8A', shadowOffset:{width:0,height:3}, shadowOpacity:0.4, shadowRadius:8, elevation:4 },
  renewText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  statsCard: { marginHorizontal: 14, marginBottom: 12, backgroundColor: C.card, borderRadius: 18, padding: 18, paddingHorizontal: 16, flexDirection: 'row', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  statItem: { flex: 1, alignItems: 'center', paddingHorizontal: 6 },
  statBorder: { borderRightWidth: 1, borderRightColor: C.border },
  statLabel: { fontSize: 10, color: C.sub, marginBottom: 8, lineHeight: 14, textAlign: 'center' },
  statValue: { fontSize: 26, fontWeight: '800', color: C.text, lineHeight: 28 },
  statUnit: { fontSize: 11, fontWeight: '500' },
  menuCard: { marginHorizontal: 14, backgroundColor: C.card, borderRadius: 18, overflow: 'hidden', shadowColor: '#5028A0', shadowOffset:{width:0,height:1}, shadowOpacity:0.06, shadowRadius:8, elevation:2 },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, paddingHorizontal: 16 },
  menuBorder: { borderBottomWidth: 1, borderBottomColor: C.border },
  menuEmoji: { fontSize: 20, width: 28, textAlign: 'center' },
  menuLabel: { flex: 1, fontSize: 14, fontWeight: '500', color: C.text },
  menuValue: { fontSize: 12, color: C.sub },
});
