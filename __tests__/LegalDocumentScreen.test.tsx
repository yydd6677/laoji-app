import React from 'react';
import { Linking, StyleSheet } from 'react-native';
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

  async function renderVersion() {
    const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as React.ComponentProps<typeof LegalDocumentScreen>['navigation'];
    const route = {
      key: 'Legal-version',
      name: 'Legal' as const,
      params: { kind: 'version' as const },
    } as React.ComponentProps<typeof LegalDocumentScreen>['route'];
    return { view: await render(<LegalDocumentScreen navigation={navigation} route={route} />), navigation };
  }

  it('opens a supported external link', async () => {
    const view = await renderContact();
    expect(view.getByTestId('legal-article')).toBeTruthy();
    expect(view.queryByTestId('legal-about-logo')).toBeNull();
    expect(StyleSheet.flatten(view.getByTestId('legal-updated').props.style))
      .toEqual(expect.objectContaining({ fontSize: 12, lineHeight: 18 }));
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

  it('uses the source about-page logo and setting-group geometry for version info', async () => {
    const { view, navigation } = await renderVersion();

    expect(StyleSheet.flatten(view.getByTestId('legal-about-logo').props.style))
      .toEqual(expect.objectContaining({ width: 72, height: 72, marginTop: 18, borderRadius: 12 }));
    expect(StyleSheet.flatten(view.getByTestId('legal-about-group').props.style))
      .toEqual(expect.objectContaining({ marginHorizontal: 16, marginTop: 16, borderRadius: 10 }));

    fireEvent.press(view.getByText('用户协议'));
    expect(navigation.navigate).toHaveBeenCalledWith('Legal', { kind: 'terms' });
  });
});
