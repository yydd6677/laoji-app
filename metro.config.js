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
// Gradle atomically recreates these directories during a native build. They
// contain no JS input; watching them races deletion and can crash Metro while
// an emulator is running. Keep actual native source/assets visible.
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  /[\\/]modules[\\/]laoji-native-platform[\\/]android[\\/](?:build|\.gradle|\.kotlin)(?:[\\/]|$)/,
];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  'laoji-native-platform': path.join(__dirname, 'modules/laoji-native-platform'),
};

module.exports = config;
