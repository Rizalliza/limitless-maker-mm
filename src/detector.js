import config from './config.js';
import { getTimeline, getMarket } from './limitlessClient.js';
import logger from './logger.js';

export class MarketDetector {
  constructor(onMarket, onWarm = null) {
    this.onMarket = onMarket;
    this.onWarm = onWarm;
    this.timer = null;
    this.stopped = false;
    this.seen = new Set();
    this.warmed = new Set();
    this.unavailableUntil = new Map();
  }

  async warm(asset, slot) {
    if (!slot?.slug || this.warmed.has(slot.slug)) return;
    const market = await getMarket(slot.slug);
    if (this.onWarm) await this.onWarm(market, { current: false });
    this.warmed.add(slot.slug);
    logger.info(`${asset}: pre-fetched and subscribed ${slot.slug}`);
  }

  async pollAsset(asset) {
    if ((this.unavailableUntil.get(asset) || 0) > Date.now()) return;
    const timeline = await getTimeline(asset);
    this.unavailableUntil.delete(asset);
    await this.warm(asset, timeline?.next);
    const slot = timeline?.current;
    if (!slot?.slug || slot.state !== 'OPEN' || slot.tradable !== true) return;
    if (this.seen.has(slot.slug)) return;

    const now = Date.now();
    const startMs = Date.parse(slot.startAt);
    const endMs = Date.parse(slot.endAt);
    if (Number.isFinite(startMs) && now < startMs) return;
    if (Number.isFinite(endMs) && now >= endMs) return;

    const market = await getMarket(slot.slug);
    if (market.tradeType !== 'clob' || !market.tokens?.yes || !market.tokens?.no) return;
    this.seen.add(slot.slug);
    if (this.onWarm) await this.onWarm(market, { current: true });
    const detected = {
      ...market,
      asset,
      startAt: slot.startAt || market.startAt,
      endAt: slot.endAt || market.expirationDate,
      timelineState: slot.state,
      tradable: slot.tradable,
    };
    void Promise.resolve(this.onMarket(detected)).catch((error) => {
      this.seen.delete(slot.slug);
      logger.error(`Market callback ${slot.slug} failed: ${error.message}`);
    });
    if (this.seen.size > 5_000) this.seen = new Set([...this.seen].slice(-2_500));
    if (this.warmed.size > 5_000) this.warmed = new Set([...this.warmed].slice(-2_500));
  }

  async poll() {
    for (const asset of config.assets) {
      try {
        await this.pollAsset(asset);
      } catch (error) {
        const noSlot = error.status === 404
          && error.responseBody?.includes('Current timeline slot has no market slug');
        if (noSlot) {
          this.unavailableUntil.set(asset, Date.now() + config.timelineNoSlotBackoffMs);
          logger.info(
            `${asset}: no ${config.subFrequency} timeline slot currently available; ` +
            `retrying in ${Math.ceil(config.timelineNoSlotBackoffMs / 1_000)}s`,
          );
        } else {
          logger.warn(`Timeline poll ${asset} failed: ${error.message}`);
        }
      }
    }
  }

  async start() {
    this.stopped = false;
    const run = async () => {
      if (this.stopped) return;
      try {
        await this.poll();
      } finally {
        if (!this.stopped) this.timer = setTimeout(run, config.pollMs);
      }
    };
    await run();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
