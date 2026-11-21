/**
 * Администрирование: роли и права, сотрудники, филиалы (ТЗ 2).
 * Роли создаются и редактируются из интерфейса без программиста.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit';
import { normalizePhone } from '../auth/auth';
import { Ctx, RequestContext, RequirePermissions } from '../common/context';
import { ACTIONS, allPermissionCodes, MODULES, SPECIAL_PERMISSIONS } from '../common/permissions';
import { PrismaService } from '../prisma/prisma.service';

// ───────────── Роли ─────────────

class RoleDto {
  @ApiProperty() @IsString() code: string;
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) permissions: string[];
}

class RoleUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}

@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  @Get('catalog')
  @RequirePermissions('roles.read')
  catalog() {
    return { modules: MODULES, actions: ACTIONS, special: SPECIAL_PERMISSIONS };
  }

  @Get()
  @RequirePermissions('roles.read')
  list() {
    return this.prisma.role.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { users: true } } } });
  }

  @Post()
  @RequirePermissions('roles.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: RoleDto) {
    this.validate(dto.permissions);
    const role = await this.prisma.role.create({ data: { ...dto, isSystem: false } });
    await this.audit.log({ userId: ctx.userId, entity: 'role', entityId: role.id, action: 'create', after: role });
    return role;
  }

  @Patch(':id')
  @RequirePermissions('roles.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: RoleUpdateDto) {
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (before.code === 'owner' && dto.permissions) throw new BadRequestException('Права владельца не меняются');
    if (dto.permissions) this.validate(dto.permissions);
    const after = await this.prisma.role.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'role', entityId: id, action: 'update', before, after });
    return after;
  }

  @Delete(':id')
  @RequirePermissions('roles.delete')
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException();
    if (role.isSystem) throw new BadRequestException('Системную роль удалить нельзя');
    if (role._count.users) throw new BadRequestException('Роль назначена сотрудникам');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({ userId: ctx.userId, entity: 'role', entityId: id, action: 'delete', before: role });
    return { ok: true };
  }

  private validate(perms: string[]) {
    const known = new Set(allPermissionCodes());
    const unknown = perms.filter((p) => !known.has(p));
    if (unknown.length) throw new BadRequestException(`Неизвестные права: ${unknown.join(', ')}`);
  }
}

// ───────────── Сотрудники ─────────────

class UserRoleDto {
  @ApiProperty() @IsString() roleId: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() branchId?: string | null;
}

class UserCreateDto {
  @ApiProperty() @IsString() firstName: string;
  @ApiProperty() @IsString() lastName: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) password?: string;
  @ApiProperty({ type: [UserRoleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserRoleDto)
  roles: UserRoleDto[];
}

class UserUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) password?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ type: [UserRoleDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserRoleDto)
  roles?: UserRoleDto[];
}

const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  isActive: true,
  lastLoginAt: true,
  roles: { select: { id: true, branchId: true, role: { select: { id: true, code: true, name: true } } } },
} as const;

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Сотрудники; роль филиала видит только сотрудников своего филиала. */
  @Get()
  @RequirePermissions('users.read')
  list(@Ctx() ctx: RequestContext) {
    return this.prisma.user.findMany({
      where: ctx.branchId ? { roles: { some: { branchId: ctx.branchId } } } : {},
      select: userSelect,
      orderBy: { lastName: 'asc' },
    });
  }

  /** Короткий список сотрудников для выбора ответственного (менеджеры, преподаватели). */
  @Get('staff')
  @RequirePermissions('leads.read')
  staff(@Ctx() ctx: RequestContext) {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: {
          some: {
            role: { code: { in: ['sales_manager', 'branch_admin', 'owner', 'teacher'] } },
            ...(ctx.branchId ? { OR: [{ branchId: ctx.branchId }, { branchId: null }] } : {}),
          },
        },
      },
      select: { id: true, firstName: true, lastName: true, roles: { select: { role: { select: { code: true } } } } },
      orderBy: { lastName: 'asc' },
    });
  }

  @Post()
  @RequirePermissions('users.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: UserCreateDto) {
    this.checkBranches(ctx, dto.roles);
    const user = await this.prisma.user.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email?.toLowerCase(),
        phone: normalizePhone(dto.phone),
        passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : null,
        roles: { create: dto.roles.map((r) => ({ roleId: r.roleId, branchId: r.branchId ?? null })) },
      },
      select: userSelect,
    });
    await this.audit.log({ userId: ctx.userId, entity: 'user', entityId: user.id, action: 'create', after: user });
    return user;
  }

  @Patch(':id')
  @RequirePermissions('users.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: UserUpdateDto) {
    const before = await this.prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!before) throw new NotFoundException();
    if (dto.roles) this.checkBranches(ctx, dto.roles);
    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: dto.roles.map((r) => ({ userId: id, roleId: r.roleId, branchId: r.branchId ?? null })),
        });
      }
      return tx.user.update({
        where: { id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email?.toLowerCase(),
          phone: dto.phone !== undefined ? normalizePhone(dto.phone) : undefined,
          isActive: dto.isActive,
          passwordHash: dto.password ? await bcrypt.hash(dto.password, 10) : undefined,
        },
        select: userSelect,
      });
    });
    await this.audit.log({ userId: ctx.userId, entity: 'user', entityId: id, action: 'update', before, after });
    return after;
  }

  /** Администратор филиала не может выдавать роли в чужих филиалах или во всех филиалах. */
  private checkBranches(ctx: RequestContext, roles: UserRoleDto[]) {
    if (ctx.branchId && roles.some((r) => r.branchId !== ctx.branchId)) {
      throw new BadRequestException('Можно назначать роли только в своём филиале');
    }
  }
}

// ───────────── Филиалы ─────────────

class BranchDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class BranchUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Список филиалов нужен всем сотрудникам для фильтров. */
  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.prisma.branch.findMany({
      where: ctx.branchId ? { id: ctx.branchId } : {},
      orderBy: { name: 'asc' },
    });
  }

  @Post()
  @RequirePermissions('branches.create')
  async create(@Ctx() ctx: RequestContext, @Body() dto: BranchDto) {
    const b = await this.prisma.branch.create({ data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'branch', entityId: b.id, action: 'create', after: b });
    return b;
  }

  @Patch(':id')
  @RequirePermissions('branches.update')
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: BranchUpdateDto) {
    const before = await this.prisma.branch.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const after = await this.prisma.branch.update({ where: { id }, data: dto });
    await this.audit.log({ userId: ctx.userId, entity: 'branch', entityId: id, action: 'update', before, after });
    return after;
  }
}

@Module({ controllers: [RolesController, UsersController, BranchesController] })
export class AdminModule {}
