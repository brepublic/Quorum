import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {loadConfig} from './config.js';
import {runMigrations} from './db/migrations.js';
import {createApp} from './http/app.js';
import {createLogger} from './logger.js';
import {createHealthService} from './operations/health.js';
import {PostgresIdentityStore} from './modules/identity/postgres.js';
import {IdentityService} from './modules/identity/service.js';
import {Stage3Service} from './modules/stage3/service.js';
import {Stage4Service} from './modules/stage4/service.js';
import {RealtimeService} from './modules/realtime/service.js';
import {Stage5Service} from './modules/stage5/service.js';
import {DurableStagingStore} from './modules/storage/staging.js';
import {Stage6UploadService} from './modules/storage/upload-service.js';

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
    const identity = new IdentityService(new PostgresIdentityStore(pool));
    const stage3 = new Stage3Service(pool);
    const stage4 = new Stage4Service(pool);
    const realtime = new RealtimeService(pool);
    const stage5 = new Stage5Service(pool);
    const staging = new DurableStagingStore(join(config.storagePath, 'staging'),
      config.maxFileBytes, config.maxUploadRequestBytes);
    await staging.initialize();
    const uploads = new Stage6UploadService(pool, staging, config.uploadTtlSeconds * 1000);
    await stage3.ensureBuiltins();
    const bootstrapSecret = await identity.ensureBootstrapSecret();
    if (bootstrapSecret) {
      process.stderr.write(`Quorum bootstrap secret (shown once): ${bootstrapSecret}\n`);
    }
    const server = createApp({
      health,
      logger,
      version: config.version,
      databaseMigrationVersion: migrationState.latestAvailableVersion,
      identity,
      stage3,
      stage4,
      realtime,
      stage5,
      uploads,
      allowedOrigins: config.allowedOrigins
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
