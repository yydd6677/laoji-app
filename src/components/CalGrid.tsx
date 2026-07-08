import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';
import { CalEvent } from '../types';

interface Props {
  year: number; month: number; selDay: number;
  onDay: (d: number) => void;
  onPrev: () => void; onNext: () => void;
  onTitle?: () => void;
  onSearch?: () => void;
  events: CalEvent[];
}

export function CalGrid({ year, month, selDay, onDay, onPrev, onNext, onTitle, onSearch, events }: Props) {
  const WD = ['日','一','二','三','四','五','六'];
  const fDow = new Date(year, month - 1, 1).getDay();
  const dim   = new Date(year, month, 0).getDate();
  const pDim  = new Date(year, month - 1, 0).getDate();

  type Cell = { d: number; cur: boolean };
  const cells: Cell[] = [];
  for (let i = 0; i < fDow; i++) cells.push({ d: pDim - fDow + 1 + i, cur: false });
  for (let d = 1; d <= dim; d++) cells.push({ d, cur: true });
  while (cells.length % 7) cells.push({ d: cells.length - dim - fDow + 1, cur: false });
  const rows = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  const ds = (d: number) =>
    `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const ptEvts = (d: number) =>
    events.filter(e => !e.spanning && e.startDate === ds(d));

  const getSpans = (row: Cell[]) => {
    const out: { e: CalEvent; sc: number; ec: number }[] = [];
    for (const e of events) {
      if (!e.spanning || !e.endDate) continue;
      let sc = -1, ec = -1;
      row.forEach((c, i) => {
        if (!c.cur) return;
        const s = ds(c.d);
        if (s >= e.startDate && s <= e.endDate!) { if (sc < 0) sc = i; ec = i; }
      });
      if (sc >= 0) out.push({ e, sc, ec });
    }
    return out;
  };

  return (
    <View style={s.card}>
      {/* Month header */}
      <View style={s.monthRow}>
        <TouchableOpacity onPress={onPrev} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={20} color={C.sub} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onTitle} disabled={!onTitle} style={s.monthTitle}>
          <Text style={s.monthText}>{year}年{month}月</Text>
          {onTitle && <Ionicons name="chevron-forward" size={13} color={C.purple} />}
        </TouchableOpacity>
        <View style={s.monthRight}>
          <TouchableOpacity onPress={onNext} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="chevron-forward" size={20} color={C.sub} />
          </TouchableOpacity>
          {onSearch
            ? (
              <TouchableOpacity onPress={onSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="search-outline" size={15} color={C.sub} />
              </TouchableOpacity>
            )
            : <View style={s.searchSlot} />}
        </View>
      </View>

      {/* Weekday row */}
      <View style={s.wdRow}>
        {WD.map(d => <Text key={d} style={s.wdText}>{d}</Text>)}
      </View>

      {/* Date rows */}
      {rows.map((row, ri) => {
        const spans = getSpans(row);
        return (
          <View key={ri}>
            <View style={s.dateRow}>
              {row.map((cell, ci) => {
                const sel = cell.cur && cell.d === selDay;
                const evts = cell.cur ? ptEvts(cell.d) : [];
                return (
                  <TouchableOpacity
                    key={ci}
                    onPress={() => cell.cur && onDay(cell.d)}
                    style={s.cell}
                    activeOpacity={cell.cur ? 0.7 : 1}
                  >
                    <View style={[s.dayCircle, sel && { backgroundColor: C.purpleDark }]}>
                      <Text style={[
                        s.dayNum,
                        sel && { color: '#fff', fontWeight: '700' },
                        !cell.cur && { color: '#D5D0ED' },
                      ]}>
                        {cell.d}
                      </Text>
                    </View>
                    {evts.slice(0, 2).map(e => (
                      <View key={e.id} style={[s.pill, { backgroundColor: e.color + '1E' }]}>
                        <Text style={[s.pillText, { color: e.color }]} numberOfLines={1}>
                          {e.title}
                        </Text>
                      </View>
                    ))}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Spanning events */}
            {spans.map(({ e, sc, ec }, si) => (
              <View key={si} style={s.spanRow}>
                {Array.from({ length: 7 }).map((_, ci) => {
                  const inSp = ci >= sc && ci <= ec;
                  const isS = ci === sc; const isE = ci === ec;
                  return (
                    <View key={ci} style={[
                      s.spanCell,
                      inSp && { backgroundColor: e.color + '22' },
                      isS && isE ? { borderRadius: 8 } :
                      isS ? { borderTopLeftRadius: 8, borderBottomLeftRadius: 8 } :
                      isE ? { borderTopRightRadius: 8, borderBottomRightRadius: 8 } : {},
                    ]}>
                      {isS && (
                        <Text style={[s.spanText, { color: e.color }]} numberOfLines={1}>
                          {e.title}
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card, borderRadius: 20, marginHorizontal: 14,
    paddingHorizontal: 8, paddingTop: 16, paddingBottom: 12,
    shadowColor: '#6432B4', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 18, elevation: 4,
  },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, marginBottom: 14 },
  monthTitle: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 },
  monthRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  searchSlot: { width: 15, height: 15 },
  monthText: { fontSize: 15, fontWeight: '700', color: C.text },
  wdRow: { flexDirection: 'row', marginBottom: 4 },
  wdText: { flex: 1, textAlign: 'center', fontSize: 11, color: C.faint, fontWeight: '500', paddingVertical: 2 },
  dateRow: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', paddingVertical: 2, minHeight: 50 },
  dayCircle: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  dayNum: { fontSize: 13, color: C.text, lineHeight: 16 },
  pill: { borderRadius: 3, paddingHorizontal: 3, paddingVertical: 1, marginBottom: 1, maxWidth: '95%' },
  pillText: { fontSize: 9, fontWeight: '600', lineHeight: 13 },
  spanRow: { flexDirection: 'row', marginBottom: 4, marginTop: -2 },
  spanCell: { flex: 1, height: 16, justifyContent: 'center', paddingLeft: 4 },
  spanText: { fontSize: 9, fontWeight: '700' },
});
