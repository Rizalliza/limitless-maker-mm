import test from 'node:test';
import assert from 'node:assert/strict';

import { PerformanceTracker } from '../src/performanceTracker.js';

test('separates paper estimates from confirmed live results', () => {
  const tracker = new PerformanceTracker();
  tracker.recordPaper({ paired: 20, gross: 0.4, oneSided: false });
  tracker.recordPaper({ paired: 0, gross: 0, oneSided: true });
  tracker.recordLive({ paired: 10, gross: 0.2, oneSided: false });

  assert.deepEqual(tracker.snapshot(), {
    paper: {
      cycles: 2,
      pairedCycles: 1,
      pairedShares: 20,
      grossBeforeCosts: 0.4,
      oneSidedCycles: 1,
    },
    live: {
      cycles: 1,
      confirmedPairedCycles: 1,
      pairedShares: 10,
      grossBeforeGas: 0.2,
      oneSidedCycles: 0,
    },
  });
});
