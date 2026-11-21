import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

/** Контекст запроса после проверки токена. */
export interface RequestContext {
  userId: string;
  /** Активная роль пользователя (UserRole.id) — переключается заголовком X-Active-Role. */
  activeRoleId: string;
  roleCode: string;
  permissions: string[];
  /** Филиал активной роли; null — доступ ко всем филиалам. */
  branchId: string | null;
}

export const IS_PUBLIC = 'isPublic';
export const PERMISSIONS = 'permissions';

/** Эндпоинт без авторизации. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Требуемые права (все перечисленные). */
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS, perms);

export const Ctx = createParamDecorator(
  (_: unknown, ec: ExecutionContext): RequestContext => ec.switchToHttp().getRequest().ctx,
);

/**
 * Фильтр по филиалу: роль с филиалом видит только его данные (ТЗ 6.2 — на уровне API).
 * Если передан requested и роль не ограничена — фильтруем по нему.
 */
export function branchScope(ctx: RequestContext, requested?: string): { branchId?: string } {
  if (ctx.branchId) return { branchId: ctx.branchId };
  return requested ? { branchId: requested } : {};
}
