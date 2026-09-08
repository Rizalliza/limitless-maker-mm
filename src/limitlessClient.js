import { ethers } from 'ethers';
import {
  HttpClient,
  MarketFetcher,
  OrderClient,
  OrderType,
  Side,
} from '@limitless-exchange/sdk';

import config from './config.js';
import logger from './logger.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let clients;
let publicReadTail = Promise.resolve();
let nextPublicReadAt = 0;
let publicCooldownUntil = 0;

export async function initClients() {
  const options = { baseURL: config.apiUrl };

  if (!config.dryRun) {
    options.hmacCredentials = {
      tokenId: config.tokenId,
      secret: config.tokenSecret,
    };
  }

  const httpClient = new HttpClient(options);
  const marketFetcher = new MarketFetcher(httpClient);
  let wallet = null;
  let orderClient = null;

  if (!config.dryRun) {
    const provider = new ethers.JsonRpcProvider(config.baseRpcUrl, 8453);
    wallet = new ethers.Wallet(config.privateKey, provider);
    orderClient = new OrderClient({ httpClient, wallet, marketFetcher });
    logger.info(`Limitless EOA: ${wallet.address}`);
  }

  clients = { httpClient, marketFetcher, orderClient, wallet };
  return clients;
}

export function getClients() {
  if (!clients) throw new Error('Limitless clients are not initialized');
  return clients;
}

// Compatibility for any older module that imported the singular name.
export function getClient() {
  return getClients();
}

function enqueuePublicRead(task) {
  const result = publicReadTail.then(task, task);
  publicReadTail = result.catch(() => {});
  return result;
}

function retryDelayMs(response, body, attempt) {
  const headerSeconds = Number(response.headers.get('retry-after'));
  let bodySeconds = 0;

  try {
    bodySeconds = Number(JSON.parse(body)?.retry_after) || 0;
  } catch {
    // Error body is not JSON.
  }

  return Math.max(
    1_000 * (2 ** Math.max(0, attempt - 1)),
    Number.isFinite(headerSeconds) ? headerSeconds * 1_000 : 0,
    bodySeconds * 1_000,
  );
}

export async function fetchJson(path, { attempts = 3 } = {}) {
  return enqueuePublicRead(async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const waitMs = Math.max(
        0,
        nextPublicReadAt - Date.now(),
        publicCooldownUntil - Date.now(),
      );

      if (waitMs > 0) await pause(waitMs);
      nextPublicReadAt = Date.now() + config.discoveryRequestGapMs;

      const response = await fetch(`${config.apiUrl}${path}`, {
        headers: { accept: 'application/json' },
      });
      const body = await response.text();

      if (response.ok) return body ? JSON.parse(body) : null;

      if (response.status === 429 && attempt < attempts) {
        const delayMs = retryDelayMs(response, body, attempt);
        publicCooldownUntil = Date.now() + delayMs;
        logger.warn(
          `Limitless HTTP 429; public reads cooling down ${Math.ceil(delayMs / 1_000)}s`,
        );
        continue;
      }

      const error = new Error(
        `Limitless ${path}: HTTP ${response.status} ${body}`,
      );
      error.status = response.status;
      error.responseBody = body;
      throw error;
    }

    throw new Error(`Limitless ${path}: retries exhausted`);
  });
}

export async function getTimeline(asset) {
  const query = new URLSearchParams({
    symbol: asset,
    frequency: 'minutely',
    subFrequency: config.subFrequency,
    before: '1',
    after: '3',
  });

  return fetchJson(`/markets/timeline?${query}`);
}

export async function getMarket(slug) {
  // The SDK fetch also caches venue.exchange for later EIP-712 order signing.
  return getClients().marketFetcher.getMarket(slug);
}

export async function getOrderBook(slug) {
  return fetchJson(`/markets/${encodeURIComponent(slug)}/orderbook`);
}

export async function getMarketEvents(slug) {
  const result = await fetchJson(
    `/markets/${encodeURIComponent(slug)}/events?page=1&limit=20`,
  );

  return {
    ...(result || {}),
    events: Array.isArray(result?.events) ? result.events : [],
  };
}

export async function getMaintenanceStatus() {
  return fetchJson('/maintenance/status', { attempts: 2 });
}

export function buildMakerBuyParams({ market, tokenId, price, size }) {
  return {
    marketSlug: market.slug,
    tokenId,
    side: Side.BUY,
    price,
    size,
    orderType: OrderType.GTC,
    postOnly: true,
  };
}

export async function createMakerBuy({ market, tokenId, price, size }) {
  if (config.dryRun) {
    throw new Error('createMakerBuy cannot run while DRY_RUN=true');
  }

  return getClients().orderClient.createOrder(
    buildMakerBuyParams({ market, tokenId, price, size }),
  );
}

export async function cancelOrder(orderId) {
  if (!orderId) return true;
  if (config.dryRun) throw new Error('cancelOrder cannot run while DRY_RUN=true');

  try {
    await getClients().orderClient.cancel(orderId);
    logger.bot(`ORDER CANCELLED orderId=${orderId}`);
    return true;
  } catch (error) {
    logger.warn(`Cancel ${orderId} failed: ${error.message}`);
    return false;
  }
}

export async function emergencySell({ market, tokenId, price, size }) {
  if (config.dryRun) {
    throw new Error('emergencySell cannot run while DRY_RUN=true');
  }

  return getClients().orderClient.createOrder({
    marketSlug: market.slug,
    tokenId,
    side: Side.SELL,
    price,
    size,
    orderType: OrderType.FAK,
  });
}

export { OrderType, Side };
