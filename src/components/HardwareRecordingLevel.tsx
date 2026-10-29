import React, { memo, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { addHardwareLevelListener } from 'laoji-native-platform';

type Props = { sessionId: string | null; foreground: boolean; trackColor: string; fillColor: string };

/** Live level owns only its two views, never the recording catalog or controls. */
export const HardwareRecordingLevel = memo(function HardwareRecordingLevel({
  sessionId, foreground, trackColor, fillColor,
}: Props) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    setLevel(0);
    if (!foreground || !sessionId) return undefined;
    let active = true;
    const subscription = addHardwareLevelListener(value => {
      if (active && value.sessionId === sessionId && Number.isFinite(value.normalized)) {
        setLevel(Math.min(1, Math.max(0, value.normalized)));
      }
    });
    return () => { active = false; subscription.remove(); };
  }, [foreground, sessionId]);
  return (
    <View style={[styles.track, { backgroundColor: trackColor }]}>
      <View style={[styles.fill, { width: `${Math.max(2, level * 100)}%`, backgroundColor: fillColor }]} />
    </View>
  );
});

const styles = StyleSheet.create({ track: { height: 4, overflow: 'hidden' }, fill: { height: 4 } });
