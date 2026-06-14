import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { AnalyticsEventsGateway } from './analytics-events.gateway';
import type {
  AnalyticsEventName,
  AnalyticsEventPayloadMap,
} from './types/analytics-events.types';

/**
 * Thin facade over the WebSocket gateway. Handlers/services inject THIS,
 * not the gateway directly. Keeps the gateway concern (transport) separate
 * from the domain emit API.
 *
 * Also acts as a process-internal event bus: call `subscribe(eventName, handler)`
 * to receive payloads whenever `emit(...)` fires (e.g. for the notification
 * dispatcher). This avoids pulling in @nestjs/event-emitter just for intra-
 * process fan-out.
 */
@Injectable()
export class AnalyticsEventEmitter {
  private readonly logger = new Logger(AnalyticsEventEmitter.name);
  private readonly internalBus = new EventEmitter();

  constructor(private readonly gateway: AnalyticsEventsGateway) {
    // Raise the listener limit — the dispatcher subscribes to several events.
    this.internalBus.setMaxListeners(50);
  }

  emit<K extends AnalyticsEventName>(
    workspaceId: string,
    eventName: K,
    payload: AnalyticsEventPayloadMap[K],
  ): void {
    // Fan out to internal subscribers first (notification dispatcher, etc.)
    this.internalBus.emit(eventName, payload);

    try {
      this.gateway.emitToWorkspace(workspaceId, eventName, payload);
    } catch (err) {
      // Never let WebSocket errors break the snapshot write path
      this.logger.error(
        `Failed to emit ${eventName} for ws=${workspaceId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Subscribe to an analytics event by name. The handler receives the typed
   * payload. Used internally by `NotificationDispatcherService`.
   */
  subscribe<K extends AnalyticsEventName>(
    eventName: K,
    handler: (payload: AnalyticsEventPayloadMap[K]) => void,
  ): void {
    this.internalBus.on(eventName, handler as (payload: unknown) => void);
  }

  /**
   * Generic overload for event names that are NOT in `AnalyticsEventName`
   * (e.g. dispatcher-internal strings like 'inbox.urgent').
   */
  subscribeRaw(eventName: string, handler: (payload: unknown) => void): void {
    this.internalBus.on(eventName, handler);
  }
}
