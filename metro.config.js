const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Keep the cold-start module graph limited to the shell. Screens and service
// providers are evaluated when their route is first used, rather than during
// the first React instance frame.
config.transformer = {
  ...config.transformer,
  getTransformOptions: async () => ({
    transform: {
      experimentalImportSupport: false,
      inlineRequires: true,
    },
  }),
};
config.watchFolders = [path.join(__dirname, 'modules')];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'laoji-native-platform': path.join(__dirname, 'modules/laoji-native-platform'),
};

module.exports = config;
