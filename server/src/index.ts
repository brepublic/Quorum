import {mkdir} from 'node:fs/promises';
import pg from 'pg';
import {loadConfig} from './config.js';
import {runMigrations} from './db/migrations.js';
import {createApp} from './http/app.js';
import {createLogger} from './logger.js';
import {createHealthService} from './operations/health.js';

const {Pool} = pg;
const logger = createLogger();

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

  try {
    await mkdir(config.storagePath, {recursive: true});
    const migrationState = await runMigrations(pool, config.migrationsDirectory);
    logger.info('database.migrations.completed', {
      migrationVersion: migrationState.latestAppliedVersion
    });

    const health = createHealthService({
      pool,
      migrationsDirectory: config.migrationsDirectory,
      storagePath: config.storagePath
    });
    const server = createApp({
      health,
      logger,
      version: config.version,
      databaseMigrationVersion: migrationState.latestAvailableVersion
    });

    server.listen(config.port, config.host, () => {
      logger.info('server.started', {
        host: config.host,
        port: config.port,
        version: config.version
      });
    });

    let shuttingDown = false;
    async function shutdown(signal: NodeJS.Signals): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info('server.shutdown.started', {signal});

      const forceTimer = setTimeout(() => {
        logger.error('server.shutdown.timed_out', {graceMs: config.shutdownGraceMs});
        process.exit(1);
      }, config.shutdownGraceMs);
      forceTimer.unref();

      server.close(async error => {
        if (error) {
          logger.error('server.shutdown.failed', {error});
          process.exitCode = 1;
        }
        await pool.end();
        clearTimeout(forceTimer);
        logger.info('server.shutdown.completed');
      });
    }

    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    await pool.end();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  logger.error('server.startup.failed', {error});
  process.exitCode = 1;
}
