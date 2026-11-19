import { MigrationAttempt } from './MigrationAttempt.js';
import { LiveRun } from './LiveRun.js';

export type MigrationSchema = { MigrationAttempt: MigrationAttempt; LiveRun: LiveRun };
export const schema = [MigrationAttempt, LiveRun];
