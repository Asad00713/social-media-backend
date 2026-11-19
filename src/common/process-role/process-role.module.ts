import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CronRoleGate } from './cron-role.gate';
import { QueueRoleGate } from './queue-role.gate';

/**
 * Applies `ROLE` to this process.
 *
 * Import AFTER `ScheduleModule.forRoot()` and after the queue modules, for the
 * same reason `SchedulingModule` must be: both gates read registries those
 * modules populate. Each gate logs what it found, so a wrong order shows up as
 * a count of zero in the logs rather than as silent non-enforcement.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [QueueRoleGate, CronRoleGate],
})
export class ProcessRoleModule {}
