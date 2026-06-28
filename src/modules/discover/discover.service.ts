import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService, STORAGE_BUCKETS } from '../../storage/storage.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

const PAGE_SIZE = 20;

const EXT_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// ─── Response shapes ─────────────────────────────────────────────────────────

export interface PostAuthor {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface PostItem {
  id: string;
  author: PostAuthor;
  caption: string | null;
  photoUrl: string | null;
  createdAt: Date;
  likeCount: number;
  commentCount: number;
  liked: boolean;
}

export interface CommentItem {
  id: string;
  author: PostAuthor;
  content: string;
  createdAt: Date;
}

export interface FeedPage {
  items: PostItem[];
  nextCursor: string | null;
}

export interface CommentPage {
  items: CommentItem[];
  nextCursor: string | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class DiscoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // ─── Feed ─────────────────────────────────────────────────────────────────

  async getFeed(requestingUserId: string, before?: string): Promise<FeedPage> {
    const whereClause = before
      ? { createdAt: { lt: new Date(before) } }
      : undefined;

    const rows = await this.prisma.discoverPost.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        textContent: true,
        photoUrl: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            profile: { select: { username: true, avatarUrl: true } },
          },
        },
        _count: { select: { likes: true, comments: true } },
        likes: {
          where: { userId: requestingUserId },
          select: { id: true },
        },
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const items: PostItem[] = page.map((r) => ({
      id: r.id,
      author: {
        id: r.user.id,
        username: r.user.profile?.username ?? '',
        avatarUrl: r.user.profile?.avatarUrl ?? null,
      },
      caption: r.textContent,
      photoUrl: r.photoUrl,
      createdAt: r.createdAt,
      likeCount: r._count.likes,
      commentCount: r._count.comments,
      liked: r.likes.length > 0,
    }));

    const nextCursor =
      hasMore ? page[page.length - 1].createdAt.toISOString() : null;

    return { items, nextCursor };
  }

  // ─── Create post ──────────────────────────────────────────────────────────

  async createPost(
    userId: string,
    dto: CreatePostDto,
    photoBuffer?: Buffer,
    mimetype?: string,
  ): Promise<PostItem> {
    let photoUrl: string | undefined;

    if (photoBuffer && mimetype) {
      const ext = EXT_MAP[mimetype];
      const path = `${userId}/${Date.now()}.${ext}`;
      photoUrl = await this.storage.uploadFile(
        STORAGE_BUCKETS.DISCOVER_PHOTOS,
        path,
        photoBuffer,
        mimetype,
      );
    }

    if (!dto.caption && !photoUrl) {
      throw new BadRequestException(
        'A post must have at least a caption or a photo',
      );
    }

    const post = await this.prisma.discoverPost.create({
      data: {
        userId,
        textContent: dto.caption ?? null,
        photoUrl: photoUrl ?? null,
      },
      select: {
        id: true,
        textContent: true,
        photoUrl: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            profile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
    });

    return {
      id: post.id,
      author: {
        id: post.user.id,
        username: post.user.profile?.username ?? '',
        avatarUrl: post.user.profile?.avatarUrl ?? null,
      },
      caption: post.textContent,
      photoUrl: post.photoUrl,
      createdAt: post.createdAt,
      likeCount: 0,
      commentCount: 0,
      liked: false,
    };
  }

  // ─── Delete post ──────────────────────────────────────────────────────────

  async deletePost(requestingUserId: string, postId: string): Promise<void> {
    const post = await this.prisma.discoverPost.findUnique({
      where: { id: postId },
      select: { userId: true },
    });

    if (!post) throw new NotFoundException('Post not found');
    if (post.userId !== requestingUserId) throw new ForbiddenException();

    await this.prisma.discoverPost.delete({ where: { id: postId } });
  }

  // ─── Like / unlike ────────────────────────────────────────────────────────

  async likePost(
    userId: string,
    postId: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    await this.requirePost(postId);

    await this.prisma.like.upsert({
      where: { postId_userId: { postId, userId } },
      create: { postId, userId },
      update: {},
    });

    const likeCount = await this.prisma.like.count({ where: { postId } });
    return { liked: true, likeCount };
  }

  async unlikePost(
    userId: string,
    postId: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    await this.requirePost(postId);

    await this.prisma.like.deleteMany({ where: { postId, userId } });

    const likeCount = await this.prisma.like.count({ where: { postId } });
    return { liked: false, likeCount };
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  async getComments(
    postId: string,
    before?: string,
  ): Promise<CommentPage> {
    await this.requirePost(postId);

    const whereClause: Record<string, unknown> = { postId };
    if (before) {
      whereClause['createdAt'] = { lt: new Date(before) };
    }

    const rows = await this.prisma.comment.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE + 1,
      select: {
        id: true,
        content: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            profile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const items: CommentItem[] = page.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.createdAt,
      author: {
        id: r.user.id,
        username: r.user.profile?.username ?? '',
        avatarUrl: r.user.profile?.avatarUrl ?? null,
      },
    }));

    const nextCursor =
      hasMore ? page[page.length - 1].createdAt.toISOString() : null;

    return { items, nextCursor };
  }

  async addComment(
    userId: string,
    postId: string,
    dto: CreateCommentDto,
  ): Promise<CommentItem> {
    await this.requirePost(postId);

    const comment = await this.prisma.comment.create({
      data: { postId, userId, content: dto.content },
      select: {
        id: true,
        content: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            profile: { select: { username: true, avatarUrl: true } },
          },
        },
      },
    });

    return {
      id: comment.id,
      content: comment.content,
      createdAt: comment.createdAt,
      author: {
        id: comment.user.id,
        username: comment.user.profile?.username ?? '',
        avatarUrl: comment.user.profile?.avatarUrl ?? null,
      },
    };
  }

  async deleteComment(
    requestingUserId: string,
    commentId: string,
  ): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        userId: true,
        post: { select: { userId: true } },
      },
    });

    if (!comment) throw new NotFoundException('Comment not found');

    const isCommentAuthor = comment.userId === requestingUserId;
    const isPostAuthor = comment.post.userId === requestingUserId;

    if (!isCommentAuthor && !isPostAuthor) throw new ForbiddenException();

    await this.prisma.comment.delete({ where: { id: commentId } });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async requirePost(postId: string): Promise<void> {
    const post = await this.prisma.discoverPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found');
  }
}
