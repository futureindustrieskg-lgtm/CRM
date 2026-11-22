import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { Ctx, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';

class MessageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) text?: string;
  @ApiPropertyOptional({ type: [String], description: 'Файлы и голосовые' }) @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) fileIds?: string[];
}
class DirectDto {
  @ApiProperty() @IsString() userId: string;
}

const userSelect = { select: { id: true, firstName: true, lastName: true } } as const;
const fileSelect = { select: { id: true, name: true, mime: true, size: true } } as const;

/**
 * Внутренний чат (ТЗ 3.8): чат группы, личный «студент — преподаватель», «клиент — администрация филиала».
 * Контакты (телефоны) в чате не показываются — преподаватель общается со студентами только здесь (ТЗ 2).
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private prisma: PrismaService) {}

  /** Группы пользователя: преподаватель — свои, студент — где учится. */
  private async myGroupIds(ctx: RequestContext) {
    if (ctx.roleCode === 'student') {
      const s = await this.prisma.student.findFirst({ where: { userId: ctx.userId } });
      if (!s) return [];
      return (await this.prisma.groupStudent.findMany({ where: { studentId: s.id, leftAt: null, waitlist: false }, select: { groupId: true } })).map((g) => g.groupId);
    }
    if (ctx.roleCode === 'teacher') {
      return (await this.prisma.group.findMany({ where: { teacherId: ctx.userId, status: { not: 'finished' } }, select: { id: true } })).map((g) => g.id);
    }
    return [];
  }

  /** Чат группы создаётся автоматически; состав — преподаватель и студенты с учётной записью. */
  private async syncGroups(groupIds: string[]) {
    for (const groupId of groupIds) {
      const g = await this.prisma.group.findUnique({
        where: { id: groupId },
        include: { students: { where: { leftAt: null, waitlist: false, student: { userId: { not: null } } }, select: { student: { select: { userId: true } } } } },
      });
      if (!g) continue;
      const conv = await this.prisma.conversation.upsert({
        where: { groupId },
        create: { type: 'group', groupId, branchId: g.branchId, title: g.name },
        update: { title: g.name },
      });
      const members = [g.teacherId, ...g.students.map((s) => s.student.userId)].filter(Boolean) as string[];
      // Новый участник видит историю группы как непрочитанную.
      await this.prisma.conversationMember.createMany({ data: members.map((userId) => ({ conversationId: conv.id, userId, lastReadAt: new Date(0) })), skipDuplicates: true });
      await this.prisma.conversationMember.deleteMany({ where: { conversationId: conv.id, userId: { notIn: members } } });
    }
  }

  /** Администратор филиала видит обращения клиентов своего филиала. */
  private async syncSupport(ctx: RequestContext) {
    if (ctx.roleCode !== 'branch_admin' && ctx.roleCode !== 'owner') return;
    const convs = await this.prisma.conversation.findMany({ where: { type: 'support', ...(ctx.branchId ? { branchId: ctx.branchId } : {}) }, select: { id: true } });
    await this.prisma.conversationMember.createMany({ data: convs.map((c) => ({ conversationId: c.id, userId: ctx.userId })), skipDuplicates: true });
  }

  private async member(ctx: RequestContext, id: string) {
    const m = await this.prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId: ctx.userId } } });
    if (!m) throw new NotFoundException('Чат не найден');
    return m;
  }

  @Get('conversations')
  @RequirePermissions('messages.read')
  async list(@Ctx() ctx: RequestContext) {
    await this.syncGroups(await this.myGroupIds(ctx));
    await this.syncSupport(ctx);
    const convs = await this.prisma.conversation.findMany({
      where: { members: { some: { userId: ctx.userId } } },
      include: {
        members: { include: { user: userSelect } },
        messages: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1, include: { sender: userSelect, _count: { select: { files: true } } } },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    const out = [];
    for (const c of convs) {
      const me = c.members.find((m) => m.userId === ctx.userId)!;
      const others = c.members.filter((m) => m.userId !== ctx.userId).map((m) => m.user);
      const unread = await this.prisma.chatMessage.count({
        where: { conversationId: c.id, deletedAt: null, senderId: { not: ctx.userId }, createdAt: { gt: me.lastReadAt } },
      });
      const isClient = ctx.roleCode === 'student' || ctx.roleCode === 'parent';
      const title =
        c.type === 'group'
          ? c.title
          : c.type === 'support'
            ? isClient
              ? null // клиенту: «Администрация филиала» (переводится в интерфейсе)
              : `${c.title ?? ''}`
            : others.map((o) => `${o.firstName} ${o.lastName}`).join(', ');
      out.push({ id: c.id, type: c.type, title, members: c.members.length, last: c.messages[0] ?? null, unread, lastMessageAt: c.lastMessageAt });
    }
    return out;
  }

  /** С кем можно начать личный чат: студенту — его преподаватели, преподавателю — его студенты (с учётной записью). */
  @Get('contacts')
  @RequirePermissions('messages.create')
  async contacts(@Ctx() ctx: RequestContext) {
    const groupIds = await this.myGroupIds(ctx);
    if (ctx.roleCode === 'student') {
      const groups = await this.prisma.group.findMany({ where: { id: { in: groupIds }, teacherId: { not: null } }, select: { name: true, teacher: userSelect } });
      return { users: groups.map((g) => ({ ...g.teacher!, hint: g.name })), support: true };
    }
    if (ctx.roleCode === 'teacher') {
      const rows = await this.prisma.groupStudent.findMany({
        where: { groupId: { in: groupIds }, leftAt: null, waitlist: false, student: { userId: { not: null } } },
        select: { group: { select: { name: true } }, student: { select: { user: userSelect } } },
      });
      return { users: rows.map((r) => ({ ...r.student.user!, hint: r.group.name })), support: false };
    }
    return { users: [], support: ctx.roleCode === 'parent' };
  }

  @Post('direct')
  @RequirePermissions('messages.create')
  async direct(@Ctx() ctx: RequestContext, @Body() dto: DirectDto) {
    const { users } = await this.contacts(ctx);
    if (!users.some((u) => u.id === dto.userId)) throw new ForbiddenException('Личный чат — только со своим преподавателем или студентом');
    const existing = await this.prisma.conversation.findFirst({
      where: { type: 'direct', AND: [{ members: { some: { userId: ctx.userId } } }, { members: { some: { userId: dto.userId } } }] },
    });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: { type: 'direct', members: { create: [{ userId: ctx.userId }, { userId: dto.userId }] } },
    });
  }

  /** Обращение клиента (студента или родителя) в администрацию своего филиала. */
  @Post('support')
  @RequirePermissions('messages.create')
  async support(@Ctx() ctx: RequestContext) {
    if (ctx.roleCode !== 'student' && ctx.roleCode !== 'parent') throw new ForbiddenException('Обращение в администрацию — для клиентов');
    const existing = await this.prisma.conversation.findFirst({ where: { type: 'support', members: { some: { userId: ctx.userId } } } });
    if (existing) return existing;
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const student = await this.prisma.student.findFirst({ where: { OR: [{ userId: ctx.userId }, { parents: { some: { parentId: ctx.userId } } }] } });
    const branchId = ctx.branchId ?? student?.branchId ?? null;
    const admins = await this.prisma.userRole.findMany({
      where: { role: { code: 'branch_admin' }, user: { isActive: true }, ...(branchId ? { branchId } : {}) },
      select: { userId: true },
    });
    const ids = [...new Set([ctx.userId, ...admins.map((a) => a.userId)])];
    return this.prisma.conversation.create({
      data: { type: 'support', branchId, title: `${me.firstName} ${me.lastName}`, members: { create: ids.map((userId) => ({ userId })) } },
    });
  }

  @Get('conversations/:id/messages')
  @RequirePermissions('messages.read')
  async messages(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query('before') before?: string) {
    await this.member(ctx, id);
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId: id, deletedAt: null, ...(before ? { createdAt: { lt: new Date(before) } } : {}) },
      include: { sender: userSelect, files: fileSelect },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.reverse();
  }

  @Post('conversations/:id/messages')
  @RequirePermissions('messages.create')
  async send(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: MessageDto) {
    await this.member(ctx, id);
    if (!dto.text?.trim() && !dto.fileIds?.length) throw new BadRequestException('Пустое сообщение');
    if (dto.fileIds?.length) {
      const files = await this.prisma.storedFile.findMany({ where: { id: { in: dto.fileIds } } });
      if (files.length !== dto.fileIds.length || files.some((f) => f.ownerId !== ctx.userId || f.messageId || f.homeworkId || f.submissionId || f.questionId)) {
        throw new BadRequestException('Файл не найден или уже прикреплён');
      }
    }
    const now = new Date();
    const msg = await this.prisma.$transaction(async (tx) => {
      const m = await tx.chatMessage.create({ data: { conversationId: id, senderId: ctx.userId, text: dto.text?.trim() || null } });
      if (dto.fileIds?.length) await tx.storedFile.updateMany({ where: { id: { in: dto.fileIds } }, data: { messageId: m.id } });
      await tx.conversation.update({ where: { id }, data: { lastMessageAt: now } });
      await tx.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: ctx.userId } }, data: { lastReadAt: now } });
      return m;
    });
    return this.prisma.chatMessage.findUnique({ where: { id: msg.id }, include: { sender: userSelect, files: fileSelect } });
  }

  @Post('conversations/:id/read')
  @RequirePermissions('messages.read')
  async markRead(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.member(ctx, id);
    await this.prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: ctx.userId } }, data: { lastReadAt: new Date() } });
    return { ok: true };
  }

  /** Сумма непрочитанных по всем чатам — для значка в меню. */
  @Get('unread')
  @RequirePermissions('messages.read')
  async unread(@Ctx() ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM "ChatMessage" m
      JOIN "ConversationMember" cm ON cm."conversationId" = m."conversationId" AND cm."userId" = ${ctx.userId}
      WHERE m."deletedAt" IS NULL AND m."senderId" <> ${ctx.userId} AND m."createdAt" > cm."lastReadAt"`;
    return { unread: Number(rows[0]?.n ?? 0) };
  }
}
