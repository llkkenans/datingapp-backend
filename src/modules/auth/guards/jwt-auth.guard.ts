import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any, info: any, _context: ExecutionContext): TUser {
    if (err || !user) {
      throw err ?? new UnauthorizedException(info?.message ?? 'Unauthorized');
    }
    return user;
  }
}
