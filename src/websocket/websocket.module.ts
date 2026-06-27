import { Module } from '@nestjs/common';
import { MatchGateway } from './match.gateway';
import { MessagingGateway } from './messaging.gateway';

@Module({
  providers: [MatchGateway, MessagingGateway],
  exports: [MatchGateway, MessagingGateway],
})
export class WebsocketModule {}
