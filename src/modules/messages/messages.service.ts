import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MessageStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MessagingGateway } from '../../websocket/messaging.gateway';
import { StorageService, STORAGE_BUCKETS } from '../../storage/storage.service';
import { SendMessageDto } from './dto/send-message.dto';

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const PAGE_SIZE = 30;

// ─── Response shapes ──────────────────────────────────────────────────────────

export interface ConversationListItem {
  id: string;
  otherUser: {
    id: string;
    username: string;
    avatarUrl: string | null;
  };
  lastMessage: {
    id: string;
    content: string | null;
    photoUrl: string | null;
    senderId: string;
    status: MessageStatus;
    createdAt: string;
  } | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface MessageItem {
  id: string;
  conversationId: string;
  senderId: string;
  content: string | null;
  photoUrl: string | null;
  status: MessageStatus;
  createdAt: string;
}

export interface MessagesPage {
  messages: MessageItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: MessagingGateway,
    private readonly storage: StorageService,
  ) {}

  // ─── List conversations ──────────────────────────────────────────────────

  async listConversations(userId: string): Promise<ConversationListItem[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        userAId: true,
        userBId: true,
        lastMessageAt: true,
        createdAt: true,
        userA: {
          select: {
            id: true,
            profile: { select: { username: true, avatarUrl: true } },
          },
        },
        userB: {
          select: {
            id: true,
            profile: { select: { username: true, avatarUrl: true } },
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            content: true,
            photoUrl: true,
            senderId: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    return conversations.map((c) => {
      const otherUser = c.userAId === userId ? c.userB : c.userA;
      const lastMsg = c.messages[0] ?? null;

      return {
        id: c.id,
        otherUser: {
          id: otherUser.id,
          username: otherUser.profile?.username ?? '',
          avatarUrl: otherUser.profile?.avatarUrl ?? null,
        },
        lastMessage: lastMsg
          ? {
              id: lastMsg.id,
              content: lastMsg.content,
              photoUrl: lastMsg.photoUrl,
              senderId: lastMsg.senderId,
              status: lastMsg.status,
              createdAt: lastMsg.createdAt.toISOString(),
            }
          : null,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      };
    });
  }

  // ─── Paginated messages ──────────────────────────────────────────────────

  async getMessages(
    conversationId: string,
    userId: string,
    before?: string,
  ): Promise<MessagesPage> {
    await this.requireParticipant(conversationId, userId);

    // Resolve cursor: find the createdAt of the message with id = before
    let cursorCreatedAt: Date | undefined;
    if (before) {
      const cursor = await this.prisma.message.findUnique({
        where: { id: before },
        select: { createdAt: true },
      });
      if (!cursor) throw new NotFoundException('Cursor message not found');
      cursorCreatedAt = cursor.createdAt;
    }

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursorCreatedAt ? { createdAt: { lt: cursorCreatedAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1, // fetch one extra to determine hasMore
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        content: true,
        photoUrl: true,
        status: true,
        createdAt: true,
      },
    });

    const hasMore = messages.length > PAGE_SIZE;
    // `messages` is desc-ordered; slice keeps the PAGE_SIZE newest.
    // nextCursor must be computed BEFORE reverse() because Array.reverse() mutates
    // in place — after reverse, page[page.length-1] would be the newest message
    // (wrong direction), causing the client to re-fetch the same page.
    const page = hasMore ? messages.slice(0, PAGE_SIZE) : messages;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    return {
      // Return in chronological order (oldest first) so the client can render top-to-bottom
      messages: page.reverse().map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        content: m.content,
        photoUrl: m.photoUrl,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  }

  // ─── Send message ────────────────────────────────────────────────────────

  async sendMessage(
    conversationId: string,
    senderId: string,
    dto: SendMessageDto,
  ): Promise<MessageItem> {
    if (!dto.content?.trim() && !dto.photoUrl?.trim()) {
      throw new BadRequestException('Message must contain content or a photoUrl');
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userAId: true, userBId: true },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');

    const recipientId = this.otherParticipant(conversation, senderId);

    // ── Block check + message create in a single transaction ─────────────────
    // Keeping the block check inside the transaction closes the TOCTOU window
    // where a block created between the check and the insert would allow a
    // message to slip through.
    const now = new Date();
    const message = await this.prisma.$transaction(async (tx) => {
      const block = await tx.block.findFirst({
        where: {
          OR: [
            { blockerId: senderId, blockedId: recipientId },
            { blockerId: recipientId, blockedId: senderId },
          ],
        },
        select: { id: true },
      });

      if (block) {
        throw new ForbiddenException(
          'Cannot send messages in a conversation where a block exists',
        );
      }

      const [msg] = await Promise.all([
        tx.message.create({
          data: {
            conversationId,
            senderId,
            content: dto.content ?? null,
            photoUrl: dto.photoUrl ?? null,
            status: MessageStatus.SENT,
            createdAt: now,
          },
          select: {
            id: true,
            conversationId: true,
            senderId: true,
            content: true,
            photoUrl: true,
            status: true,
            createdAt: true,
          },
        }),
        tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: now },
        }),
      ]);

      return msg;
    });

    // ── Emit to recipient ────────────────────────────────────────────────────
    this.gateway.emitMessageNew(recipientId, {
      conversationId,
      message: {
        id: message.id,
        senderId: message.senderId,
        content: message.content,
        photoUrl: message.photoUrl,
        status: message.status,
        createdAt: message.createdAt.toISOString(),
      },
    });

    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      content: message.content,
      photoUrl: message.photoUrl,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
    };
  }

  // ─── Mark read ───────────────────────────────────────────────────────────

  async markRead(
    conversationId: string,
    messageId: string,
    readerId: string,
  ): Promise<{ readUpToMessageId: string; updatedCount: number }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userAId: true, userBId: true },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');

    const senderId = this.otherParticipant(conversation, readerId);

    // Find the target message to get its createdAt (for bulk update boundary)
    const targetMessage = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, createdAt: true },
    });

    if (!targetMessage) throw new NotFoundException('Message not found');
    if (targetMessage.senderId === readerId) {
      throw new ForbiddenException('Cannot mark your own messages as read');
    }

    // Mark all unread messages from the other party up to and including this one
    const result = await this.prisma.message.updateMany({
      where: {
        conversationId,
        senderId,
        status: { not: MessageStatus.READ },
        createdAt: { lte: targetMessage.createdAt },
      },
      data: { status: MessageStatus.READ },
    });

    if (result.count > 0) {
      this.gateway.emitMessageRead(senderId, {
        conversationId,
        readUpToMessageId: messageId,
        readAt: new Date().toISOString(),
      });
    }

    return { readUpToMessageId: messageId, updatedCount: result.count };
  }

  // ─── Send photo message ──────────────────────────────────────────────────

  async sendPhotoMessage(
    conversationId: string,
    senderId: string,
    fileBuffer: Buffer,
    mimetype: string,
  ): Promise<MessageItem> {
    await this.requireParticipant(conversationId, senderId);

    const ext = EXT_MAP[mimetype];
    const path = `${conversationId}/${Date.now()}-${senderId}.${ext}`;

    const photoUrl = await this.storage.uploadFile(
      STORAGE_BUCKETS.MESSAGE_PHOTOS,
      path,
      fileBuffer,
      mimetype,
    );

    return this.sendMessage(conversationId, senderId, { photoUrl });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async requireParticipant(
    conversationId: string,
    userId: string,
  ): Promise<{ userAId: string; userBId: string }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userAId: true, userBId: true },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.userAId !== userId && conversation.userBId !== userId) {
      throw new ForbiddenException('You are not a participant in this conversation');
    }

    return conversation;
  }

  private otherParticipant(
    conversation: { userAId: string; userBId: string },
    userId: string,
  ): string {
    if (conversation.userAId === userId) return conversation.userBId;
    if (conversation.userBId === userId) return conversation.userAId;
    throw new ForbiddenException('You are not a participant in this conversation');
  }
}
