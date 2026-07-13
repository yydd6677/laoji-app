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
    Value: jest.fn(),
    timing: jest.fn(() => ({ start: jest.fn() })),
    View: 'Animated.View',
  },
  Easing: {},
  requireNativeComponent: name => name,
  findNodeHandle: jest.fn(),
  I18nManager: { isRTL: false },
  unstable_batchedUpdates: callback => callback(),
  React,
};
