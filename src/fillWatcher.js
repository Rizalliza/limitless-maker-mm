import { EventEmitter } from 'node:events';
import { WebSocketClient } from '@limitless-exchange/sdk';

import config from './config.js';
import logger from './logger.js';
import { getMarketEvents } from './limitlessClient.js';

function settlementKey(event) {
  return [
    event.tradeEventId || event.txHash || event.eventId || '?',
    event.orderId || '?',
  ].join(':');
}

function marketTradeKey(slug, event) {
  return event.txHash || [
    slug,
    event.createdAt,
    event.tokenId,
    event.matchedSize,
    event.price,
  ].join(':');
}

export class FillWatcher extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.books = new Map();
    this.eventsByOrder = new Map();
    this.settlements = new Map();
    this.latestSettlementByOrder = new Map();
    this.ownedOrderIds = new Set();
    this.marketTokens = new Map();
    this.marketSlugs = new Set();
    this.activitySlugs = new Set();
    this.activityInitialized = new Set();
    this.knownMarketTrades = new Set();
    this.latestMarketTradeBySlug = new Map();
    this.bookEventCount = 0;
    this.marketTradeCount = 0;
    this.activityTimer = null;
    this.initialConnectPending = false;
  }

  async start() {
    if (this.ws) return;

    const options = { url: config.wsUrl, autoReconnect: true };
    if (!config.dryRun) {
      options.hmacCredentials = {
        tokenId: config.tokenId,
        secret: config.tokenSecret,
      };
    }

    this.ws = new WebSocketClient(options);

    this.ws.on('orderbookUpdate', (event) => {
      if (!event?.marketSlug || !event?.orderbook) return;
      this.recordBook(event.marketSlug, event.orderbook, 'WS');
    });

    this.ws.on('orderEvent', (event) => this.handleOrderEvent(event));
    this.ws.on('connect', () => {
      if (this.initialConnectPending) return;
      void this.restoreSubscriptions().catch((error) => {
        logger.error(`Limitless WebSocket resubscribe failed: ${error.message}`);
      });
    });
    this.ws.on('exception', (error) => {
      logger.error(
        `Limitless WebSocket exception: ${error?.message || JSON.stringify(error)}`,
      );
    });
    this.ws.on('error', (error) => logger.error(`Limitless WebSocket error: ${error.message}`));
    this.ws.on('reconnecting', (attempt) => logger.warn(`Limitless WebSocket reconnect ${attempt}`));
    this.ws.on('disconnect', (reason) => logger.warn(`Limitless WebSocket disconnected: ${reason}`));

    this.initialConnectPending = true;
    try {
      await this.ws.connect();
    } finally {
      this.initialConnectPending = false;
    }
    if (!config.dryRun) await this.ws.subscribe('subscribe_order_events');

    this.activityTimer = setInterval(
      () => void this.pollMarketActivity(),
      config.marketActivityPollMs,
    );

    logger.success(
      `Limitless WebSocket connected (${config.dryRun ? 'public market data' : 'market + private orders'})`,
    );
  }

  async restoreSubscriptions() {
    if (!this.ws) return;
    if (this.marketSlugs.size > 0) {
      await this.ws.subscribe('subscribe_market_prices', {
        marketSlugs: [...this.marketSlugs],
      });
    }
    if (!config.dryRun) {
      await this.ws.subscribe('subscribe_order_events');
    }
  }

  recordBook(slug, orderbook, source = 'REST') {
    const snapshot = {
      ...orderbook,
      source,
      receivedAt: Date.now(),
    };
    this.books.set(slug, snapshot);
    if (source === 'WS') this.bookEventCount += 1;
    this.emit(`book:${slug}`, snapshot);
    this.emit('wake', { type: 'BOOK', marketSlug: slug, orderbook: snapshot });
    return snapshot;
  }

  registerMarket(market) {
    if (!market?.slug) return;
    this.marketTokens.set(market.slug, {
      yes: String(market.tokens?.yes || ''),
      no: String(market.tokens?.no || ''),
    });
  }

  async watchMarket(slug, { activity = false } = {}) {
    if (!slug) return;
    if (!this.ws) throw new Error('FillWatcher.start() must run before watchMarket()');

    const isNewSubscription = !this.marketSlugs.has(slug);
    if (isNewSubscription) {
      this.marketSlugs.add(slug);

      while (this.marketSlugs.size > config.marketWsMaxSlugs) {
        const evicted = this.marketSlugs.values().next().value;
        this.marketSlugs.delete(evicted);
        this.activitySlugs.delete(evicted);
        this.books.delete(evicted);
        this.marketTokens.delete(evicted);
      }

      await this.ws.subscribe('subscribe_market_prices', {
        marketSlugs: [...this.marketSlugs],
      });
    }

    if (activity && !this.activitySlugs.has(slug)) {
      this.activitySlugs.add(slug);
      void this.pollMarketActivity(slug, true);
    }
  }

  getBook(slug, { maxAgeMs = Infinity } = {}) {
    const snapshot = this.books.get(slug) || null;
    if (!snapshot) return null;
    if (Date.now() - snapshot.receivedAt > maxAgeMs) return null;
    return snapshot;
  }

  getBookAgeMs(slug) {
    const snapshot = this.books.get(slug);
    return snapshot ? Math.max(0, Date.now() - snapshot.receivedAt) : Infinity;
  }

  waitForBook(slug, ms) {
    return new Promise((resolve) => {
      const eventName = `book:${slug}`;
      const timer = setTimeout(() => {
        this.off(eventName, onBook);
        resolve(null);
      }, Math.max(0, ms));

      const onBook = (book) => {
        clearTimeout(timer);
        this.off(eventName, onBook);
        resolve(book);
      };

      this.on(eventName, onBook);
    });
  }

  handleOrderEvent(event) {
    if (!event) return;
    if (event.orderId) this.eventsByOrder.set(event.orderId, event);
    if (event.clientOrderId) this.eventsByOrder.set(event.clientOrderId, event);

    const owned = this.ownedOrderIds.has(event.orderId)
      || this.ownedOrderIds.has(event.clientOrderId);
    const logOrder = owned ? logger.bot : logger.info;
    const prefix = owned ? '' : 'ACCOUNT ';

    if (event.source === 'OME') {
      logOrder(
        `${prefix}ORDER ${event.type || '?'} orderId=${event.orderId || '?'} ` +
        `status=${event.status || '-'} remaining=${event.remainingSize ?? '-'}`,
      );
    }

    if (event.source === 'SETTLEMENT') {
      const key = settlementKey(event);
      const previous = this.settlements.get(key);
      const previousIsTerminal = ['MINED', 'FAILED'].includes(previous?.type);
      if (!(previousIsTerminal && event.type === 'MATCHED')) {
        this.settlements.set(key, event);
      }
      if (event.orderId) {
        const latest = this.latestSettlementByOrder.get(event.orderId);
        const latestIsTerminal = ['MINED', 'FAILED'].includes(latest?.type);
        if (!(latestIsTerminal && event.type === 'MATCHED')) {
          this.latestSettlementByOrder.set(event.orderId, event);
        }
      }

      logOrder(
        `${prefix}SETTLEMENT ${event.type || '?'} orderId=${event.orderId || '?'} ` +
        `side=${event.side || '?'} size=${event.amountContracts ?? event.matchedSize ?? '?'} ` +
        `price=${event.price ?? '?'} tx=${event.txHash || '-'}`,
      );
    }

    this.emit('wake', event);
  }

  trackOwnedOrders(orderIds) {
    for (const orderId of orderIds.filter(Boolean)) {
      this.ownedOrderIds.add(orderId);
    }
  }

  recordMarketTrade(slug, event, { log = true } = {}) {
    const tokens = this.marketTokens.get(slug);
    const token = String(event?.tokenId || '');
    const outcome = token && token === tokens?.yes
      ? 'YES'
      : token && token === tokens?.no
        ? 'NO'
        : String(event?.outcome || 'UNKNOWN').toUpperCase();
    const rawSize = Number(event?.matchedSize ?? event?.amountContracts ?? 0);
    const shares = rawSize >= 1_000_000 ? rawSize / 1_000_000 : rawSize;
    const price = Number(event?.price);
    const yesEquivalentPrice = outcome === 'YES'
      ? price
      : outcome === 'NO'
        ? 1 - price
        : null;
    const trade = {
      ...event,
      slug,
      outcome,
      shares,
      price,
      yesEquivalentPrice,
      observedAt: Date.now(),
    };

    if (Number.isFinite(price) && Number.isFinite(yesEquivalentPrice)) {
      this.latestMarketTradeBySlug.set(slug, trade);
    }
    this.marketTradeCount += 1;

    if (log) {
      logger.market(
        `TRADE MINED ${slug} outcome=${outcome} shares=${shares.toFixed(3)} ` +
        `price=${price.toFixed(3)} tx=${event?.txHash || '-'}`,
      );
    }

    this.emit(`marketTrade:${slug}`, trade);
    this.emit('wake', { type: 'MARKET_TRADE', marketSlug: slug, trade });
    return trade;
  }

  async pollMarketActivity(onlySlug = null, includeExisting = false) {
    const slugs = onlySlug ? [onlySlug] : [...this.activitySlugs];

    for (const slug of slugs) {
      try {
        const page = await getMarketEvents(slug);
        const events = page.events;
        const initialized = this.activityInitialized.has(slug);
        const initialVisible = new Set(includeExisting ? events.slice(0, 3) : []);

        for (const event of [...events].reverse()) {
          const key = marketTradeKey(slug, event);
          const known = this.knownMarketTrades.has(key);
          this.knownMarketTrades.add(key);
          if (known || (!initialized && !initialVisible.has(event))) continue;

          this.recordMarketTrade(slug, event);
        }

        this.activityInitialized.add(slug);
        if (includeExisting) {
          logger.market(`${slug}: finalized trades currently visible=${events.length}`);
        }
      } catch (error) {
        if (error.status !== 404) {
          logger.warn(`Market activity ${slug} failed: ${error.message}`);
        }
      }
    }
  }

  last(orderId) {
    return this.eventsByOrder.get(orderId);
  }

  lastMarketTrade(slug, { maxAgeMs = Infinity } = {}) {
    const trade = this.latestMarketTradeBySlug.get(slug) || null;
    if (!trade) return null;
    if (Date.now() - trade.observedAt > maxAgeMs) return null;
    return trade;
  }

  minedFills(orderIds) {
    const wanted = new Set(orderIds.filter(Boolean));
    return [...this.settlements.values()].filter(
      (event) => event.type === 'MINED' && wanted.has(event.orderId),
    );
  }

  hasPending(orderIds) {
    return orderIds.filter(Boolean).some(
      (orderId) => this.latestSettlementByOrder.get(orderId)?.type === 'MATCHED',
    );
  }

  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('wake', onWake);
        resolve(null);
      }, ms);
      const onWake = (event) => {
        clearTimeout(timer);
        this.off('wake', onWake);
        resolve(event);
      };
      this.on('wake', onWake);
    });
  }

  stats() {
    return {
      connected: Boolean(this.ws?.isConnected()),
      watchedMarkets: this.marketSlugs.size,
      books: this.books.size,
      bookEvents: this.bookEventCount,
      marketTrades: this.marketTradeCount,
    };
  }

  async stop() {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
    await this.ws?.disconnect();
    this.ws = null;
  }
}

export const fillWatcher = new FillWatcher();
