import type { Prisma } from '@prisma/client';
import { prisma } from './client';

export interface OutboxWrite {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  queue: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}

/**
 * Transactional outbox.
 *
 * The row is written inside the same transaction as the state change, so a
 * committed business change always has a matching queue intent. A relay process
 * drains unpublished rows into BullMQ and then marks them published. If the
 * relay crashes after enqueueing but before marking, the job may be enqueued
 * twice — which is safe because every queue job is keyed by a deterministic
 * BullMQ jobId derived from the outbox id and all consumers are idempotent.
 */
export async function writeOutbox(tx: Prisma.TransactionClient, event: OutboxWrite): Promise<string> {
  const row = await tx.outboxEvent.create({
    data: {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      queue: event.queue,
      payload: event.payload as Prisma.InputJsonValue,
      availableAt: event.availableAt ?? new Date(),
    },
  });
  return row.id;
}

export async function claimOutboxBatch(
  limit = 50,
  leaseSeconds = 60,
): Promise<Array<{ id: string; queue: string; payload: Record<string, unknown>; eventType: string; aggregateId: string; attempts: number }>> {
  // A single atomic statement: the sub-select takes row locks (SKIP LOCKED so parallel relays
  // never collide) and the UPDATE immediately pushes availableAt into the future, which is the
  // visibility timeout. A relay that crashes mid-drain does not lose the event — it simply
  // becomes claimable again when the lease elapses — and a second relay can never claim the
  // same row twice while the first still holds it.
  const rows = await prisma.$queryRaw<
    Array<{ id: string; queue: string; payload: Record<string, unknown>; eventType: string; aggregateId: string; attempts: number }>
  >`
    UPDATE "OutboxEvent"
    SET "availableAt" = now() + make_interval(secs => ${leaseSeconds}),
        "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL AND "availableAt" <= now()
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "queue", "payload", "eventType", "aggregateId", "attempts"
  `;
  return rows.map((row) => ({
    id: row.id,
    queue: row.queue,
    payload: row.payload as Record<string, unknown>,
    eventType: row.eventType,
    aggregateId: row.aggregateId,
    attempts: row.attempts,
  }));
}

export async function markOutboxPublished(id: string): Promise<void> {
  await prisma.outboxEvent.update({ where: { id }, data: { publishedAt: new Date() } });
}

export async function markOutboxFailed(id: string, error: string, backoffMs: number): Promise<void> {
  await prisma.outboxEvent.update({
    where: { id },
    data: {
      // attempts is incremented atomically at claim time; a failure only records why and
      // pushes the row out by the backoff so the relay retries it later.
      lastError: error.slice(0, 2000),
      availableAt: new Date(Date.now() + backoffMs),
    },
  });
}
