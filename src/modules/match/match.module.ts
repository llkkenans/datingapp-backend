import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { WebsocketModule } from '../../websocket/websocket.module';
import { MatchingModule } from '../matching/matching.module';
import { ZegoModule } from '../../zego/zego.module';
import { MatchService } from './match.service';
import { MatchController } from './match.controller';

@Module({
  imports: [PrismaModule, WebsocketModule, MatchingModule, ZegoModule],
  providers: [MatchService],
  controllers: [MatchController],
})
export class MatchModule {}
