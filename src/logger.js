const stamp = () => new Date().toISOString();

function write(level, ...args) {
  const output = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  output(`[${stamp()}] [${level}]`, ...args);
}

export default {
  info: (...args) => write('INFO', ...args),
  success: (...args) => write('OK', ...args),
  warn: (...args) => write('WARN', ...args),
  error: (...args) => write('ERROR', ...args),
  market: (...args) => write('MARKET', ...args),
  book: (...args) => write('BOOK', ...args),
  quote: (...args) => write('QUOTE', ...args),
  bot: (...args) => write('BOT', ...args),
  // Kept only for compatibility with existing modules. Use pnl for bot PnL.
  money: (...args) => write('PNL', ...args),
  pnl: (...args) => write('PNL', ...args),
};
