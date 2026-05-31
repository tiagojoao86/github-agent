import winston from "winston";
import Transport from 'winston-transport';
import { eventBus } from '../ui/event-bus.js';

const isProd = process.env.NODE_ENV === 'production';

class UITransport extends Transport {
  log(info: any, callback: () => void) {
    const { level, message, timestamp, ...meta } = info;
    eventBus.publish({
      type: 'log',
      level,
      message: String(message),
      meta: meta as Record<string, unknown>,
      issueNumber: typeof meta.issueNumber === 'number' ? meta.issueNumber : undefined,
      timestamp: timestamp ?? new Date().toISOString(),
    });
    callback();
  }
}

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
    new UITransport(),
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

