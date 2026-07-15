import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Colors as C } from '../theme/colors';

type Props = {
  testID?: string;
};

/** The calendar source uses a narrow 8 x 32 range divider, not a horizontal arrow. */
export function EventTimeRangeArrow({ testID }: Props) {
  return (
    <View
      style={s.root}
      pointerEvents="none"
      accessible={false}
      testID={testID}
    >
      <View style={[s.stroke, s.upperStroke]} />
      <View style={[s.stroke, s.lowerStroke]} />
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    width: 8,
    height: 32,
    overflow: 'hidden',
  },
  stroke: {
    position: 'absolute',
    left: 3.5,
    width: 1,
    height: 18,
    borderRadius: 0.5,
    backgroundColor: C.faint,
  },
  upperStroke: {
    top: -1,
    transform: [{ rotate: '-26.565deg' }],
  },
  lowerStroke: {
    top: 15,
    transform: [{ rotate: '26.565deg' }],
  },
});
