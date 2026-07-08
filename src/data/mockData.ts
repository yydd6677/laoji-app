import { CalEvent, Meeting } from '../types';
import { Colors as C } from '../theme/colors';

export const EVENTS: CalEvent[] = [
  { id: '1',  title: '评审会',       startDate: '2026-07-01', color: C.blue },
  { id: '2',  title: 'UI学习',       startDate: '2026-07-02', color: C.green },
  { id: '3',  title: '约会',         startDate: '2026-07-03', color: C.pink },
  { id: '4',  title: '项目复盘',     startDate: '2026-07-05', color: C.orange },
  { id: '5',  title: 'UI学习',       startDate: '2026-07-06', color: C.green },
  { id: '6',  title: '健身',         startDate: '2026-07-07', color: '#5CB85C' },
  { id: '7',  title: '文档整理',     startDate: '2026-07-09', color: C.orange },
  { id: '8',  title: '约会',         startDate: '2026-07-10', color: C.pink },
  { id: '9',  title: '周会',         startDate: '2026-07-12', color: C.blue },
  { id: '10', title: '健身',         startDate: '2026-07-13', color: '#5CB85C' },
  { id: '11', title: '需求评审',     startDate: '2026-07-14', color: C.red },
  { id: '12', title: '健身',         startDate: '2026-07-15', color: '#5CB85C' },
  {
    id: '13', title: '笔记本制作',
    startDate: '2026-07-19', endDate: '2026-07-25',
    color: '#9B59B6', spanning: true, status: '进行中',
  },
  {
    id: '14', title: '产品设计评审会',
    startDate: '2026-07-20', startTime: '10:00', endTime: '11:30',
    color: C.green, category: '工作',
    location: '会议室B / 线上会议',
    detail: '本次评审会将聚焦新版本产品的视觉设计方案，包括首页改版、任务中心、数据看板等模块。请提前准备好设计稿及交互说明。',
  },
  {
    id: '15', title: '健身·核心训练',
    startDate: '2026-07-20', startTime: '18:30', endTime: '19:30',
    color: C.orange,
  },
  { id: '16', title: '周会',     startDate: '2026-07-26', color: C.blue },
  { id: '17', title: '健身',     startDate: '2026-07-27', color: '#5CB85C' },
  { id: '18', title: '方案评审', startDate: '2026-07-29', color: C.orange },
];

export const MEETINGS: Meeting[] = [
  {
    id: 'm1', title: '产品设计评审会',
    date: '2026年7月20日（周一）', time: '10:00 – 11:30', duration: '01:32:45',
    tags: [{ label: '产品项目', color: C.blue }, { label: '评审会', color: C.orange }],
    bars: [4,9,15,7,19,11,5,17,8,6,13,10,7,14,9,4,16,12,8,5,18,10,6,15,9],
  },
  {
    id: 'm2', title: 'UI 设计方案讨论会',
    date: '2026年7月20日（周一）', time: '14:00 – 15:15', duration: '01:15:22',
    tags: [{ label: 'AI项目会议', color: '#9B59B6' }, { label: '设计', color: C.teal }],
    bars: [7,12,5,17,9,4,14,8,11,6,15,7,12,4,11,9,5,13,8,6],
  },
  {
    id: 'm3', title: '运营周会第 21 期',
    date: '2026年7月19日（周日）', time: '09:30 – 10:30', duration: '01:00:18',
    tags: [{ label: '运营周会', color: C.orange }],
    bars: [5,13,8,4,17,10,6,15,9,3,12,7,5,14,8,10,6,11],
  },
  {
    id: 'm4', title: '用户反馈收集会',
    date: '2026年7月19日（周日）', time: '16:00 – 17:10', duration: '01:10:05',
    tags: [{ label: '产品项目', color: C.blue }, { label: '用户反馈', color: C.pink }],
    bars: [9,5,14,7,11,17,4,8,13,6,10,15,3,12,7,9,5,14],
  },
  {
    id: 'm5', title: '市场策略同步会',
    date: '2026年7月19日（周日）', time: '18:30 – 19:30', duration: '01:00:12',
    tags: [{ label: '市场会议', color: C.teal }, { label: '产品项目', color: C.blue }],
    bars: [6,12,8,4,15,10,7,13,5,9,17,6,11,4,8,12,7,14],
  },
];
