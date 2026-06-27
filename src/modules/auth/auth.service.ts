import { Injectable } from '@nestjs/common';
import { AuthProvider, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called on every authenticated request (from JwtStrategy.validate).
   * Ensures a local User row exists for the given Supabase user id.
   * Uses upsert so it is idempotent and race-condition safe.
   */
  async syncUser(
    supabaseUserId: string,
    email: string | null,
    phone: string | null,
    provider: string | null,
  ): Promise<User> {
    const authProvider = this.mapProvider(provider);

    return this.prisma.user.upsert({
      where: { id: supabaseUserId },
      update: {},
      create: {
        id: supabaseUserId,
        email: email || null,
        phone: phone || null,
        authProvider,
      },
    });
  }

  private mapProvider(provider: string | null): AuthProvider {
    switch (provider) {
      case 'google':
        return AuthProvider.GOOGLE;
      case 'apple':
        return AuthProvider.APPLE;
      case 'phone':
        return AuthProvider.PHONE;
      default:
        return AuthProvider.EMAIL;
    }
  }
}
