import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const STORAGE_BUCKETS = {
  AVATARS: 'avatars',
  MESSAGE_PHOTOS: 'message-photos',
} as const;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const key = this.config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    // Service-role key bypasses RLS — required for server-side storage operations
    this.client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketsExist();
  }

  // ─── Bucket init ──────────────────────────────────────────────────────────

  private async ensureBucketsExist(): Promise<void> {
    const buckets = [
      { name: STORAGE_BUCKETS.AVATARS, public: true },
      { name: STORAGE_BUCKETS.MESSAGE_PHOTOS, public: true },
    ];

    for (const bucket of buckets) {
      const { error } = await this.client.storage.createBucket(bucket.name, {
        public: bucket.public,
        // 5 MB hard cap enforced at the Supabase layer as a secondary guard;
        // primary validation happens in NestJS before the upload is attempted.
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });

      if (error && error.message !== 'The resource already exists') {
        this.logger.error(`Failed to create bucket "${bucket.name}": ${error.message}`);
      } else if (!error) {
        this.logger.log(`Storage bucket created: ${bucket.name}`);
      }
    }
  }

  // ─── Upload ───────────────────────────────────────────────────────────────

  async uploadFile(
    bucket: string,
    path: string,
    buffer: Buffer,
    mimetype: string,
  ): Promise<string> {
    const { error } = await this.client.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: mimetype,
        upsert: true,
      });

    if (error) {
      this.logger.error(`Storage upload failed [${bucket}/${path}]: ${error.message}`);
      throw new InternalServerErrorException('File upload failed');
    }

    const { data } = this.client.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }
}
