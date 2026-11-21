import {
  Body,
  Controller,
  Get,
  Headers,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { Ctx, Public, RequestContext, RequirePermissions } from '../common/context';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActivityDto,
  LeadCreateDto,
  LeadQueryDto,
  LeadUpdateDto,
  MergeDto,
  MoveStageDto,
  SiteLeadDto,
} from './leads.dto';
import { LeadsService } from './leads.service';

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(private leads: LeadsService) {}

  @Get()
  @RequirePermissions('leads.read')
  list(@Ctx() ctx: RequestContext, @Query() q: LeadQueryDto) {
    return this.leads.list(ctx, q);
  }

  @Get('duplicates')
  @RequirePermissions('leads.read')
  duplicates(@Ctx() ctx: RequestContext, @Query('phone') phone?: string, @Query('email') email?: string) {
    return this.leads.duplicates(ctx, phone, email);
  }

  @Get(':id')
  @RequirePermissions('leads.read')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.get(ctx, id);
  }

  @Post()
  @RequirePermissions('leads.create')
  create(@Ctx() ctx: RequestContext, @Body() dto: LeadCreateDto) {
    return this.leads.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('leads.update')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: LeadUpdateDto) {
    return this.leads.update(ctx, id, dto);
  }

  @Post(':id/stage')
  @RequirePermissions('leads.update')
  move(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: MoveStageDto) {
    return this.leads.moveStage(ctx, id, dto.stageId, dto.lostReason);
  }

  @Post(':id/activities')
  @RequirePermissions('leads.update')
  activity(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: ActivityDto) {
    return this.leads.addActivity(ctx, id, dto.type, dto.text);
  }

  @Post(':id/merge')
  @RequirePermissions('leads.update')
  merge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: MergeDto) {
    return this.leads.merge(ctx, id, dto.sourceId);
  }

  @Post(':id/convert')
  @RequirePermissions('leads.update', 'students.create')
  convert(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.convert(ctx, id);
  }
}

// ───────────── Этапы воронки (настраиваются) ─────────────

class StageDto {
  @IsString() name: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsInt() sort?: number;
}

@ApiTags('pipeline')
@ApiBearerAuth()
@Controller('pipeline/stages')
export class StagesController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @RequirePermissions('leads.read')
  list() {
    return this.prisma.pipelineStage.findMany({ orderBy: { sort: 'asc' } });
  }

  @Post()
  @RequirePermissions('roles.update')
  async create(@Body() dto: StageDto) {
    const max = await this.prisma.pipelineStage.aggregate({ _max: { sort: true } });
    return this.prisma.pipelineStage.create({
      data: {
        name: dto.name,
        color: dto.color,
        sort: dto.sort ?? (max._max.sort ?? 0) + 10,
        code: `custom_${Date.now()}`,
      },
    });
  }

  @Patch(':id')
  @RequirePermissions('roles.update')
  async update(@Param('id') id: string, @Body() dto: StageDto) {
    if (!(await this.prisma.pipelineStage.findUnique({ where: { id } }))) throw new NotFoundException();
    return this.prisma.pipelineStage.update({ where: { id }, data: dto });
  }
}

// ───────────── Входящие заявки (webhook сайта) ─────────────

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private leads: LeadsService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  /** Создание лида из формы на сайте с UTM-метками (ТЗ 5, MVP). */
  @Public()
  @Post('site-lead')
  @ApiHeader({ name: 'X-Webhook-Token', required: true })
  async siteLead(@Headers('x-webhook-token') token: string | undefined, @Body() dto: SiteLeadDto) {
    const expected = this.config.get<string>('WEBHOOK_TOKEN') ?? '';
    const a = Buffer.from(token ?? '');
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();

    const [firstName, ...rest] = dto.name.trim().split(/\s+/);
    const lead = await this.leads.create(null, {
      firstName,
      lastName: rest.join(' ') || undefined,
      phone: dto.phone,
      email: dto.email,
      branchId: dto.branchId,
      currentLevel: dto.level,
      source: dto.source ?? 'site',
      utmSource: dto.utm_source,
      utmMedium: dto.utm_medium,
      utmCampaign: dto.utm_campaign,
      utmContent: dto.utm_content,
      utmTerm: dto.utm_term,
    });
    if (dto.comment?.trim()) {
      await this.prisma.leadActivity.create({
        data: { leadId: lead.id, type: 'message', text: `Сообщение с сайта: ${dto.comment.trim()}` },
      });
    }
    return { id: lead.id };
  }
}

@Module({
  providers: [LeadsService],
  controllers: [LeadsController, StagesController, WebhooksController],
  exports: [LeadsService],
})
export class LeadsModule {}
