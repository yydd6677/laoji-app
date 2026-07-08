// Mock for react-native-reanimated in Jest tests
module.exports = {
  default: { View: 'Animated.View', Text: 'Animated.Text', ScrollView: 'Animated.ScrollView' },
  useSharedValue: (v) => ({ value: v }),
  useAnimatedStyle: (fn) => ({}),
  withTiming: (v) => v,
  withSpring: (v) => v,
  runOnJS: (fn) => fn,
  createAnimatedComponent: (c) => c,
};
