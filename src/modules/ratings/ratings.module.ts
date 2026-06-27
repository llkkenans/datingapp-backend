import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { RatingsService } from './ratings.service';
import { RatingsController } from './ratings.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [RatingsService],
  controllers: [RatingsController],
})
export class RatingsModule {}
