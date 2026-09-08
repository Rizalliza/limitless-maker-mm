import logger from './logger.js';

class PerformanceTracker {
  constructor() {
    this.paper = {
      cycles: 0,
      pairedCycles: 0,
      pairedShares: 0,
      grossBeforeCosts: 0,
      oneSidedCycles: 0,
    };
    this.live = {
      cycles: 0,
      confirmedPairedCycles: 0,
      pairedShares: 0,
      grossBeforeGas: 0,
      oneSidedCycles: 0,
    };
  }

  recordPaper({ paired = 0, gross = 0, oneSided = false } = {}) {
    this.paper.cycles += 1;
    if (paired > 0) {
      this.paper.pairedCycles += 1;
      this.paper.pairedShares += paired;
      this.paper.grossBeforeCosts += gross;
    }
    if (oneSided) this.paper.oneSidedCycles += 1;
  }

  recordLive({ paired = 0, gross = 0, oneSided = false } = {}) {
    this.live.cycles += 1;
    if (paired > 0) {
      this.live.confirmedPairedCycles += 1;
      this.live.pairedShares += paired;
      this.live.grossBeforeGas += gross;
    }
    if (oneSided) this.live.oneSidedCycles += 1;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ paper: this.paper, live: this.live }));
  }

  logSummary() {
    logger.pnl(
      `SESSION PAPER cycles=${this.paper.cycles} paired=${this.paper.pairedCycles} ` +
      `pairs=${this.paper.pairedShares.toFixed(3)} ` +
      `grossBeforeCosts=$${this.paper.grossBeforeCosts.toFixed(4)} ` +
      `oneSided=${this.paper.oneSidedCycles}`,
    );
    logger.pnl(
      `SESSION LIVE cycles=${this.live.cycles} confirmedPaired=${this.live.confirmedPairedCycles} ` +
      `pairs=${this.live.pairedShares.toFixed(3)} ` +
      `grossBeforeGas=$${this.live.grossBeforeGas.toFixed(4)} ` +
      `oneSided=${this.live.oneSidedCycles}`,
    );
  }
}

export const performanceTracker = new PerformanceTracker();
export { PerformanceTracker };
