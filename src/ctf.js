import { ethers } from 'ethers';
import config from './config.js';
import { getClients } from './limitlessClient.js';
import logger from './logger.js';

export const BASE_CHAIN_ID = 8453;
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const CTF_ADDRESS = '0xC9c98965297Bc527861c898329Ee280632B76e18';
export const ZERO_COLLECTION = ethers.ZeroHash;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
];

let readProviders = null;

function readProvider(attempt = 0) {
  if (!readProviders) {
    readProviders = config.baseRpcUrls.map(
      (url) => new ethers.JsonRpcProvider(url, BASE_CHAIN_ID),
    );
  }
  return readProviders[attempt % readProviders.length];
}

async function rpcRead(label, task) {
  for (let attempt = 1; attempt <= config.baseRpcReadAttempts; attempt += 1) {
    try {
      return await task(attempt - 1);
    } catch (error) {
      if (attempt >= config.baseRpcReadAttempts) throw error;
      const delayMs = config.baseRpcRetryMs * (2 ** (attempt - 1));
      logger.warn(
        `BASE RPC READ RETRY ${label} attempt=${attempt}/${config.baseRpcReadAttempts} ` +
        `endpoint=${((attempt - 1) % config.baseRpcUrls.length) + 1}/` +
        `${config.baseRpcUrls.length} delay=${delayMs}ms ` +
        `error=${error.shortMessage || error.message}`,
      );
      await pause(delayMs);
    }
  }
  throw new Error(`Base RPC read retries exhausted: ${label}`);
}

export async function assertBaseContracts() {
  if (config.dryRun) return;
  const network = await rpcRead('chainId', (attempt) => readProvider(attempt).getNetwork());
  if (network.chainId !== BigInt(BASE_CHAIN_ID)) {
    throw new Error(`BASE_RPC_URL returned chain ${network.chainId}; expected ${BASE_CHAIN_ID}`);
  }
  const code = await rpcRead(
    'CTF bytecode',
    (attempt) => readProvider(attempt).getCode(CTF_ADDRESS),
  );
  if (!code || code === '0x') {
    throw new Error(`No CTF contract bytecode at ${CTF_ADDRESS} on BASE_RPC_URL`);
  }
}

export async function getTokenBalance(tokenId) {
  if (config.dryRun) return 0;
  const { wallet } = getClients();
  const raw = await rpcRead(
    `CTF balanceOf token=${tokenId}`,
    (attempt) => new ethers.Contract(
      CTF_ADDRESS,
      CTF_ABI,
      readProvider(attempt),
    ).balanceOf(wallet.address, tokenId),
  );
  return Number(ethers.formatUnits(raw, 6));
}

export async function getUsdcBalance() {
  if (config.dryRun) return 0;
  const { wallet } = getClients();
  const raw = await rpcRead(
    'USDC balanceOf',
    (attempt) => new ethers.Contract(
      USDC_ADDRESS,
      ERC20_ABI,
      readProvider(attempt),
    ).balanceOf(wallet.address),
  );
  return Number(ethers.formatUnits(raw, 6));
}

export async function getBaseEthBalance() {
  if (config.dryRun) return 0;
  const { wallet } = getClients();
  const raw = await rpcRead(
    'Base ETH balance',
    (attempt) => readProvider(attempt).getBalance(wallet.address),
  );
  return Number(ethers.formatEther(raw));
}

export async function ensureVenueApprovals(market) {
  if (config.dryRun) return;
  const { wallet } = getClients();
  const exchange = market?.venue?.exchange;
  if (!exchange) throw new Error(`Market ${market.slug} has no venue.exchange`);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const allowance = await rpcRead(
    `USDC allowance exchange=${exchange}`,
    (attempt) => new ethers.Contract(
      USDC_ADDRESS,
      ERC20_ABI,
      readProvider(attempt),
    ).allowance(wallet.address, exchange),
  );
  const canaryAllowance = ethers.parseUnits(config.maxTotalUsdc.toFixed(6), 6);
  if (allowance < canaryAllowance) {
    logger.bot(
      `APPROVAL USDC submit spender=${exchange} amount=$${config.maxTotalUsdc.toFixed(2)}`,
    );
    const receipt = await (await usdc.approve(exchange, canaryAllowance)).wait();
    logger.bot(`APPROVAL USDC confirmed tx=${receipt.hash}`);
  } else if (allowance > canaryAllowance && config.liveCanaryOnly) {
    logger.warn(
      `Existing USDC allowance exceeds canary cap; bot-side cap remains ` +
      `$${config.maxTotalUsdc.toFixed(2)}`,
    );
  }
  const approved = await rpcRead(
    `CTF approval exchange=${exchange}`,
    (attempt) => new ethers.Contract(
      CTF_ADDRESS,
      CTF_ABI,
      readProvider(attempt),
    ).isApprovedForAll(wallet.address, exchange),
  );
  if (!approved) {
    logger.bot(`APPROVAL CTF submit operator=${exchange}`);
    const receipt = await (await ctf.setApprovalForAll(exchange, true)).wait();
    logger.bot(`APPROVAL CTF confirmed tx=${receipt.hash}`);
  }
}

export async function mergePositions(market, shares) {
  const floored = Math.floor(shares * 1_000_000) / 1_000_000;
  if (floored <= 0) throw new Error('Merge amount must be positive');
  if (config.dryRun) {
    logger.bot(`[OBSERVE] Would merge ${floored.toFixed(6)} YES+NO pairs`);
    return { simulation: true, recovered: floored };
  }
  if (!market.conditionId) throw new Error(`Market ${market.slug} has no conditionId`);
  const { wallet } = getClients();
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
  const overrides = config.mergeGasLimit > 0 ? { gasLimit: BigInt(config.mergeGasLimit) } : {};
  const tx = await ctf.mergePositions(
    market.collateralToken?.address || USDC_ADDRESS,
    ZERO_COLLECTION,
    market.conditionId,
    [1, 2],
    ethers.parseUnits(floored.toFixed(6), 6),
    overrides,
  );
  logger.bot(`MERGE SUBMITTED ${market.slug} pairs=${floored.toFixed(6)} tx=${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`Merge reverted: ${tx.hash}`);
  logger.bot(`MERGE CONFIRMED ${market.slug} pairs=${floored.toFixed(6)} tx=${tx.hash}`);
  return {
    txHash: tx.hash,
    recovered: floored,
    gasUsed: receipt.gasUsed?.toString() || null,
  };
}
