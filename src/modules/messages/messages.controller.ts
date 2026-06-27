import {
  BadRequestException,
  Body,
  Controller,
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
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

@ApiTags('Messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get('conversations')
  @ApiOperation({ summary: 'List all conversations for the current user' })
  @ApiResponse({ status: 200, description: 'Ordered by most recent message first' })
  listConversations(@CurrentUser() userId: string) {
    return this.messagesService.listConversations(userId);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({ summary: 'Get paginated messages for a conversation' })
  @ApiQuery({ name: 'before', required: false, description: 'Message ID cursor — returns messages older than this' })
  @ApiResponse({ status: 200, description: 'Page of messages (oldest-first within page)' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  getMessages(
    @Param('id') conversationId: string,
    @CurrentUser() userId: string,
    @Query('before') before?: string,
  ) {
    return this.messagesService.getMessages(conversationId, userId, before);
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send a message in a conversation' })
  @ApiResponse({ status: 201, description: 'Message created' })
  @ApiResponse({ status: 400, description: 'No content or photoUrl provided' })
  @ApiResponse({ status: 403, description: 'Blocked or not a participant' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  sendMessage(
    @Param('id') conversationId: string,
    @CurrentUser() userId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagesService.sendMessage(conversationId, userId, dto);
  }

  @Post('conversations/:id/messages/photo')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({
    summary: 'Upload a photo and send it as a message in a conversation (one-step)',
  })
  @ApiResponse({ status: 201, description: 'Photo uploaded and message created' })
  @ApiResponse({ status: 400, description: 'No file provided' })
  @ApiResponse({ status: 403, description: 'Blocked or not a participant' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  @ApiResponse({ status: 413, description: 'File exceeds 5 MB limit' })
  @ApiResponse({ status: 415, description: 'Unsupported file type — only jpeg/png/webp accepted' })
  sendPhotoMessage(
    @Param('id') conversationId: string,
    @CurrentUser() userId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    if (file.size > MAX_PHOTO_BYTES) {
      throw new PayloadTooLargeException('Photo must be 5 MB or smaller');
    }
    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        'Only jpeg, png, and webp images are accepted',
      );
    }
    return this.messagesService.sendPhotoMessage(
      conversationId,
      userId,
      file.buffer,
      file.mimetype,
    );
  }

  @Post('conversations/:id/messages/:messageId/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark messages as read up to a given message' })
  @ApiResponse({ status: 200, description: 'Messages marked as read' })
  @ApiResponse({ status: 403, description: 'Cannot mark own messages as read, or not a participant' })
  @ApiResponse({ status: 404, description: 'Conversation or message not found' })
  markRead(
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() userId: string,
  ) {
    return this.messagesService.markRead(conversationId, messageId, userId);
  }
}
