import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { buildWsJwtMiddleware } from './ws-jwt.middleware';

// ─── Event name constants (contract shared with Terminal C / Flutter) ─────────

export const MESSAGING_EVENTS = {
  // Server → client
  MESSAGE_NEW: 'message.new',
  MESSAGE_READ: 'message.read',
  TYPING: 'message.typing',

  // Client → server
  TYPING_START: 'message.typing.start',
  TYPING_STOP: 'message.typing.stop',
} as const;

// ─── Payload shapes ───────────────────────────────────────────────────────────

export interface MessageNewPayload {
  conversationId: string;
  message: {
    id: string;
    senderId: string;
    content: string | null;
    photoUrl: string | null;
    status: string;
    createdAt: string;
  };
}

export interface MessageReadPayload {
  conversationId: string;
  readUpToMessageId: string;
  readAt: string;
}

/** Client → server: user started or stopped typing in a conversation. */
export interface TypingClientPayload {
  conversationId: string;
}

/** Server → client: relayed typing indicator (other participant only). */
export interface TypingServerPayload {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/messages',
})
export class MessagingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MessagingGateway.name);

  @WebSocketServer()
  private server!: Server;

  // userId → socketId — single-device assumption (see D-010)
  private readonly userSocketMap = new Map<string, string>();
  private readonly socketUserMap = new Map<string, string>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(): void {
    this.logger.log('MessagingGateway initialised on namespace /messages');
    this.server.use(buildWsJwtMiddleware(this.config));
  }

  handleConnection(socket: Socket): void {
    const userId = socket.data.userId; // set by ws-jwt.middleware after token verification
    this.userSocketMap.set(userId, socket.id);
    this.socketUserMap.set(socket.id, userId);
    this.logger.debug(`User ${userId} connected to /messages (socket ${socket.id})`);
  }

  handleDisconnect(socket: Socket): void {
    const userId = this.socketUserMap.get(socket.id);
    if (userId) {
      this.userSocketMap.delete(userId);
      this.socketUserMap.delete(socket.id);
      this.logger.debug(`User ${userId} disconnected from /messages`);
    }
  }

  // ─── Client → server: typing indicators ──────────────────────────────────

  @SubscribeMessage(MESSAGING_EVENTS.TYPING_START)
  async handleTypingStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: TypingClientPayload,
  ): Promise<void> {
    await this.handleTyping(socket, payload, true);
  }

  @SubscribeMessage(MESSAGING_EVENTS.TYPING_STOP)
  async handleTypingStop(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: TypingClientPayload,
  ): Promise<void> {
    await this.handleTyping(socket, payload, false);
  }

  private async handleTyping(
    socket: Socket,
    payload: TypingClientPayload,
    isTyping: boolean,
  ): Promise<void> {
    const senderId = this.socketUserMap.get(socket.id);
    if (!senderId) return;

    const { conversationId } = payload ?? {};
    if (!conversationId || typeof conversationId !== 'string') return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userAId: true, userBId: true },
    });

    if (!conversation) return;

    const { userAId, userBId } = conversation;
    if (senderId !== userAId && senderId !== userBId) return;

    const recipientId = senderId === userAId ? userBId : userAId;
    const relayPayload: TypingServerPayload = {
      conversationId,
      userId: senderId,
      isTyping,
    };
    this.emitToUser(recipientId, MESSAGING_EVENTS.TYPING, relayPayload);
  }

  // ─── Emit helpers (called by MessagesService) ─────────────────────────────

  emitMessageNew(toUserId: string, payload: MessageNewPayload): void {
    this.emitToUser(toUserId, MESSAGING_EVENTS.MESSAGE_NEW, payload);
  }

  emitMessageRead(toUserId: string, payload: MessageReadPayload): void {
    this.emitToUser(toUserId, MESSAGING_EVENTS.MESSAGE_READ, payload);
  }

  private emitToUser(userId: string, event: string, payload: unknown): void {
    const socketId = this.userSocketMap.get(userId);
    if (!socketId) {
      this.logger.debug(`User ${userId} offline — event ${event} dropped`);
      return;
    }
    this.server.to(socketId).emit(event, payload);
  }
}
