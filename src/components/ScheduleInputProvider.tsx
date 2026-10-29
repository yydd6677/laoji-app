import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { acknowledgeHardwareRecording, addHardwareRecordingListener, hasNativeHardwareSupport,
  listPendingHardwareRecordings } from 'laoji-native-platform';
import { enqueueScheduleInput, listScheduleInputs, updateScheduleInput, deferScheduleInput,
  finishScheduleInput } from '../data/repositories/scheduleInputRepository';
import { parseAudio } from '../services/scheduleParsing';
import { scheduleInputContext, scheduleInputDraft, type ScheduleInputJob } from '../services/scheduleInput';
import { isLocalDataErasing, localDataEraseRevision } from '../services/localDataEraseState';

const Context = createContext<{ jobs: ScheduleInputJob[]; refresh: () => void }>({ jobs: [], refresh: () => {} });
export const useScheduleInputs = () => useContext(Context);

/** Shares the calendar's durable input owner; no Meeting or summary is created for dictation. */
export function ScheduleInputProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<ScheduleInputJob[]>([]);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!hasNativeHardwareSupport()) return;
    let active = true, running = false, rerun = false;
    const run = async () => {
      if (!active || isLocalDataErasing()) return;
      if (running) { rerun = true; return; }
      running = true;
      const epoch = localDataEraseRevision();
      const valid = () => active && !isLocalDataErasing() && epoch === localDataEraseRevision();
      try {
        for (const source of await listPendingHardwareRecordings()) {
          if (!valid()) return;
          if (source.purpose !== 'schedule') continue;
          const input = await enqueueScheduleInput(source);
          if (input.state === 'saved' || input.state === 'dismissed') await acknowledgeHardwareRecording(source.recordingId);
        }
        const inputs = await listScheduleInputs();
        if (valid()) setJobs(await listScheduleInputs('display'));
        for (const input of inputs) {
          if (!valid()) return;
          if (input.state !== 'pending') continue;
          try {
            const result = await parseAudio(input.source.localUri, scheduleInputContext(input.source));
            if (!valid()) return;
            await updateScheduleInput(input.id, scheduleInputDraft(input.source, result));
          } catch {
            if (valid()) await deferScheduleInput(input.id);
          }
        }
        if (valid()) setJobs(await listScheduleInputs('display'));
      } catch { /* Durable source remains queued; retry does not invent an error dialog. */ }
      finally { running = false; if (rerun && active) { rerun = false; void run(); } }
    };
    refresh.current = () => { void run(); };
    const received = addHardwareRecordingListener(() => { void run(); });
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void run(); });
    const timer = setInterval(() => { void run(); }, 3_000);
    void run();
    return () => { active = false; received.remove(); foreground.remove(); clearInterval(timer); };
  }, []);
  return <Context.Provider value={{ jobs, refresh: () => refresh.current() }}>{children}</Context.Provider>;
}

export async function discardScheduleInput(job: ScheduleInputJob): Promise<void> {
  await finishScheduleInput(job.id, 'dismissed');
  await acknowledgeHardwareRecording(job.source.recordingId);
}
