import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Android native speaker routes [MIN-SPEAKER-001/MIN-AUDIO-001]', () => {
  it('renders both reachable routes through the native speaker surface', () => {
    const manager = source('src/screens/SpeakerManagerScreen.android.tsx');
    const enrollment = source('src/screens/SpeakerEnrollmentScreen.android.tsx');
    expect(manager).toContain('LaojiSpeakerView');
    expect(enrollment).toContain('LaojiSpeakerView');
    expect(manager).not.toMatch(/\bFlatList\b|\bTouchableOpacity\b/);
    expect(enrollment).not.toMatch(/\bScrollView\b|\bTextInput\b|\bTouchableOpacity\b/);
  });

  it('keeps real CRUD, native WAV recording, permission, and cleanup contracts', () => {
    const enrollment = source('src/screens/SpeakerEnrollmentScreen.android.tsx');
    for (const contract of [
      'fetchSpeakers',
      'registerSpeaker',
      'supplementSpeaker',
      'renameSpeaker',
      'deleteSpeaker',
      'startLocalWavRecording',
      'requestRecordingPermissionsAsync',
      'deleteLocalWavRecording',
    ]) expect(enrollment).toContain(contract);
    expect(enrollment).toContain('voiceprintConsentAccepted');
    expect(enrollment).toContain("case 'toggleVoiceprintConsent'");
    expect(enrollment).toContain('请先确认声纹用途');
  });
});
