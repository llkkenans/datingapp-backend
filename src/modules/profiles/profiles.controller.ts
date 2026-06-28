import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
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
import { UpdateProfileDto } from './dto/update-profile.dto';
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

  @Get('me')
  @ApiOperation({ summary: "Get the current user's profile" })
  @ApiResponse({ status: 200, description: 'Profile returned' })
  @ApiResponse({ status: 404, description: 'Profile not found (onboarding not completed)' })
  async getMyProfile(@CurrentUser() userId: string) {
    const profile = await this.profilesService.getProfileByUserId(userId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return profile;
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update the current user's profile fields" })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 400, description: 'Validation error or invalid interest IDs' })
  @ApiResponse({ status: 409, description: 'Username already taken' })
  async updateProfile(
    @CurrentUser() userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profilesService.updateProfile(userId, dto);
  }

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

    // Capture old URL before overwriting — needed for cleanup below
    const existing = await this.profilesService.getProfileByUserId(userId);
    const oldAvatarUrl = existing?.avatarUrl ?? null;

    const avatarUrl = await this.storageService.uploadFile(
      STORAGE_BUCKETS.AVATARS,
      path,
      file.buffer,
      file.mimetype,
    );

    await this.profilesService.updateAvatarUrl(userId, avatarUrl);

    // Delete the old file after the new URL is safely persisted.
    // Failure here is non-fatal — log a warning and let the request succeed.
    if (oldAvatarUrl) {
      const oldPath = this.storageService.extractStoragePath(STORAGE_BUCKETS.AVATARS, oldAvatarUrl);
      if (oldPath) {
        await this.storageService.deleteFile(STORAGE_BUCKETS.AVATARS, oldPath);
      }
    }

    return { avatarUrl };
  }
}
