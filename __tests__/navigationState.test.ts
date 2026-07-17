import {
  MAIN_TAB_ROUTE_NAMES,
  NAVIGATION_STATE_FUTURE_TOLERANCE_MS,
  NAVIGATION_STATE_MAX_AGE_MS,
  NAVIGATION_STATE_SCHEMA,
  NAVIGATION_STATE_VERSION,
  ROOT_NAVIGATION_ROUTE_NAMES,
  createPersistedNavigationState,
  defaultNavigationState,
  navigationScopeForAuth,
  parsePersistedNavigationState,
  sanitizeNavigationState,
  type NavigationAuthScope,
} from '../src/services/navigationState';

const NOW = Date.UTC(2026, 6, 17, 5, 0, 0);
const USER_SCOPE: NavigationAuthScope = 'user:7';

type InputRoute = { name: string; params?: unknown; state?: unknown; key?: string; path?: string };

function mainTabs(tab: 'Schedule' | 'Meetings' = 'Schedule'): InputRoute {
  return {
    key: 'old-main-key',
    name: 'MainTabs',
    params: { screen: tab },
    state: {
      key: 'old-tab-state',
      index: tab === 'Schedule' ? 0 : 1,
      routes: [
        { key: 'old-schedule-key', name: 'Schedule' },
        { key: 'old-meetings-key', name: 'Meetings' },
      ],
    },
  };
}

function stackFor(route: InputRoute, scope: NavigationAuthScope = USER_SCOPE) {
  if (scope === 'signed_out') {
    const routes = route.name === 'Login' ? [route] : [{ name: 'Login' }, route];
    return { key: 'old-root', index: routes.length - 1, routes };
  }
  const routes = route.name === 'MainTabs' ? [route] : [mainTabs(), route];
  return { key: 'old-root', index: routes.length - 1, routes };
}

function currentRoute(state: ReturnType<typeof sanitizeNavigationState>) {
  if (!state) return undefined;
  return state.routes[state.index ?? state.routes.length - 1];
}

describe('navigation state sanitizer [UI-ANDROID-RUNTIME-001/UI-ROUTES-001]', () => {
  const validRoutes: Array<{ route: InputRoute; scope?: NavigationAuthScope }> = [
    { route: { name: 'Login' }, scope: 'signed_out' },
    { route: mainTabs() },
    { route: { name: 'EventDetail', params: { eventRef: { sourceEventId: 'event-1', occurrenceDate: '2026-07-17' } } } },
    { route: { name: 'MeetingLive', params: { meetingId: 'meeting-1' } } },
    { route: { name: 'Transcription', params: { meetingId: 'meeting-1', focus: 'summary' } } },
    { route: { name: 'SpeakerManager' } },
    { route: { name: 'SpeakerEnrollment', params: { speakerId: 'speaker-1' } } },
    { route: { name: 'Profile' } },
    { route: { name: 'ProfileField', params: { field: 'nickname' } } },
    { route: { name: 'Account', params: { section: 'deletion' } } },
    { route: { name: 'ChangePassword' } },
    { route: { name: 'NotificationSettings' } },
    { route: { name: 'AccountDeletion' } },
    { route: { name: 'Privacy' } },
    { route: { name: 'Legal', params: { kind: 'privacy' } } },
    { route: { name: 'AddEvent', params: { date: '2026-07-17', startTime: '09:30' } } },
  ];

  it('strictly accepts every one of the 16 registered root routes', () => {
    const accepted = validRoutes.map(({ route, scope = USER_SCOPE }) => {
      const sanitized = sanitizeNavigationState(stackFor(route, scope), scope);
      expect(sanitized).not.toBeNull();
      return currentRoute(sanitized)?.name;
    });

    expect(new Set(accepted)).toEqual(new Set(ROOT_NAVIGATION_ROUTE_NAMES));
    expect(ROOT_NAVIGATION_ROUTE_NAMES).toHaveLength(16);
  });

  it.each(MAIN_TAB_ROUTE_NAMES)('restores the %s MainTabs route without old navigation keys', tab => {
    const sanitized = sanitizeNavigationState(stackFor(mainTabs(tab)), USER_SCOPE);
    const route = currentRoute(sanitized);

    expect(route).toMatchObject({ name: 'MainTabs', params: { screen: tab } });
    expect(route?.state).toEqual({
      index: tab === 'Schedule' ? 0 : 1,
      routes: [{ name: 'Schedule' }, { name: 'Meetings' }],
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/old-(?:root|main|tab|schedule|meetings)/);
    expect(JSON.stringify(sanitized)).not.toContain('"key"');
  });

  it('uses the active nested tab rather than stale MainTabs params', () => {
    const route = mainTabs('Schedule');
    route.state = {
      index: 1,
      routes: [{ name: 'Schedule' }, { name: 'Meetings' }],
    };
    expect(currentRoute(sanitizeNavigationState(stackFor(route), USER_SCOPE))?.params)
      .toEqual({ screen: 'Meetings' });
  });

  it('fails closed for unknown routes, unknown params, and malformed stack indexes', () => {
    expect(sanitizeNavigationState(stackFor({ name: 'FutureScreen' }), USER_SCOPE)).toBeNull();
    expect(sanitizeNavigationState(stackFor({ name: 'Privacy', params: { password: 'secret-password' } }), USER_SCOPE)).toBeNull();
    expect(sanitizeNavigationState({ index: 3, routes: [mainTabs()] }, USER_SCOPE)).toBeNull();
    expect(sanitizeNavigationState(stackFor({
      name: 'MainTabs',
      state: { index: 0, routes: [{ name: 'UnknownTab' }] },
    }), USER_SCOPE)).toBeNull();
  });

  it('rejects MeetingLive without an id and accepts an identified native session', () => {
    const missing = createPersistedNavigationState(
      USER_SCOPE,
      stackFor({ name: 'MeetingLive' }),
      NOW,
    );
    expect(missing.state).toEqual(defaultNavigationState(USER_SCOPE));

    const identified = createPersistedNavigationState(
      USER_SCOPE,
      stackFor({ name: 'MeetingLive', params: { meetingId: 'meeting-resumable' } }),
      NOW,
    );
    expect(currentRoute(identified.state)?.params).toEqual({ meetingId: 'meeting-resumable' });
  });

  it('strips AddEvent draft and all form-like values before serialization', () => {
    const secretMarkers = [
      'SECRET-TITLE',
      'SECRET-VOICE-TEXT',
      'SECRET-DESCRIPTION',
      'SECRET-LOCATION',
      'SECRET-DETAIL',
    ];
    const record = createPersistedNavigationState(USER_SCOPE, stackFor({
      name: 'AddEvent',
      params: {
        draft: {
          title: secretMarkers[0],
          startDate: '2026-07-18',
          endDate: '2026-07-19',
          startTime: '10:15',
          endTime: '11:45',
          isAllDay: false,
          repeat: 'weekly',
          rawText: secretMarkers[1],
          description: secretMarkers[2],
          location: secretMarkers[3],
          detail: secretMarkers[4],
          category: '工作',
          reminderMinutes: 15,
        },
      },
    }), NOW);
    const serialized = JSON.stringify(record);

    for (const marker of secretMarkers) expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('"draft"');
    expect(currentRoute(record.state)?.params).toEqual({
      date: '2026-07-18',
      endDate: '2026-07-19',
      startTime: '10:15',
      endTime: '11:45',
    });
  });

  it('preserves only eventRef when restoring an AddEvent edit route', () => {
    const record = createPersistedNavigationState(USER_SCOPE, stackFor({
      name: 'AddEvent',
      params: {
        eventRef: { sourceEventId: 'event-edit', occurrenceDate: '2026-07-17' },
        date: '2027-01-01',
      },
    }), NOW);
    expect(currentRoute(record.state)?.params).toEqual({
      eventRef: { sourceEventId: 'event-edit', occurrenceDate: '2026-07-17' },
    });
  });

  it.each([
    ['ChangePassword', { password: 'SECRET-PASSWORD' }],
    ['AccountDeletion', { confirmation: 'SECRET-DELETE-CONFIRMATION' }],
    ['ProfileField', { field: 'email', value: 'SECRET-FORM-VALUE' }],
  ])('never persists sensitive params supplied to %s', (name, params) => {
    const record = createPersistedNavigationState(USER_SCOPE, stackFor({ name, params }), NOW);
    const serialized = JSON.stringify(record);
    expect(record.state).toEqual(defaultNavigationState(USER_SCOPE));
    expect(serialized).not.toContain('SECRET-');
  });

  it('enforces signed-out, guest, and user route scopes', () => {
    expect(sanitizeNavigationState(stackFor({ name: 'EventDetail', params: {
      eventRef: { sourceEventId: 'event-1', occurrenceDate: '2026-07-17' },
    } }, 'signed_out'), 'signed_out')).toBeNull();
    expect(sanitizeNavigationState({ index: 0, routes: [{ name: 'Login' }] }, USER_SCOPE)).toBeNull();
    expect(sanitizeNavigationState(stackFor({ name: 'Transcription', params: {
      meetingId: 'guest-meeting',
    } }, 'guest'), 'guest')).not.toBeNull();
    expect(navigationScopeForAuth('signed_out')).toBe('signed_out');
    expect(navigationScopeForAuth('guest')).toBe('guest');
    expect(navigationScopeForAuth('authenticated', 42)).toBe('user:42');
  });
});

describe('persisted navigation envelope', () => {
  function serialized(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      ...createPersistedNavigationState(USER_SCOPE, stackFor({
        name: 'EventDetail',
        params: { eventRef: { sourceEventId: 'event-1', occurrenceDate: '2026-07-17' } },
      }), NOW),
      ...overrides,
    });
  }

  it('restores a current, versioned, same-scope record', () => {
    const result = parsePersistedNavigationState(serialized(), USER_SCOPE, NOW);
    expect(result.restored).toBe(true);
    expect(currentRoute(result.state)?.name).toBe('EventDetail');
  });

  it.each([
    ['corrupt', '{not-json'],
    ['schema', serialized({ schema: `${NAVIGATION_STATE_SCHEMA}.future` })],
    ['version', serialized({ version: NAVIGATION_STATE_VERSION + 1 })],
    ['scope', serialized({ authScope: 'user:8' })],
    ['expired', serialized({ updatedAt: NOW - NAVIGATION_STATE_MAX_AGE_MS - 1 })],
    ['future', serialized({ updatedAt: NOW + NAVIGATION_STATE_FUTURE_TOLERANCE_MS + 1 })],
    ['state', serialized({ state: { index: 0, routes: [{ name: 'UnknownRoute' }] } })],
  ])('fails closed for a %s record', (failure, raw) => {
    const result = parsePersistedNavigationState(raw, USER_SCOPE, NOW);
    expect(result).toEqual({
      state: defaultNavigationState(USER_SCOPE),
      restored: false,
      failure,
    });
  });
});
