import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { AuthService } from '../auth.service';

interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  phone?: string;
  app_metadata?: {
    provider?: string;
  };
  role?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  iat?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const jwksUri = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Supabase now signs tokens with ES256 (ECDSA P-256) via its "JWT Signing Keys"
      // system. We verify against the JWKS endpoint instead of a static HS256 secret.
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri,
      }),
      algorithms: ['ES256'],
    });
  }

  async validate(payload: SupabaseJwtPayload): Promise<{ userId: string }> {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid token payload');
    }

    if (payload.role === 'service_role') {
      throw new UnauthorizedException('Service role tokens are not accepted');
    }

    const provider = payload.app_metadata?.provider ?? null;
    const email = payload.email ?? null;
    const phone = payload.phone ?? null;

    await this.authService.syncUser(payload.sub, email, phone, provider);

    return { userId: payload.sub };
  }
}
