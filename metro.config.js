const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.join(__dirname, 'modules')];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'laoji-native-platform': path.join(__dirname, 'modules/laoji-native-platform'),
};

module.exports = config;
