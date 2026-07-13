import React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { LegalDocumentScreen } from '../src/screens/LegalDocumentScreen';

const mockShowDialog = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../src/components/ScreenContainer', () => ({ ScreenContainer: 'ScreenContainer' }));
jest.mock('../src/components/Common', () => ({ BackHeader: 'BackHeader' }));
jest.mock('../src/components/AppDialog', () => ({
  useAppDialog: () => ({ showDialog: mockShowDialog }),
}));

describe('LegalDocumentScreen links', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Linking.canOpenURL as jest.Mock).mockResolvedValue(true);
    (Linking.openURL as jest.Mock).mockResolvedValue(undefined);
  });

  function renderContact() {
    const navigation = { goBack: jest.fn() } as unknown as React.ComponentProps<typeof LegalDocumentScreen>['navigation'];
    const route = {
      key: 'Legal-contact',
      name: 'Legal' as const,
      params: { kind: 'contact' as const },
    } as React.ComponentProps<typeof LegalDocumentScreen>['route'];
    return render(<LegalDocumentScreen navigation={navigation} route={route} />);
  }

  it('opens a supported external link', async () => {
    const view = await renderContact();
    fireEvent.press(view.getByLabelText('打开 GitHub Issues'));
    await waitFor(() => expect(Linking.openURL).toHaveBeenCalledWith(
      'https://github.com/yydd6677/laoji-app/issues',
    ));
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it('shows a recoverable in-app error when no browser can open the link', async () => {
    (Linking.canOpenURL as jest.Mock).mockResolvedValue(false);
    const view = await renderContact();
    fireEvent.press(view.getByLabelText('打开 GitHub Issues'));

    await waitFor(() => expect(mockShowDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '无法打开链接',
      tone: 'error',
    })));
    expect(Linking.openURL).not.toHaveBeenCalled();
  });
});
