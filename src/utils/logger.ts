import winston from "winston";

const isProd = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: isProd
    ? winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    )
    : winston.format.combine(
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length
          ? '\n ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n ')
          : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
      })
    ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/agent.log',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// Helper para criar logger com contexto fixo (ex: issue #42)
export function createContextLogger(context: Record<string, unknown>) {
  return {
    info: (msg: string, meta?: Record<string, unknown>) =>
      logger.info(msg, { ...context, ...meta }),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      logger.warn(msg, { ...context, ...meta }),
    error: (msg: string, meta?: Record<string, unknown>) =>
      logger.error(msg, { ...context, ...meta }),
    debug: (msg: string, meta?: Record<string, unknown>) =>
      logger.debug(msg, { ...context, ...meta }),
  };
}

