import pg from 'pg';
import {loadConfig} from '../config.js';
import {createLogger} from '../logger.js';
import {runMigrations} from './migrations.js';

const logger = createLogger();
const {Pool} = pg;
let pool: InstanceType<typeof Pool> | undefined;

try {
  const config = loadConfig();
  pool = new Pool({connectionString: config.databaseUrl});
  const status = await runMigrations(pool, config.migrationsDirectory);
  logger.info('database.migrations.completed', {
    migrationVersion: status.latestAppliedVersion,
    pendingVersions: status.pendingVersions
  });
} catch (error) {
  logger.error('database.migrations.failed', {error});
  process.exitCode = 1;
} finally {
  await pool?.end();
}
