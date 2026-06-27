import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProfileDto } from './dto/create-profile.dto';

// Fix: compare in UTC only — birthDate strings like "2006-06-25" are parsed as
// UTC midnight by the Date constructor; using UTC getter methods avoids off-by-one
// errors when the server's local timezone differs from the user's timezone.
// See docs/DECISIONS.md D-018.
function calculateAge(birthDate: Date): number {
  const now = new Date();
  const todayYear = now.getUTCFullYear();
  const todayMonth = now.getUTCMonth();
  const todayDay = now.getUTCDate();

  let age = todayYear - birthDate.getUTCFullYear();
  const monthDiff = todayMonth - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && todayDay < birthDate.getUTCDate())) {
    age--;
  }
  return age;
}

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async checkUsernameAvailable(username: string): Promise<boolean> {
    const existing = await this.prisma.profile.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
    });
    return existing === null;
  }

  async getProfileByUserId(userId: string) {
    return this.prisma.profile.findUnique({
      where: { userId },
      include: { interests: { include: { interest: true } } },
    });
  }

  async updateAvatarUrl(userId: string, avatarUrl: string): Promise<void> {
    await this.prisma.profile.update({
      where: { userId },
      data: { avatarUrl },
    });
  }

  async createProfile(userId: string, dto: CreateProfileDto) {
    const birthDate = new Date(dto.birthDate);
    if (isNaN(birthDate.getTime())) {
      throw new BadRequestException('Invalid birthDate format');
    }

    const age = calculateAge(birthDate);
    if (age < 18) {
      throw new BadRequestException('You must be at least 18 years old to use this app');
    }

    // UX pre-check (not a guarantee — the DB unique constraint is the real guard)
    const usernameAvailable = await this.checkUsernameAvailable(dto.username);
    if (!usernameAvailable) {
      throw new ConflictException('Username is already taken');
    }

    // Validate all interestIds exist before attempting to create UserInterest rows.
    // Without this check, a non-existent ID triggers a FK constraint crash (P2003 → 500).
    if (dto.interestIds?.length) {
      const found = await this.prisma.interest.findMany({
        where: { id: { in: dto.interestIds } },
        select: { id: true },
      });
      if (found.length !== dto.interestIds.length) {
        const foundIds = new Set(found.map((i) => i.id));
        const invalid = dto.interestIds.filter((id) => !foundIds.has(id));
        throw new BadRequestException(
          `Invalid interest IDs: ${invalid.join(', ')}`,
        );
      }
    }

    try {
      return await this.prisma.profile.create({
        data: {
          userId,
          username: dto.username,
          birthDate,
          gender: dto.gender,
          preferredGender: dto.preferredGender,
          city: dto.city,
          bio: dto.bio ?? null,
          onboardingCompleted: true,
          ...(dto.interestIds?.length
            ? {
                interests: {
                  create: dto.interestIds.map((interestId) => ({ interestId })),
                },
              }
            : {}),
        },
        include: { interests: { include: { interest: true } } },
      });
    } catch (err: unknown) {
      // Two users raced past the pre-check with the same username.
      // P2002 = unique constraint violation on Profile.username.
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Username is already taken');
      }
      throw err;
    }
  }
}
