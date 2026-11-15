import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { platformIncidents } from '../drizzle/schema/platform-status.schema';
import { PlatformStatusRepository } from './platform-status.repository';
import {
  PlatformStatusService,
  toIncidentDto,
} from './platform-status.service';
import type { StatusIncidentDto } from './dto/status-page.dto';
import type {
  CreateIncidentDto,
  IncidentListQueryDto,
  UpdateIncidentDto,
} from './dto/incident.dto';

/** A start time this far ahead of the server clock is a typo, not skew. */
const MAX_FUTURE_START_MS = 5 * 60_000;

const DEFAULT_LIST_LIMIT = 50;

/**
 * Incidents a super admin posts by hand. Each write re-applies the incidents
 * to the platform states at once, so the status page and the toasts follow
 * without waiting for the next measurement.
 */
@Injectable()
export class PlatformIncidentsService {
  constructor(
    private readonly repo: PlatformStatusRepository,
    private readonly status: PlatformStatusService,
  ) {}

  async list(query: IncidentListQueryDto): Promise<StatusIncidentDto[]> {
    const rows = await this.repo.listIncidents(
      query.state ?? 'all',
      query.limit ?? DEFAULT_LIST_LIMIT,
    );
    return rows.map(toIncidentDto);
  }

  async create(
    actorId: string,
    dto: CreateIncidentDto,
    now = new Date(),
  ): Promise<StatusIncidentDto> {
    const startedAt = dto.startedAt ?? now;
    if (startedAt.getTime() > now.getTime() + MAX_FUTURE_START_MS) {
      throw new BadRequestException('startedAt cannot be in the future');
    }
    const row = await this.repo.withStatusLock((tx) =>
      this.repo.insertIncident(tx, {
        platform: dto.platform ?? null,
        severity: dto.severity,
        title: dto.title,
        body: dto.body ? dto.body : null,
        startedAt,
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await this.status.applyIncidents(now);
    return toIncidentDto(row);
  }

  async update(
    actorId: string,
    id: string,
    dto: UpdateIncidentDto,
    now = new Date(),
  ): Promise<StatusIncidentDto> {
    const set: Partial<typeof platformIncidents.$inferInsert> = {
      updatedBy: actorId,
      updatedAt: now,
    };
    if (dto.platform !== undefined) set.platform = dto.platform;
    if (dto.severity !== undefined) set.severity = dto.severity;
    if (dto.title !== undefined) set.title = dto.title;
    if (dto.body !== undefined) set.body = dto.body ? dto.body : null;

    const row = await this.repo.withStatusLock(async (tx) => {
      if (!(await this.repo.findIncident(tx, id))) {
        throw new NotFoundException('Incident not found');
      }
      return this.repo.updateIncident(tx, id, set);
    });
    if (!row) throw new NotFoundException('Incident not found');
    await this.status.applyIncidents(now);
    return toIncidentDto(row);
  }

  async resolve(
    actorId: string,
    id: string,
    now = new Date(),
  ): Promise<StatusIncidentDto> {
    const row = await this.repo.withStatusLock(async (tx) => {
      const current = await this.repo.findIncident(tx, id);
      if (!current) throw new NotFoundException('Incident not found');
      if (current.resolvedAt) {
        throw new ConflictException('Incident is already resolved');
      }
      // Never before it started (a backdated start, a skewed clock): the
      // table refuses resolved_at < started_at.
      const resolvedAt =
        now.getTime() < current.startedAt.getTime() ? current.startedAt : now;
      return this.repo.updateIncident(tx, id, {
        resolvedAt,
        updatedBy: actorId,
        updatedAt: now,
      });
    });
    if (!row) throw new NotFoundException('Incident not found');
    await this.status.applyIncidents(now);
    return toIncidentDto(row);
  }
}
