import * as FileSystem from 'expo-file-system/legacy';
import { persistLocalAvatar, removeManagedLocalAvatar } from '../src/services/profile';

describe('durable local avatar cache', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies a picked image into the app document directory', async () => {
    const uri = await persistLocalAvatar('content://picker/avatar.png', 'user:7');

    expect(uri).toMatch(/^file:\/\/\/tmp\/laoji-documents\/avatars\/user_7-\d+\.png$/);
    expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
      'file:///tmp/laoji-documents/avatars/',
      { intermediates: true },
    );
    expect(FileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'content://picker/avatar.png',
      to: uri,
    });
  });

  it('only deletes avatar files managed by LaoJi', async () => {
    await removeManagedLocalAvatar('content://picker/avatar.png');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();

    await removeManagedLocalAvatar('file:///tmp/laoji-documents/avatars/user_7-1.png');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///tmp/laoji-documents/avatars/user_7-1.png',
      { idempotent: true },
    );
  });
});
