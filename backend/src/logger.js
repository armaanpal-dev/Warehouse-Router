/** Minimal structured logger: one JSON object per line, so logs are greppable and shippable as-is. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const log = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const line = { t: new Date().toISOString(), level: lvl, msg, ...fields };
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
