import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProfilesService } from './profiles.service';
import { StorageService, STORAGE_BUCKETS } from '../../storage/storage.service';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@ApiTags('Profiles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('profiles')
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly storageService: StorageService,
  ) {}

  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiOperation({ summary: "Upload or replace the current user's profile avatar" })
  @ApiResponse({
    status: 200,
    description: 'Avatar uploaded; returns the new public URL',
    schema: {
      type: 'object',
      properties: { avatarUrl: { type: 'string' } },
    },
  })
  @ApiResponse({ status: 400, description: 'No file provided' })
  @ApiResponse({ status: 413, description: 'File exceeds 5 MB limit' })
  @ApiResponse({ status: 415, description: 'Unsupported file type — only jpeg/png/webp accepted' })
  async uploadAvatar(
    @CurrentUser() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ avatarUrl: string }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (file.size > MAX_AVATAR_BYTES) {
      throw new PayloadTooLargeException('Avatar file must be 5 MB or smaller');
    }

    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'Only jpeg, png, and webp images are accepted',
      );
    }

    const ext = EXT_MAP[file.mimetype];
    const path = `${userId}/${Date.now()}.${ext}`;

    const avatarUrl = await this.storageService.uploadFile(
      STORAGE_BUCKETS.AVATARS,
      path,
      file.buffer,
      file.mimetype,
    );

    await this.profilesService.updateAvatarUrl(userId, avatarUrl);

    return { avatarUrl };
  }
}
