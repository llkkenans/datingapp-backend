import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: {
          include: { interests: { include: { interest: true } } },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      authProvider: user.authProvider,
      status: user.status,
      createdAt: user.createdAt,
      profile: user.profile ?? null,
      onboardingCompleted: user.profile?.onboardingCompleted ?? false,
    };
  }
}
