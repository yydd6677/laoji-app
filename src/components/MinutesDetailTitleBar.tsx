import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors as C } from '../theme/colors';

export function MinutesDetailTitleBar({
  onBack,
  onShare,
  onMore,
  sharing,
  shareTestID,
  backgroundColor,
  title,
}: {
  onBack: () => void;
  onShare?: () => void;
  onMore?: () => void;
  sharing?: boolean;
  shareTestID?: string;
  backgroundColor?: string;
  title?: string;
}) {
  return (
    <View style={[s.bar, backgroundColor ? { backgroundColor } : null]}>
      <TouchableOpacity
        style={[s.action, s.backAction]}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="返回"
      >
        <Ionicons name="chevron-back" size={22} color={C.text} />
      </TouchableOpacity>
      {title ? <Text pointerEvents="none" style={s.title} numberOfLines={1}>{title}</Text> : null}
      <View style={s.rightActions}>
        {onShare ? (
          <TouchableOpacity
            style={s.action}
            onPress={onShare}
            disabled={sharing}
            accessibilityRole="button"
            accessibilityLabel="分享会议资料"
            testID={shareTestID}
          >
            {sharing
              ? <ActivityIndicator size="small" color={C.primary} />
              : <Ionicons name="share-outline" size={22} color={C.text} />}
          </TouchableOpacity>
        ) : null}
        {onMore ? (
          <TouchableOpacity
            style={[s.action, s.moreAction]}
            onPress={onMore}
            accessibilityRole="button"
            accessibilityLabel="更多会议操作"
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={C.text} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { height: 44, flexDirection: 'row', alignItems: 'center', backgroundColor: C.body },
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backAction: { marginLeft: 6 },
  rightActions: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center' },
  title: { position: 'absolute', left: 60, right: 60, textAlign: 'center', fontSize: 17, lineHeight: 24, color: C.text, fontWeight: '500' },
  moreAction: { marginRight: 6 },
});
