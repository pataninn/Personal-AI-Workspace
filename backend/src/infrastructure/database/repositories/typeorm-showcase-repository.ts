import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import type {
  CurrentShowcaseDto,
  IShowcaseRepository,
  ShowcaseCurrentFile,
  ShowcaseCurrentSummary,
  ShowcasePublishedResult,
  ShowcaseStoredVersion
} from '@/modules/showcases/domain/showcase-types';
import { AppError } from '@/shared/errors/app-error';

interface VersionRow {
  readonly id: string;
  readonly project_display: CurrentShowcaseDto['project'];
  readonly tasks: CurrentShowcaseDto['tasks'];
  readonly facts: CurrentShowcaseDto['facts'];
  readonly skills: CurrentShowcaseDto['skills'];
  readonly published_at: Date | string;
  readonly file_count?: number;
}

interface FileRow {
  readonly file_id: string;
  readonly name: string;
  readonly media_type: string;
  readonly byte_length: number;
  readonly content: Buffer;
}

interface IdempotencyRow {
  readonly request_fingerprint: string;
  readonly version_id: string;
  readonly published_at: Date | string;
}

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The showcase repository returned an unexpected query result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The showcase timestamp is invalid.');
  return date.toISOString();
}

export class TypeOrmShowcaseRepository implements IShowcaseRepository {
  public constructor(private readonly dataSource: DataSource, private readonly createId: () => string = randomUUID) {}

  public async getCurrent(): Promise<CurrentShowcaseDto | null> {
    const version = await this.findCurrentVersion();
    if (!version) return null;
    const files = rows<FileRow>(await this.dataSource.query(`
      SELECT "file_id", "name", "media_type", "byte_length"
      FROM "showcase_files" WHERE "version_id" = $1 ORDER BY "name", "file_id"
    `, [version.id]));
    return {
      version: version.id,
      publishedAt: iso(version.published_at),
      project: parseJson(version.project_display),
      tasks: parseJson(version.tasks),
      facts: parseJson(version.facts),
      skills: parseJson(version.skills),
      files: files.map((file) => ({ id: file.file_id, name: file.name, mediaType: file.media_type, byteLength: file.byte_length }))
    };
  }

  public async getCurrentFile(fileId: string): Promise<ShowcaseCurrentFile | null> {
    const found = rows<FileRow>(await this.dataSource.query(`
      SELECT f."file_id", f."name", f."media_type", f."byte_length", f."content"
      FROM "showcase_publication" p
      JOIN "showcase_files" f ON f."version_id" = p."current_version_id"
      WHERE p."singleton_id" = true AND f."file_id" = $1
      LIMIT 1
    `, [fileId]))[0];
    return found ? {
      file: { id: found.file_id, name: found.name, mediaType: found.media_type, byteLength: found.byte_length },
      bytes: found.content
    } : null;
  }

  public async getCurrentSummary(): Promise<ShowcaseCurrentSummary | null> {
    const row = rows<{ readonly id: string; readonly file_count: number }>(await this.dataSource.query(`
      SELECT v."id", v."file_count"
      FROM "showcase_publication" p JOIN "showcase_versions" v ON v."id" = p."current_version_id"
      WHERE p."singleton_id" = true LIMIT 1
    `))[0];
    return row ? { version: row.id, fileCount: Number(row.file_count) } : null;
  }

  public async getVersion(versionId: string): Promise<ShowcaseStoredVersion | null> {
    const version = rows<VersionRow>(await this.dataSource.query(`
      SELECT "id", "project_display", "tasks", "facts", "skills", "published_at"
      FROM "showcase_versions" WHERE "id" = $1 LIMIT 1
    `, [versionId]))[0];
    if (!version) return null;
    const files = rows<FileRow & { readonly sha256: string }>(await this.dataSource.query(`
      SELECT "file_id", "name", "media_type", "byte_length", "sha256", "content"
      FROM "showcase_files" WHERE "version_id" = $1 ORDER BY "name", "file_id"
    `, [versionId]));
    const fileDtos = files.map((file) => ({
      id: file.file_id, name: file.name, mediaType: file.media_type, byteLength: Number(file.byte_length)
    }));
    return {
      snapshot: {
        version: version.id,
        publishedAt: iso(version.published_at),
        project: parseJson(version.project_display),
        tasks: parseJson(version.tasks),
        facts: parseJson(version.facts),
        skills: parseJson(version.skills),
        files: fileDtos
      },
      files: files.map((file) => ({
        id: file.file_id, name: file.name, mediaType: file.media_type, byteLength: Number(file.byte_length), sha256: file.sha256, bytes: file.content
      }))
    };
  }

  public async findPublishedReplay(adminId: string, idempotencyDigest: string, requestFingerprint: string): Promise<ShowcasePublishedResult | null> {
    const existing = rows<IdempotencyRow>(await this.dataSource.query(`
      SELECT "request_fingerprint", "version_id", "published_at"
      FROM "showcase_publish_idempotency" WHERE "admin_id" = $1 AND "key_digest" = $2 LIMIT 1
    `, [adminId, idempotencyDigest]))[0];
    return existing ? replay(existing, requestFingerprint) : null;
  }

  public async publish(input: Parameters<IShowcaseRepository['publish']>[0]): Promise<ShowcasePublishedResult & { readonly replayed: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const existing = await this.findIdempotency(manager, input.adminId, input.idempotencyDigest);
      if (existing) return replay(existing, input.requestFingerprint);

      // This row lock also serializes new demo pins with publication and retention pruning.
      await manager.query('SELECT "singleton_id" FROM "showcase_publication" WHERE "singleton_id" = true FOR UPDATE');
      const concurrentReplay = await this.findIdempotency(manager, input.adminId, input.idempotencyDigest);
      if (concurrentReplay) return replay(concurrentReplay, input.requestFingerprint);
      const snapshots = [input.snapshot, ...(input.additionalSnapshots ?? [])];
      if (snapshots.length > 3) throw new AppError('SHOWCASE_LIMIT_EXCEEDED', 413, 'Publish at most three demo workspaces.');
      // The existing single-workspace API replaces the whole selection.
      await manager.query('DELETE FROM "showcase_publication_workspaces"');

      await manager.query(`
        DELETE FROM "showcase_versions" v
        WHERE v."id" <> coalesce((SELECT "current_version_id" FROM "showcase_publication" WHERE "singleton_id" = true), '00000000-0000-0000-0000-000000000000'::uuid)
          AND NOT EXISTS (SELECT 1 FROM "demo_showcase_copies" c WHERE c."pinned_version_id" = v."id")
          AND NOT EXISTS (SELECT 1 FROM "showcase_publication_workspaces" w WHERE w."version_id" = v."id")
      `);
      const pinnedRows = rows<{ readonly count: string | number }>(await manager.query(
        'SELECT count(DISTINCT "pinned_version_id") AS "count" FROM "demo_showcase_copies" WHERE "pinned_version_id" IS NOT NULL'
      ));
      // The previous current version can be pruned after the pointer moves unless a pending copy pins it.
      if (Number(pinnedRows[0]?.count ?? 0) + snapshots.length > input.maxRetainedVersions) {
        throw new AppError('SHOWCASE_PUBLICATION_UNAVAILABLE', 503, 'Showcase retention is full while demo copies are still using older versions.');
      }

      const versionIds: string[] = [];
      let publishedAt: Date | string | undefined;
      for (const snapshot of snapshots) {
        const versionId = this.createId();
        versionIds.push(versionId);
        const inserted = rows<{ readonly published_at: Date | string }>(await manager.query(`
          INSERT INTO "showcase_versions" ("id", "project_display", "tasks", "facts", "skills", "content_digest", "snapshot_bytes", "item_count", "file_count")
          VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
          RETURNING "published_at"
        `, [versionId, JSON.stringify(snapshot.project), JSON.stringify(snapshot.tasks), JSON.stringify(snapshot.facts), JSON.stringify(snapshot.skills),
          input.contentDigest, input.snapshotBytes, input.itemCount, snapshot.files.length]));
        const insertedAt = inserted[0]?.published_at;
        if (!insertedAt) throw new Error('The showcase version was not created.');
        for (const file of snapshot.files) {
          await manager.query(`
            INSERT INTO "showcase_files" ("version_id", "file_id", "name", "media_type", "content", "sha256", "byte_length")
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [versionId, file.id, file.name, file.mediaType, file.bytes, file.sha256, file.byteLength]);
        }
        publishedAt ??= insertedAt;
      }
      const versionId = versionIds[0]!;
      if (!publishedAt) throw new Error('The showcase publication was not created.');
      for (let index = 1; index < versionIds.length; index += 1) {
        await manager.query('INSERT INTO "showcase_publication_workspaces" ("position", "version_id") VALUES ($1,$2)', [index, versionIds[index]]);
      }
      await manager.query(`
        UPDATE "showcase_publication" SET "current_version_id" = $1, "updated_at" = clock_timestamp()
        WHERE "singleton_id" = true
      `, [versionId]);
      await manager.query(`
        DELETE FROM "showcase_versions" v
        WHERE v."id" <> $1
          AND NOT EXISTS (SELECT 1 FROM "demo_showcase_copies" c WHERE c."pinned_version_id" = v."id")
          AND NOT EXISTS (SELECT 1 FROM "showcase_publication_workspaces" w WHERE w."version_id" = v."id")
      `, [versionId]);
      await manager.query(`
        INSERT INTO "showcase_publish_idempotency" ("admin_id", "key_digest", "request_fingerprint", "version_id", "published_at")
        VALUES ($1, $2, $3, $4, $5)
      `, [input.adminId, input.idempotencyDigest, input.requestFingerprint, versionId, publishedAt]);
      return { version: versionId, publishedAt: iso(publishedAt), replayed: false };
    });
  }

  private async findCurrentVersion(): Promise<VersionRow | null> {
    const row = rows<VersionRow>(await this.dataSource.query(`
      SELECT v."id", v."project_display", v."tasks", v."facts", v."skills", v."published_at"
      FROM "showcase_publication" p JOIN "showcase_versions" v ON v."id" = p."current_version_id"
      WHERE p."singleton_id" = true LIMIT 1
    `))[0];
    return row ?? null;
  }

  private async findIdempotency(manager: { query(query: string, parameters?: unknown[]): Promise<unknown> }, adminId: string, keyDigest: string): Promise<IdempotencyRow | null> {
    return rows<IdempotencyRow>(await manager.query(`
      SELECT "request_fingerprint", "version_id", "published_at"
      FROM "showcase_publish_idempotency" WHERE "admin_id" = $1 AND "key_digest" = $2
      LIMIT 1 FOR UPDATE
    `, [adminId, keyDigest]))[0] ?? null;
  }
}

function replay(existing: IdempotencyRow, fingerprint: string): ShowcasePublishedResult & { readonly replayed: true } {
  if (existing.request_fingerprint !== fingerprint) throw new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'This publish key was already used for another request.');
  return { version: existing.version_id, publishedAt: iso(existing.published_at), replayed: true };
}
