import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DiscoverService } from './discover.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { CursorQueryDto } from './dto/cursor-query.dto';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

@ApiTags('discover')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('discover')
export class DiscoverController {
  constructor(private readonly discoverService: DiscoverService) {}

  // ─── Feed ─────────────────────────────────────────────────────────────────

  @Get('feed')
  @ApiOperation({ summary: 'Get reverse-chronological feed of public posts' })
  @ApiQuery({ name: 'before', required: false, description: 'Pagination cursor (ISO timestamp)' })
  @ApiResponse({ status: 200, description: 'Feed page' })
  getFeed(
    @CurrentUser() userId: string,
    @Query() query: CursorQueryDto,
  ) {
    return this.discoverService.getFeed(userId, query.before);
  }

  // ─── Posts ────────────────────────────────────────────────────────────────

  @Post('posts')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        caption: { type: 'string', maxLength: 2000 },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: 'Create a post (caption and/or photo required)' })
  @ApiResponse({ status: 201, description: 'Post created' })
  @ApiResponse({ status: 400, description: 'No caption or photo provided' })
  @ApiResponse({ status: 413, description: 'Photo exceeds 5 MB' })
  @ApiResponse({ status: 415, description: 'Unsupported image type' })
  createPost(
    @CurrentUser() userId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('caption') caption?: string,
  ) {
    if (file) {
      if (file.size > MAX_PHOTO_BYTES) {
        throw new PayloadTooLargeException('Photo must be 5 MB or smaller');
      }
      if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
        throw new UnsupportedMediaTypeException(
          'Only jpeg, png, and webp images are accepted',
        );
      }
    }

    return this.discoverService.createPost(
      userId,
      { caption },
      file?.buffer,
      file?.mimetype,
    );
  }

  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a post (author only)' })
  @ApiResponse({ status: 204, description: 'Post deleted' })
  @ApiResponse({ status: 403, description: 'Not the post author' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  deletePost(
    @CurrentUser() userId: string,
    @Param('id') postId: string,
  ) {
    return this.discoverService.deletePost(userId, postId);
  }

  // ─── Likes ────────────────────────────────────────────────────────────────

  @Post('posts/:id/like')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Like a post (idempotent)' })
  @ApiResponse({ status: 200, description: 'Current like state' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  likePost(
    @CurrentUser() userId: string,
    @Param('id') postId: string,
  ) {
    return this.discoverService.likePost(userId, postId);
  }

  @Delete('posts/:id/like')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlike a post' })
  @ApiResponse({ status: 200, description: 'Current like state' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  unlikePost(
    @CurrentUser() userId: string,
    @Param('id') postId: string,
  ) {
    return this.discoverService.unlikePost(userId, postId);
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  @Get('posts/:id/comments')
  @ApiOperation({ summary: 'Get comments on a post (cursor-paginated)' })
  @ApiQuery({ name: 'before', required: false, description: 'Pagination cursor (ISO timestamp)' })
  @ApiResponse({ status: 200, description: 'Comment page' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  getComments(
    @Param('id') postId: string,
    @Query() query: CursorQueryDto,
  ) {
    return this.discoverService.getComments(postId, query.before);
  }

  @Post('posts/:id/comments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a comment to a post' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({ status: 404, description: 'Post not found' })
  addComment(
    @CurrentUser() userId: string,
    @Param('id') postId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.discoverService.addComment(userId, postId, dto);
  }

  @Delete('comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a comment (comment author or post author)' })
  @ApiResponse({ status: 204, description: 'Comment deleted' })
  @ApiResponse({ status: 403, description: 'Not the comment or post author' })
  @ApiResponse({ status: 404, description: 'Comment not found' })
  deleteComment(
    @CurrentUser() userId: string,
    @Param('id') commentId: string,
  ) {
    return this.discoverService.deleteComment(userId, commentId);
  }
}
