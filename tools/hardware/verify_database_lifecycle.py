"""Bounded actual-Hermes SQLite lifecycle probe; never writes business rows.

The separate probe database is always closed/deleted by the runtime itself.
An upstream report is a hypothesis, not evidence that LaoJi has that defect.
"""
import argparse
import json
import time
from pathlib import Path

from verify_live_repair import runtime


SQLITE_MODULE = 'node_modules/expo-sqlite/build/SQLiteDatabase.js'


def stress(workers, batches):
    expression = r'''m => {
      const state = {done:false, batches:0, workers:WORKERS, planned_batches:BATCHES};
      globalThis.__laojiDatabaseLifecycleProbe = state;
      const began = Date.now(); let db;
      const batch = () => {
        if (state.batches >= state.planned_batches) return;
        return Promise.all(Array.from({length:state.workers},(_,k) =>
          db.getFirstAsync('SELECT a,b FROM probe WHERE id=1').then(() =>
            db.runAsync('UPDATE probe SET a=?,b=? WHERE id=1', String(state.batches), k%2 ? 'x' : null))
        )).then(() => {
          // Keep moderate heap churn alive until the next statement turn.
          globalThis.__laojiDatabaseProbeGarbage = Array.from({length:5000},(_,i)=>({i}));
          state.batches++; return batch();
        });
      };
      m.openDatabaseAsync('laoji-lifecycle-probe.db', {useNewConnection:true})
        .then(value => { db=value; return db.execAsync('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY,a TEXT,b TEXT); INSERT OR REPLACE INTO probe VALUES(1,\'\',\'\');'); })
        .then(batch)
        .then(() => db.getFirstAsync('PRAGMA quick_check'))
        .then(row => { state.integrity=row.quick_check; })
        .catch(error => { state.error=String(error); })
        .then(() => db && db.closeAsync().catch(error=>{state.close_error=String(error);}))
        .then(() => m.deleteDatabaseAsync('laoji-lifecycle-probe.db').catch(error=>{state.delete_error=String(error);}))
        .then(() => { delete globalThis.__laojiDatabaseProbeGarbage;state.elapsed_ms=Date.now()-began;state.done=true; });
      return {started:true,workers:state.workers,planned_batches:state.planned_batches};
    }'''.replace('WORKERS', str(workers)).replace('BATCHES', str(batches))
    runtime(expression, SQLITE_MODULE)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        state = runtime('m => globalThis.__laojiDatabaseLifecycleProbe', SQLITE_MODULE)
        if state and state.get('done'):
            return state
        time.sleep(1)
    raise RuntimeError('Observe the same probe; do not start another while it is pending')


def main(args):
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = {'boundary': 'actual emulator-5562 Hermes/Expo SQLite; private separate probe DB',
              'runs': []}
    for _ in range(args.runs):
        run = stress(args.workers, args.batches)
        result['runs'].append(run)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(run, ensure_ascii=False), flush=True)
        if run.get('error') or run.get('close_error') or run.get('delete_error'):
            raise AssertionError('SQLite lifecycle probe failed; preserve this evidence')
        assert run['integrity'] == 'ok' and run['batches'] == args.batches


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=8, choices=range(1, 17))
    parser.add_argument('--batches', type=int, default=200, choices=range(1, 501))
    parser.add_argument('--runs', type=int, default=3, choices=range(1, 6))
    main(parser.parse_args())
