import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { IsString, MinLength } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { Ctx, Public, RequestContext } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

class LoginDto {
  @ApiProperty({ description: 'E-mail или телефон' })
  @IsString()
  login: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  password: string;
}

class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const normalizePhone = (p?: string | null) => (p ? p.replace(/\D/g, '') : null) || null;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const login = dto.login.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: login }, { phone: normalizePhone(login) ?? '__none__' }] },
    });
    if (!user?.passwordHash || !user.isActive || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(user.id);
  }

  async refresh(token: string) {
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Сессия истекла');
    }
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokens(stored.userId);
  }

  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(userId: string) {
    const refreshToken = randomBytes(48).toString('hex');
    const days = Number(this.config.get('REFRESH_TTL_DAYS') ?? 30);
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + days * 86400_000) },
    });
    const accessToken = await this.jwt.signAsync({ sub: userId });
    return { accessToken, refreshToken, user: await this.profile(userId) };
  }

  async profile(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: { include: { role: true, branch: true } } },
    });
    return {
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
      locale: u.locale,
      roles: u.roles.map((r) => ({
        id: r.id,
        code: r.role.code,
        name: r.role.name,
        permissions: r.role.permissions,
        branchId: r.branchId,
        branchName: r.branch?.name ?? null,
      })),
    };
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private prisma: PrismaService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Get('me')
  async me(@Ctx() ctx: RequestContext) {
    return { ...(await this.auth.profile(ctx.userId)), activeRoleId: ctx.activeRoleId };
  }

  /** Смена языка интерфейса (ru | ky | de | en). */
  @ApiBearerAuth()
  @Post('locale')
  @HttpCode(204)
  async locale(@Ctx() ctx: RequestContext, @Body() body: { locale: string }) {
    if (['ru', 'ky', 'de', 'en'].includes(body.locale)) {
      await this.prisma.user.update({ where: { id: ctx.userId }, data: { locale: body.locale } });
    }
  }
}

@Module({ providers: [AuthService], controllers: [AuthController], exports: [AuthService] })
export class AuthModule {}
