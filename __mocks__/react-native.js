const React = require('react');

const ScrollView = React.forwardRef((props, ref) => {
  React.useImperativeHandle(ref, () => ({ scrollTo: jest.fn() }));
  return React.createElement('ScrollView', props, props.children);
});

const FlatList = React.forwardRef((props, ref) => {
  const data = props.data || [];
  const center = Math.max(0, Math.min(data.length - 1, props.initialScrollIndex || 0));
  const start = Math.max(0, center - 4);
  const end = Math.min(data.length, center + 5);
  const children = [];
  const renderComponent = (component, key) => {
    if (!component) return null;
    if (React.isValidElement(component)) return React.cloneElement(component, { key });
    if (typeof component === 'function') return React.createElement(component, { key });
    return component;
  };
  const header = renderComponent(props.ListHeaderComponent, 'list-header');
  if (header) children.push(header);
  for (let index = start; index < end; index += 1) {
    const child = props.renderItem?.({ item: data[index], index, separators: {} });
    children.push(React.isValidElement(child)
      ? React.cloneElement(child, { key: props.keyExtractor?.(data[index], index) ?? String(index) })
      : child);
  }
  if (data.length === 0) {
    const empty = renderComponent(props.ListEmptyComponent, 'list-empty');
    if (empty) children.push(empty);
  }
  const footer = renderComponent(props.ListFooterComponent, 'list-footer');
  if (footer) children.push(footer);
  React.useImperativeHandle(ref, () => ({ scrollToIndex: jest.fn(), scrollToOffset: jest.fn() }));
  const {
    data: _data,
    renderItem: _renderItem,
    keyExtractor: _keyExtractor,
    ListHeaderComponent: _listHeaderComponent,
    ListEmptyComponent: _listEmptyComponent,
    ListFooterComponent: _listFooterComponent,
    ...hostProps
  } = props;
  return React.createElement('FlatList', hostProps, children);
});

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
  ScrollView,
  FlatList,
  TouchableOpacity: 'TouchableOpacity',
  Pressable: 'Pressable',
  Modal: 'Modal',
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Keyboard: { dismiss: jest.fn() },
  PanResponder: {
    create: jest.fn(config => ({
      panHandlers: {
        onMoveShouldSetResponder: config.onMoveShouldSetPanResponder,
        onResponderGrant: config.onPanResponderGrant,
        onResponderMove: config.onPanResponderMove,
        onResponderRelease: config.onPanResponderRelease,
        onResponderTerminate: config.onPanResponderTerminate,
      },
    })),
  },
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
  BackHandler: {
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
      stopAnimation(callback) { callback?.(this.value); }
      interpolate(config) { return { value: this.value, config }; }
    },
    timing: jest.fn((value, config) => ({
      start: jest.fn(callback => {
        value?.setValue?.(config?.toValue);
        callback?.({ finished: true });
      }),
    })),
    event: jest.fn(() => jest.fn()),
    parallel: jest.fn(animations => ({
      start: jest.fn(callback => {
        let remaining = animations.length;
        if (remaining === 0) {
          callback?.({ finished: true });
          return;
        }
        animations.forEach(animation => animation.start?.(() => {
          remaining -= 1;
          if (remaining === 0) callback?.({ finished: true });
        }));
      }),
    })),
    View: 'Animated.View',
    Text: 'Text',
    ScrollView,
  },
  Easing: {
    ease: value => value,
    in: easing => easing,
    out: easing => easing,
    inOut: easing => easing,
  },
  requireNativeComponent: name => name,
  findNodeHandle: jest.fn(),
  I18nManager: { isRTL: false },
  unstable_batchedUpdates: callback => callback(),
  React,
};
