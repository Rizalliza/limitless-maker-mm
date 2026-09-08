const reservations = new Map();
let queue = Promise.resolve();

function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

export function reservedUsdc() {
  return [...reservations.values()].reduce((sum, value) => sum + value, 0);
}

export function reserveUsdc(
  key,
  amount,
  walletBalance,
  { maxCycle = Infinity, maxTotal = Infinity } = {},
) {
  return serialized(async () => {
    if (amount > maxCycle + 1e-9) {
      throw new Error(
        `Cycle USDC cap exceeded: required $${amount.toFixed(6)}, ` +
        `cap $${maxCycle.toFixed(6)}`,
      );
    }

    const current = reservations.get(key) || 0;
    const otherReserved = reservedUsdc() - current;
    const available = walletBalance - otherReserved;

    if (otherReserved + amount > maxTotal + 1e-9) {
      throw new Error(
        `Session USDC cap exceeded: required total $${(otherReserved + amount).toFixed(6)}, ` +
        `cap $${maxTotal.toFixed(6)}`,
      );
    }

    if (amount > available + 1e-9) {
      throw new Error(
        `Insufficient unreserved USDC: required $${amount.toFixed(6)}, ` +
        `available $${Math.max(0, available).toFixed(6)}`,
      );
    }

    reservations.set(key, amount);
    return { amount, availableAfter: available - amount };
  });
}

export function releaseUsdc(key) {
  return serialized(async () => {
    const amount = reservations.get(key) || 0;
    reservations.delete(key);
    return amount;
  });
}

export function resetCapitalReservationsForTests() {
  reservations.clear();
}
