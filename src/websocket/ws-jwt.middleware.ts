import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import { verify, JwtPayload, JwtHeader } from 'jsonwebtoken';
import JwksRsa from 'jwks-rsa';

// Extend socket.data so TypeScript knows userId is written here, not by the client
declare module 'socket.io' {
  interface SocketData {
    userId: string;
  }
}

const logger = new Logger('WsJwtMiddleware');

type DoneFn = (err?: Error) => void;

export function buildWsJwtMiddleware(config: ConfigService) {
  const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
  const jwksUri = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;

  const jwksClient = JwksRsa({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
    jwksUri,
  });

  function getKey(header: JwtHeader, cb: (err: Error | null, key?: string) => void): void {
    jwksClient.getSigningKey(header.kid, (err, key) => {
      if (err) return cb(err);
      cb(null, key?.getPublicKey());
    });
  }

  return function wsJwtMiddleware(socket: Socket, next: DoneFn): void {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      logger.warn(`WS connect rejected — no token (socket ${socket.id})`);
      return next(new Error('Unauthorized'));
    }

    verify(token, getKey, { algorithms: ['ES256'] }, (err, payload) => {
      if (err || !payload) {
        logger.warn(
          `WS connect rejected — invalid token (socket ${socket.id}): ${err?.message}`,
        );
        return next(new Error('Unauthorized'));
      }
      const sub = (payload as JwtPayload).sub;
      if (!sub) {
        logger.warn(`WS connect rejected — missing sub claim (socket ${socket.id})`);
        return next(new Error('Unauthorized'));
      }
      socket.data.userId = sub;
      next();
    });
  };
}
