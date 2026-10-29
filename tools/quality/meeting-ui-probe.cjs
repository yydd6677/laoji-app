// Development-runtime observation only: no application instrumentation or content.
const { openCdp } = require('../hardware/runtime_cdp.cjs');
const { selectRuntimeTarget } = require('../hardware/runtime_module.cjs');
const { acquireInspectionLock } = require('../hardware/inspection_lock.cjs');

function installProbe() {
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || globalThis.__laojiMeetingUiProbe) throw Error('Probe unavailable or already active');
  const probe = { started: performance.now(), events: [], instances: new WeakMap(), nextId: 1,
    previous: '', originals: [], commits: [], layouts: [], layoutKeys: {}, active: true };
  globalThis.__laojiMeetingUiProbe = probe;
  const identity = value => {
    if (!value || typeof value !== 'object') return null;
    if (!probe.instances.has(value)) probe.instances.set(value, probe.nextId++);
    return probe.instances.get(value);
  };
  const inspect = () => {
    const targets = [];
    let sawDetail = false;
    const visit = fiber => {
      if (!fiber) return;
      const name = typeof fiber.type === 'function' ? fiber.type.name : '';
      const testId = fiber.memoizedProps?.testID;
      const snapshot = fiber.memoizedProps?.snapshot;
      if (!sawDetail && snapshot?.surface === 'detail' && snapshot.detail) {
        sawDetail = true;
        targets.push({ role: 'detail-projection', authenticated: Boolean(snapshot.projection),
          summaryCount: snapshot.detail.summary?.length || 0,
          actionCount: snapshot.detail.actions?.length || 0,
          phase: snapshot.detail.pageStates?.summary?.phase });
      }
      if (name === 'MeetingQuestionSheet' || name === 'TranscriptionScreen') {
        const id = identity(fiber.alternate || fiber);
        probe.instances.set(fiber, id);
        targets.push({ role: name, instance: id });
      }
      if (typeof fiber.type === 'string' && /^meeting-question-(sheet|input|send|history|new-thread|new-thread-placeholder)$/.test(testId || '')) {
        const instance = fiber.stateNode?.canonical?.publicInstance || fiber.stateNode;
        targets.push({ role: testId, instance: identity(instance), editable: fiber.memoizedProps.editable,
          focused: typeof instance?.isFocused === 'function' ? instance.isFocused() : undefined });
        if (typeof instance?.measureInWindow === 'function') instance.measureInWindow((x, y, width, height) => {
          if (!probe.active || probe.layouts.length >= 4000) return;
          const bounds = [x, y, width, height].map(value => Math.round(value * 10) / 10);
          const key = JSON.stringify([identity(instance), bounds]);
          if (probe.layoutKeys[testId] === key) return;
          probe.layoutKeys[testId] = key;
          probe.layouts.push({ ms: performance.now() - probe.started, role: testId, instance: identity(instance), bounds });
        });
      }
      visit(fiber.child); visit(fiber.sibling);
    };
    for (const renderer of hook.renderers.keys()) hook.getFiberRoots(renderer).forEach(root => visit(root.current));
    const key = JSON.stringify(targets);
    if (key !== probe.previous && probe.events.length < 4000) {
      probe.events.push({ ms: performance.now() - probe.started, targets });
      probe.previous = key;
    }
  };
  // Observe actual commits through the installed DevTools renderer interface.
  // A perpetual rAF/measure loop itself prevents UIAutomator from becoming idle
  // and distorts the workflow being measured. No continuous animation/polling.
  for (const renderer of hook.rendererInterfaces.values()) {
    const original = renderer.handleCommitFiberRoot;
    if (typeof original !== 'function') continue;
    probe.originals.push({ renderer, original });
    renderer.handleCommitFiberRoot = function (...args) {
      const result = original.apply(this, args);
      if (probe.active) {
        if (probe.commits.length < 4000) probe.commits.push(performance.now() - probe.started);
        inspect();
        cancelAnimationFrame(probe.raf);
        probe.raf = requestAnimationFrame(() => { if (probe.active) inspect(); });
      }
      return result;
    };
  }
  if (!probe.originals.length) { delete globalThis.__laojiMeetingUiProbe; throw Error('No active renderer interface'); }
  // Never leave an unbounded observation running if the caller is interrupted.
  probe.expiry = setTimeout(() => {
    probe.originals.forEach(({ renderer, original }) => { renderer.handleCommitFiberRoot = original; });
    probe.active = false;
    cancelAnimationFrame(probe.raf);
  }, 120_000);
  inspect();
  return { observing: true, maximumSeconds: 120 };
}

function finishProbe() {
  const probe = globalThis.__laojiMeetingUiProbe;
  if (!probe) throw Error('No active probe');
  probe.originals.forEach(({ renderer, original }) => { renderer.handleCommitFiberRoot = original; });
  probe.active = false;
  cancelAnimationFrame(probe.raf);
  clearTimeout(probe.expiry);
  const result = { elapsedMs: performance.now() - probe.started, events: probe.events, layouts: probe.layouts, commitTimesMs: probe.commits };
  delete globalThis.__laojiMeetingUiProbe;
  return result;
}

async function main() {
  const action = process.argv[2];
  if (!['start', 'stop'].includes(action)) throw Error('Expected start or stop');
  const release = await acquireInspectionLock();
  let cdp;
  try {
    const targets = await (await fetch('http://127.0.0.1:8083/json/list', { signal: AbortSignal.timeout(5000) })).json();
    cdp = await openCdp(WebSocket, selectRuntimeTarget(targets).webSocketDebuggerUrl);
    const response = await cdp.evaluate(`JSON.stringify((${action === 'start' ? installProbe : finishProbe})())`);
    if (response.error || response.result?.exceptionDetails) throw Error(JSON.stringify(response));
    process.stdout.write(response.result.result.value + '\n');
  } finally { cdp?.close(); release(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
