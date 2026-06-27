import { Injectable, ConflictException } from '@nestjs/common';
import { ProfilesService } from '../profiles/profiles.service';
import { CreateProfileDto } from '../profiles/dto/create-profile.dto';

@Injectable()
export class OnboardingService {
  constructor(private readonly profilesService: ProfilesService) {}

  async complete(userId: string, dto: CreateProfileDto) {
    const existing = await this.profilesService.getProfileByUserId(userId);
    if (existing) {
      throw new ConflictException('Onboarding already completed for this user');
    }
    return this.profilesService.createProfile(userId, dto);
  }

  async checkUsername(username: string): Promise<{ available: boolean }> {
    const available = await this.profilesService.checkUsernameAvailable(username);
    return { available };
  }
}
