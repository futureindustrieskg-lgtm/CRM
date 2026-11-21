import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC, PERMISSIONS, RequestContext } from './context';
import { hasPermission } from './permissions';

/**
 * Глобальная проверка: токен → пользователь → активная роль → права.
 * Права проверяются на сервере для каждого запроса (ТЗ 6.2).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    private prisma: PrismaService,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ec.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    let sub: string;
    try {
      sub = (await this.jwt.verifyAsync<{ sub: string }>(header.slice(7))).sub;
    } catch {
      throw new UnauthorizedException('Токен недействителен или истёк');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      include: { roles: { include: { role: true } } },
    });
    if (!user || !user.isActive || user.roles.length === 0) throw new UnauthorizedException();

    const requested = req.headers['x-active-role'] as string | undefined;
    const active = user.roles.find((r) => r.id === requested) ?? user.roles[0];

    const ctx: RequestContext = {
      userId: user.id,
      activeRoleId: active.id,
      roleCode: active.role.code,
      permissions: active.role.permissions,
      branchId: active.branchId,
    };
    req.ctx = ctx;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, targets) ?? [];
    const missing = required.filter((p) => !hasPermission(ctx.permissions, p));
    if (missing.length) throw new ForbiddenException(`Нет прав: ${missing.join(', ')}`);
    return true;
  }
}
