import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { InterestsModule } from './modules/interests/interests.module';
import { DiscoverModule } from './modules/discover/discover.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ReportsModule } from './modules/reports/reports.module';
import { BlocksModule } from './modules/blocks/blocks.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { MatchingModule } from './modules/matching/matching.module';
import { MatchModule } from './modules/match/match.module';
import { TextMatchModule } from './modules/text-match/text-match.module';
import { VoiceMatchModule } from './modules/voice-match/voice-match.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    StorageModule,
    AuthModule,
    UsersModule,
    ProfilesModule,
    OnboardingModule,
    InterestsModule,
    DiscoverModule,
    MessagesModule,
    ReportsModule,
    BlocksModule,
    RatingsModule,
    NotificationsModule,
    MatchingModule,
    MatchModule,
    TextMatchModule,
    VoiceMatchModule,
  ],
})
export class AppModule {}
