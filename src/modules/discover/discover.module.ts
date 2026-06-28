import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../../storage/storage.module';
import { DiscoverService } from './discover.service';
import { DiscoverController } from './discover.controller';

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [DiscoverService],
  controllers: [DiscoverController],
})
export class DiscoverModule {}
