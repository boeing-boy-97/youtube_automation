import { CONFIG_KEYS, REQUIRED_FOR_PROCESSING, REQUIRED_FOR_PUBLISHING, type ConfigKey } from '@clipforge/shared-types';
import { prisma } from './client';

/**
 * Configuration resolution.
 *
 * Precedence: workspace-scoped ApplicationConfiguration row > global row.
 * There is NO code-level default for any business value. A missing key produces
 * `ConfigurationRequiredError`, which the API renders as HTTP 428 with the exact
 * list of missing keys, and which blocks processing/publishing. This is the
 * "Configuration required — processing cannot start." behaviour required by spec.
 */
export class ConfigurationRequiredError extends Error {
  readonly code = 'CONFIGURATION_REQUIRED';
  constructor(readonly missing: string[], readonly scope: string) {
    super(`Configuration required — processing cannot start. Missing: ${missing.join(', ')}`);
    this.name = 'ConfigurationRequiredError';
  }
}

export interface ResolvedConfig {
  workspaceId: string | null;
  values: Map<string, unknown>;
  missing: string[];
}

export class ConfigurationService {
  constructor(private readonly workspaceId: string | null) {}

  async load(): Promise<ResolvedConfig> {
    const rows = await prisma.applicationConfiguration.findMany({
      where: { OR: [{ workspaceId: this.workspaceId }, { workspaceId: null }] },
      orderBy: [{ workspaceId: { sort: 'asc', nulls: 'first' } }], // globals first, workspace overrides second
    });
    const values = new Map<string, unknown>();
    for (const row of rows) values.set(row.key, row.value as unknown);
    return { workspaceId: this.workspaceId, values, missing: [] };
  }

  /** Environment-level integration credentials (never stored in DB, never sent to browser). */
  static integrationStatus() {
    const present = (v?: string) => Boolean(v && v.trim().length > 0);
    return {
      gemini: present(process.env.GEMINI_API_KEY) && present(process.env.GEMINI_TEXT_MODEL) && present(process.env.GEMINI_VISION_MODEL),
      youtube: present(process.env.YOUTUBE_CLIENT_ID) && present(process.env.YOUTUBE_CLIENT_SECRET) && present(process.env.YOUTUBE_REDIRECT_URI),
      instagram:
        present(process.env.META_APP_ID) && present(process.env.META_APP_SECRET) && present(process.env.META_GRAPH_API_VERSION) && present(process.env.META_REDIRECT_URI),
      storage:
        process.env.STORAGE_DRIVER === 'local'
          ? present(process.env.STORAGE_LOCAL_ROOT)
          : process.env.STORAGE_DRIVER === 's3'
            ? present(process.env.S3_BUCKET) && present(process.env.S3_ACCESS_KEY_ID) && present(process.env.S3_SECRET_ACCESS_KEY)
            : false,
      aiEngine: present(process.env.AI_ENGINE_URL) && present(process.env.AI_ENGINE_API_KEY),
      videoProcessor: present(process.env.VIDEO_PROCESSOR_URL) && present(process.env.VIDEO_PROCESSOR_API_KEY),
    };
  }

  async requireForProcessing(): Promise<ResolvedConfig> {
    const resolved = await this.load();
    const missing = REQUIRED_FOR_PROCESSING.filter((k) => resolved.values.get(k) === undefined || resolved.values.get(k) === null);
    if (missing.length > 0) throw new ConfigurationRequiredError(missing, 'processing');
    return resolved;
  }

  async requireForPublishing(): Promise<ResolvedConfig> {
    const resolved = await this.load();
    const missing = REQUIRED_FOR_PUBLISHING.filter((k) => resolved.values.get(k) === undefined || resolved.values.get(k) === null);
    if (missing.length > 0) throw new ConfigurationRequiredError(missing, 'publishing');
    return resolved;
  }

  static async get(workspaceId: string | null, key: ConfigKey): Promise<unknown> {
    const row = await prisma.applicationConfiguration.findFirst({
      where: { key, OR: [{ workspaceId }, { workspaceId: null }] },
      orderBy: [{ workspaceId: { sort: 'desc', nulls: 'last' } }], // prefer the workspace-scoped row
    });
    return row?.value ?? undefined;
  }

  static async set(workspaceId: string | null, key: string, value: unknown, updatedById: string | null): Promise<void> {
    // Composite unique on a nullable column cannot be used as an upsert key when
    // workspaceId is null, so resolve the target row explicitly first.
    const existing = await prisma.applicationConfiguration.findFirst({ where: { workspaceId, key } });
    if (existing) {
      await prisma.applicationConfiguration.update({
        where: { id: existing.id },
        data: { value: value as object, updatedById },
      });
      return;
    }
    await prisma.applicationConfiguration.create({ data: { workspaceId, key, value: value as object, updatedById } });
  }
}

export async function assertConfigured(keys: ConfigKey[], workspaceId: string | null): Promise<ResolvedConfig> {
  const resolved = await new ConfigurationService(workspaceId).load();
  const missing = keys.filter((k) => resolved.values.get(k) === undefined || resolved.values.get(k) === null);
  if (missing.length) throw new ConfigurationRequiredError(missing, 'requested operation');
  return resolved;
}

export { CONFIG_KEYS };
