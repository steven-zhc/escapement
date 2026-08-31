#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/23b6c85a86e41a6df7c4cf1ce29387a439ba4a31c8e4bda9615f63dcf9181684/contract';
import endContract from '../../snapshots/23b6c85a86e41a6df7c4cf1ce29387a439ba4a31c8e4bda9615f63dcf9181684/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'checkpoints',
        columns: [
          col('last_seq', 'int8', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'pg/int8@1' },
          }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updated_at', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['name'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'events',
        columns: [
          col('actor', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('causation', 'int8', { codecRef: { codecId: 'pg/int8@1' } }),
          col('data', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('schema_ver', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('seq', 'BIGSERIAL', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('stream_id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('version', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['seq'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'outbox',
        columns: [
          col('attempts', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('caused_by', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('created_at', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('delivered_at', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('last_error', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('payload', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'events',
        constraint: 'events_stream_id_version_key',
        columns: ['stream_id', 'version'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'events',
        index: 'events_at_idx_a7b89566',
        columns: ['at'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'events',
        index: 'events_stream_id_seq_idx_ce39fde2',
        columns: ['stream_id', 'seq'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'events',
        index: 'events_type_seq_idx_32533e1e',
        columns: ['type', 'seq'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'outbox',
        index: 'outbox_delivered_at_created_at_idx_e4092e18',
        columns: ['delivered_at', 'created_at'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
