import fs from 'fs';
import path from 'path';

describe('application privacy boundary [UI-PRIVACY-001]', () => {
  it('keeps the global dialog host inside the application lock boundary', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toMatch(/<AppLockGate>\s*<AppDialogProvider>/);
    expect(app).not.toMatch(/<AppDialogProvider>\s*<NotificationPermissionPrimer\s*\/>\s*<AppLockGate>/);
  });
});
