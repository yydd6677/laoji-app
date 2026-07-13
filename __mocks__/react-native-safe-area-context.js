const React = require('react');

const SafeAreaView = props => React.createElement('SafeAreaView', props, props.children);
const SafeAreaProvider = props => React.createElement('SafeAreaProvider', props, props.children);

module.exports = {
  SafeAreaView,
  SafeAreaProvider,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1080, height: 2400 }),
};
