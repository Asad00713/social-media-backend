import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsEventsGateway } from './analytics-events.gateway';
import type {
  AnalyticsEventName,
  AnalyticsEventPayloadMap,
} from './types/analytics-events.types';

/**
 * Thin facade over the WebSocket gateway. Handlers/services inject THIS,
 * not the gateway directly. Keeps the gateway concern (transport) separate
 * from the domain emit API.
 */
@Injectable()
export class AnalyticsEventEmitter {
  private readonly logger = new Logger(AnalyticsEventEmitter.name);

  constructor(private readonly gateway: AnalyticsEventsGateway) {}

  emit<K extends AnalyticsEventName>(
    workspaceId: string,
    eventName: K,
    payload: AnalyticsEventPayloadMap[K],
  ): void {
    try {
      this.gateway.emitToWorkspace(workspaceId, eventName, payload);
    } catch (err) {
      // Never let WebSocket errors break the snapshot write path
      this.logger.error(
        `Failed to emit ${eventName} for ws=${workspaceId}: ${(err as Error).message}`,
      );
    }
  }
}
