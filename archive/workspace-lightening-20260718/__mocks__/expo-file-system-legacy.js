module.exports = {
  cacheDirectory: 'file:///tmp/laoji-cache/',
  documentDirectory: 'file:///tmp/laoji-documents/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
  downloadAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  readDirectoryAsync: jest.fn(async () => []),
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
};
