const React = require('react');

module.exports = {
  Platform: { OS: 'android', select: values => values?.android ?? values?.default },
  StyleSheet: {
    create: styles => styles,
    flatten: style => Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean).map(item => item || {}))
      : style || {},
  },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity',
  Pressable: 'Pressable',
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Keyboard: { dismiss: jest.fn() },
  Linking: {
    canOpenURL: jest.fn(async () => true),
    openURL: jest.fn(async () => undefined),
    openSettings: jest.fn(async () => undefined),
    sendIntent: jest.fn(async () => undefined),
  },
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Share: { share: jest.fn(async () => ({ action: 'sharedAction' })) },
  NativeModules: {},
  Dimensions: { get: jest.fn(() => ({ width: 390, height: 844 })) },
  useWindowDimensions: jest.fn(() => ({ width: 390, height: 844 })),
  Animated: {
    Value: class MockAnimatedValue {
      constructor(value) { this.value = value; }
      setValue(value) { this.value = value; }
      interpolate(config) { return { value: this.value, config }; }
    },
    timing: jest.fn((value, config) => ({
      start: jest.fn(callback => {
        value?.setValue?.(config?.toValue);
        callback?.({ finished: true });
      }),
    })),
    View: 'Animated.View',
  },
  Easing: {},
  requireNativeComponent: name => name,
  findNodeHandle: jest.fn(),
  I18nManager: { isRTL: false },
  unstable_batchedUpdates: callback => callback(),
  React,
};
