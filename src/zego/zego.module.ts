import { Module } from '@nestjs/common';
import { ZegoTokenService } from './zego-token.service';

@Module({
  providers: [ZegoTokenService],
  exports: [ZegoTokenService],
})
export class ZegoModule {}
