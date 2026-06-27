import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { WebsocketModule } from '../../websocket/websocket.module';
import { StorageModule } from '../../storage/storage.module';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';

@Module({
  imports: [PrismaModule, WebsocketModule, StorageModule],
  providers: [MessagesService],
  controllers: [MessagesController],
})
export class MessagesModule {}
