import type { MinutesDetailTab } from 'laoji-native-platform';
import {
  NativeMinutesPageGenerationClock,
  type NativeMinutesPageGenerations,
} from './nativeMinutesSnapshots';

/** MIN-DETAIL-PAGER-001: owner tokens reject late work across both route and Expo queues. */
export interface NativeMinutesRequestToken {
  meetingId: string;
  generations: Partial<NativeMinutesPageGenerations>;
}

export class NativeMinutesRequestCoordinator {
  private readonly clock: NativeMinutesPageGenerationClock;

  constructor(initial: Partial<NativeMinutesPageGenerations> = {}) {
    this.clock = new NativeMinutesPageGenerationClock(initial);
  }

  advance(...tabs: readonly MinutesDetailTab[]): NativeMinutesPageGenerations {
    return this.clock.advance(...tabs);
  }

  begin(meetingId: string, ...tabs: readonly MinutesDetailTab[]): {
    token: NativeMinutesRequestToken;
    generations: NativeMinutesPageGenerations;
  } {
    const generations = this.advance(...tabs);
    return {
      generations,
      token: {
        meetingId,
        generations: Object.fromEntries(tabs.map(tab => [tab, generations[tab]])),
      },
    };
  }

  capture(meetingId: string, ...tabs: readonly MinutesDetailTab[]): NativeMinutesRequestToken {
    const generations = this.clock.snapshot();
    return {
      meetingId,
      generations: Object.fromEntries(tabs.map(tab => [tab, generations[tab]])),
    };
  }

  isCurrent(token: NativeMinutesRequestToken, routeMeetingId: string): boolean {
    if (token.meetingId !== routeMeetingId) return false;
    const current = this.clock.snapshot();
    return Object.entries(token.generations).every(([tab, generation]) => (
      current[tab as MinutesDetailTab] === generation
    ));
  }

  snapshot(): NativeMinutesPageGenerations {
    return this.clock.snapshot();
  }
}

export interface NativeMinutesTabOwnerState {
  meetingId: string;
  tab: MinutesDetailTab;
  generation: number;
}

export class NativeMinutesTabSelectionOwner {
  private state: NativeMinutesTabOwnerState;

  constructor(initial: NativeMinutesTabOwnerState) {
    this.state = { ...initial };
  }

  current(): NativeMinutesTabOwnerState {
    return { ...this.state };
  }

  accept(next: NativeMinutesTabOwnerState): boolean {
    if (next.meetingId !== this.state.meetingId) {
      this.state = { ...next };
      return true;
    }
    if (next.generation < this.state.generation) return false;
    if (next.generation === this.state.generation && next.tab !== this.state.tab) return false;
    this.state = { ...next };
    return true;
  }
}
